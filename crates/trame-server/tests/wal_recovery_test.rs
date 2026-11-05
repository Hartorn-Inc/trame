//! ============================================================================
//! WAL RECOVERY, ROLLBACK, QUARANTINE & ACTOR SUPERVISION SUITE (wal_recovery_test.rs)
//! ============================================================================
//!
//! PURPOSE:
//!   Proves ADR-0040 (D4) at the room seam (`RoomLeaseManager` + `TableRoomActor`,
//!   the actor the WebSocket handler feeds) and over a real WebSocket: undo and
//!   batches survive a crash, MCP staging replays, a failed WAL append rolls
//!   back and rejects, a failed write-behind snapshot is non-fatal, a poisoned
//!   entry is quarantined instead of locking the campaign, every rejection
//!   carries the client's correlation id, and a dead actor is replaced.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - A "crash" is a second `RoomLeaseManager` waking the campaign from the same
//!     storage while the first actor never flushed: exactly what a restarted
//!     process sees.
//!   - `FaultyWal` wraps `InMemoryWalStorage` and fails appends or snapshots on
//!     demand; replay failures come from poisoned entries written straight into
//!     storage.
//!   - Cases are `(case_id, input, expected)` tables.
//! ============================================================================

use axum::Router;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use trame_engine::commands::{
    CampaignRole, CommandActor, McpStagingProposal, TableState, TokenState, TrameCommand,
};
use trame_engine::geometry::Point2D;
use trame_engine::rules::DamageAffinity;
use trame_server::archive::InMemoryCampaignStore;
use trame_server::assets::store::InMemoryAssetStore;
use trame_server::auth::accounts::{AccountStore, InstanceRole};
use trame_server::auth::magic_link::MagicLinkService;
use trame_server::auth::session::{
    AuthState, IdentityStore, InMemorySessionStore, SessionStore, UserRecord, hash_session_token,
};
use trame_server::auth::totp::TotpService;
use trame_server::config::{DEV_HMAC_SECRET, ServerSecrets};
use trame_server::http::{
    AppState, InMemoryBlobStore, InMemoryMembershipValidator, build_router_with_state,
};
use trame_server::maps::InMemoryMapStorage;
use trame_server::room::{ConnectedClient, OutboundClientFrame, RoomLeaseManager, TableRoomHandle};
use trame_server::security::SecurityPolicy;
use trame_server::sync::{ClientEnvelope, CommandSubmission, ServerEnvelope};
use trame_server::timeline::InMemoryTimelineStorage;
use trame_server::wal::{
    InMemoryWalStorage, QuarantinedWalEntry, StoredWalRow, TableStateSnapshot,
    UNDECODABLE_COMMAND_KIND, WalEntry, WalError, WalRecord, WalStorage,
};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Fault-injecting WalStorage double
// ---------------------------------------------------------------------------

#[derive(Default)]
struct FaultyWal {
    inner: InMemoryWalStorage,
    fail_append: AtomicBool,
    /// Stores the entry, then reports failure: an append whose commit outcome was lost.
    ghost_append: AtomicBool,
    /// Blocks the append for `STALL`, like a database that stopped answering.
    stall_append: AtomicBool,
    fail_discard: AtomicBool,
    fail_snapshot: AtomicBool,
}

const STALL: Duration = Duration::from_millis(1500);

impl FaultyWal {
    fn injected(what: &str) -> WalError {
        WalError::Serialization(format!("injected {what} failure"))
    }
}

impl WalStorage for FaultyWal {
    fn append_entry(&self, entry: WalEntry) -> Result<(), WalError> {
        if self.fail_append.load(Ordering::SeqCst) {
            return Err(Self::injected("append"));
        }
        if self.stall_append.load(Ordering::SeqCst) {
            std::thread::sleep(STALL);
        }
        if self.ghost_append.load(Ordering::SeqCst) {
            self.inner.append_entry(entry)?;
            return Err(Self::injected("append acknowledgement"));
        }
        self.inner.append_entry(entry)
    }
    fn discard_entries_from(&self, id: Uuid, from: u64) -> Result<(), WalError> {
        if self.fail_discard.load(Ordering::SeqCst) {
            return Err(Self::injected("discard"));
        }
        self.inner.discard_entries_from(id, from)
    }
    fn save_snapshot(&self, snapshot: TableStateSnapshot) -> Result<(), WalError> {
        if self.fail_snapshot.load(Ordering::SeqCst) {
            return Err(Self::injected("snapshot"));
        }
        self.inner.save_snapshot(snapshot)
    }
    fn load_latest_snapshot(&self, id: Uuid) -> Result<Option<TableStateSnapshot>, WalError> {
        self.inner.load_latest_snapshot(id)
    }
    fn load_entries_after(&self, id: Uuid, after: u64) -> Result<Vec<StoredWalRow>, WalError> {
        self.inner.load_entries_after(id, after)
    }
    fn quarantine_entries(
        &self,
        id: Uuid,
        from: u64,
        entries: Vec<QuarantinedWalEntry>,
    ) -> Result<(), WalError> {
        self.inner.quarantine_entries(id, from, entries)
    }
    fn list_quarantined_entries(&self, id: Uuid) -> Result<Vec<QuarantinedWalEntry>, WalError> {
        self.inner.list_quarantined_entries(id)
    }
}

// ---------------------------------------------------------------------------
// Room seam helpers
// ---------------------------------------------------------------------------

const MAX_HP: i32 = 20;

struct Campaign {
    wal: Arc<FaultyWal>,
    id: Uuid,
    token: Uuid,
    gm: Uuid,
}

impl Campaign {
    /// Seeds a snapshot at `seq 0` holding one 20 HP token.
    fn seed() -> Self {
        let wal = Arc::new(FaultyWal::default());
        let id = Uuid::new_v4();
        let token = Uuid::new_v4();
        let mut state = TableState::new(100.0, 5.0, Vec::new());
        let mut t = TokenState::new_default(token, "Goblin", Point2D::new(0.0, 0.0));
        t.hp = MAX_HP;
        t.max_hp = MAX_HP;
        state.data.tokens.insert(token, t);
        wal.inner
            .save_snapshot(TableStateSnapshot::capture(id, 0, 0, &state))
            .unwrap();
        Self {
            wal,
            id,
            token,
            gm: Uuid::new_v4(),
        }
    }

    /// Wakes the campaign in a fresh "process" (new lease manager, same storage).
    async fn boot(&self, snapshot_interval: u64) -> TableRoomHandle {
        RoomLeaseManager::new(self.wal.clone(), snapshot_interval, 900_000)
            .get_or_wake_room(self.id)
            .await
            .unwrap()
    }

    fn gm_actor(&self) -> CommandActor {
        CommandActor {
            user_id: self.gm,
            role: CampaignRole::Gm,
        }
    }

    fn damage(&self, raw_damage: i32) -> TrameCommand {
        damage(self.token, raw_damage)
    }

    fn entry(&self, seq_id: u64, command: TrameCommand) -> WalEntry {
        WalEntry {
            seq_id,
            campaign_id: self.id,
            timestamp_ms: 0,
            actor_user_id: self.gm,
            role: CampaignRole::Gm,
            command: command.into(),
            events: Vec::new(),
        }
    }

    async fn hp(room: &TableRoomHandle, token: Uuid) -> i32 {
        room.get_table_snapshot().await.unwrap().1.data.tokens[&token].hp
    }
}

fn damage(token_id: Uuid, raw_damage: i32) -> TrameCommand {
    TrameCommand::ApplyDamage {
        token_id,
        raw_damage,
        affinity: DamageAffinity::Normal,
        is_critical: false,
        damage_type: None,
    }
}

async fn connect(
    room: &TableRoomHandle,
    user_id: Uuid,
    role: CampaignRole,
) -> (Uuid, mpsc::UnboundedReceiver<OutboundClientFrame>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let session_id = Uuid::new_v4();
    room.connect_client(ConnectedClient {
        session_id,
        user_id,
        role,
        tx,
    })
    .await
    .unwrap();
    (session_id, rx)
}

fn drain(rx: &mut mpsc::UnboundedReceiver<OutboundClientFrame>) -> Vec<ServerEnvelope> {
    let mut out = Vec::new();
    while let Ok(frame) = rx.try_recv() {
        if let OutboundClientFrame::Binary(bytes) = frame {
            out.push(rmp_serde::from_slice(&bytes).unwrap());
        }
    }
    out
}

fn submit(command: TrameCommand, correlation_id: &str) -> ClientEnvelope {
    ClientEnvelope::SubmitCommand(Box::new(CommandSubmission {
        command,
        correlation_id: Some(correlation_id.to_string()),
    }))
}

fn rejection(frames: &[ServerEnvelope]) -> Option<(String, Option<String>)> {
    frames.iter().find_map(|f| match f {
        ServerEnvelope::CommandRejected {
            reason,
            correlation_id,
        } => Some((reason.clone(), correlation_id.clone())),
        _ => None,
    })
}

fn accepted(frames: &[ServerEnvelope]) -> bool {
    frames
        .iter()
        .any(|f| matches!(f, ServerEnvelope::CommandAccepted { .. }))
}

// ---------------------------------------------------------------------------
// RT3: undo, batches, and staging survive a crash
// ---------------------------------------------------------------------------

#[tokio::test]
async fn damage_undo_crash_reopens_at_snapshot() {
    // (case_id, snapshot_interval)
    let cases = [
        ("snapshot_between_damage_and_undo", 1u64),
        ("no_periodic_snapshot", 25),
    ];
    for (case, interval) in cases {
        let c = Campaign::seed();
        let room = c.boot(interval).await;
        room.dispatch_direct_command(c.gm_actor(), c.damage(5))
            .await
            .unwrap();
        let (seq, _) = room
            .dispatch_direct_command(c.gm_actor(), TrameCommand::UndoLastAction)
            .await
            .unwrap();
        assert_eq!(Campaign::hp(&room, c.token).await, MAX_HP, "case {case}");

        let rebooted = c.boot(interval).await;
        assert_eq!(
            Campaign::hp(&rebooted, c.token).await,
            MAX_HP,
            "case {case}"
        );
        assert_eq!(rebooted.metrics().await.unwrap().seq_id, seq, "case {case}");
        assert!(
            c.wal.list_quarantined_entries(c.id).unwrap().is_empty(),
            "case {case}: nothing quarantined"
        );
    }
}

#[tokio::test]
async fn batch_crash() {
    // (case_id, fail_snapshot, expect_accepted, expected_hp_after_crash)
    let cases = [
        ("batch_snapshot_ok_survives_crash", false, true, MAX_HP - 7),
        ("batch_snapshot_failure_rolls_back", true, false, MAX_HP),
    ];
    for (case, fail_snapshot, expect_accepted, expected_hp) in cases {
        let c = Campaign::seed();
        let room = c.boot(25).await;
        c.wal.fail_snapshot.store(fail_snapshot, Ordering::SeqCst);
        let res = room
            .dispatch_batch(
                c.gm_actor(),
                vec![c.damage(3), c.damage(4)],
                "Ambush".to_string(),
            )
            .await;
        assert_eq!(res.is_ok(), expect_accepted, "case {case}");
        assert_eq!(
            Campaign::hp(&room, c.token).await,
            expected_hp,
            "case {case}"
        );
        let expected_seq = u64::from(expect_accepted);
        assert_eq!(
            room.metrics().await.unwrap().seq_id,
            expected_seq,
            "case {case}"
        );

        c.wal.fail_snapshot.store(false, Ordering::SeqCst);
        let rebooted = c.boot(25).await;
        assert_eq!(
            Campaign::hp(&rebooted, c.token).await,
            expected_hp,
            "case {case}"
        );
    }
}

#[tokio::test]
async fn staging_crash_replays_proposal() {
    // (case_id, fail_snapshot during staging)
    let cases = [
        ("staged_without_snapshot", false),
        ("staged_while_snapshots_fail", true),
    ];
    for (case, fail_snapshot) in cases {
        let c = Campaign::seed();
        let room = c.boot(25).await;
        c.wal.fail_snapshot.store(fail_snapshot, Ordering::SeqCst);
        let proposal = McpStagingProposal {
            proposal_id: Uuid::new_v4(),
            summary: "Goblin takes 6".to_string(),
            commands: vec![c.damage(6)],
        };
        room.stage_mcp_proposal(proposal.clone())
            .await
            .unwrap_or_else(|e| panic!("case {case}: staging failed: {e}"));
        c.wal.fail_snapshot.store(false, Ordering::SeqCst);

        let rebooted = c.boot(25).await;
        let (_, gm_rx) = &mut connect(&rebooted, c.gm, CampaignRole::Gm).await;
        let Some(ServerEnvelope::StateSnapshot { state, .. }) = drain(gm_rx).into_iter().next()
        else {
            panic!("case {case}: expected StateSnapshot");
        };
        assert_eq!(
            state.mcp_staging_proposals.get(&proposal.proposal_id),
            Some(&proposal),
            "case {case}"
        );
        rebooted
            .dispatch_direct_command(
                c.gm_actor(),
                TrameCommand::CommitMcpStaging {
                    proposal_id: proposal.proposal_id,
                },
            )
            .await
            .unwrap_or_else(|e| panic!("case {case}: commit failed: {e}"));
        assert_eq!(
            Campaign::hp(&rebooted, c.token).await,
            MAX_HP - 6,
            "case {case}"
        );
    }
}

// ---------------------------------------------------------------------------
// RT5 + RT10: append rollback, non-fatal snapshot, correlation ids
// ---------------------------------------------------------------------------

#[tokio::test]
async fn append_failure_restores_state() {
    let c = Campaign::seed();
    let room = c.boot(25).await;
    let (gm_session, mut gm_rx) = connect(&room, c.gm, CampaignRole::Gm).await;
    drain(&mut gm_rx);

    c.wal.fail_append.store(true, Ordering::SeqCst);
    room.send_envelope(gm_session, submit(c.damage(5), "c-append"))
        .await
        .unwrap();
    let frames = drain(&mut gm_rx);
    assert!(
        !accepted(&frames),
        "nothing broadcast for an unsaved command"
    );
    let (reason, correlation_id) = rejection(&frames).expect("CommandRejected");
    assert_eq!(correlation_id.as_deref(), Some("c-append"));
    assert!(
        !reason.contains("injected"),
        "storage details stay server-side: {reason}"
    );
    assert_eq!(Campaign::hp(&room, c.token).await, MAX_HP);
    assert_eq!(room.metrics().await.unwrap().seq_id, 0);

    c.wal.fail_append.store(false, Ordering::SeqCst);
    room.send_envelope(gm_session, submit(c.damage(2), "c-ok"))
        .await
        .unwrap();
    let frames = drain(&mut gm_rx);
    assert!(
        frames
            .iter()
            .any(|f| matches!(f, ServerEnvelope::CommandAccepted { seq_id: 1, .. }))
    );
    let rebooted = c.boot(25).await;
    assert_eq!(Campaign::hp(&rebooted, c.token).await, MAX_HP - 2);
}

#[tokio::test]
async fn snapshot_failure_is_non_fatal_except_for_undo() {
    // (case_id, follow-up is an undo (else 1 more damage), expect accepted, hp after crash)
    let cases = [
        (
            "periodic_snapshot_failure_still_commits",
            false,
            true,
            MAX_HP - 6,
        ),
        ("undo_snapshot_failure_rolls_back", true, false, MAX_HP - 5),
    ];
    for (case, undo, expect_accepted, expected_hp) in cases {
        let c = Campaign::seed();
        let room = c.boot(1).await;
        let (gm_session, mut gm_rx) = connect(&room, c.gm, CampaignRole::Gm).await;
        c.wal.fail_snapshot.store(true, Ordering::SeqCst);
        room.send_envelope(gm_session, submit(c.damage(5), "c-first"))
            .await
            .unwrap();
        drain(&mut gm_rx);
        let follow_up = if undo {
            TrameCommand::UndoLastAction
        } else {
            c.damage(1)
        };
        room.send_envelope(gm_session, submit(follow_up, "c-follow"))
            .await
            .unwrap();
        let frames = drain(&mut gm_rx);
        assert_eq!(accepted(&frames), expect_accepted, "case {case}");
        if !expect_accepted {
            assert_eq!(
                rejection(&frames).and_then(|r| r.1).as_deref(),
                Some("c-follow"),
                "case {case}"
            );
        }
        assert_eq!(
            Campaign::hp(&room, c.token).await,
            expected_hp,
            "case {case}"
        );

        c.wal.fail_snapshot.store(false, Ordering::SeqCst);
        let rebooted = c.boot(1).await;
        assert_eq!(
            Campaign::hp(&rebooted, c.token).await,
            expected_hp,
            "case {case}"
        );
    }
}

#[tokio::test]
async fn gm_initiative_rolls_fan_out_only_after_commit() {
    // (case_id, WAL append fails, rolls broadcast)
    let cases = [
        ("committed_start_broadcasts_rolls", false, true),
        ("unsaved_start_leaks_no_roll", true, false),
    ];
    for (case, fail_append, broadcast) in cases {
        let c = Campaign::seed();
        let room = c.boot(25).await;
        let (gm_session, mut gm_rx) = connect(&room, c.gm, CampaignRole::Gm).await;
        drain(&mut gm_rx);
        c.wal.fail_append.store(fail_append, Ordering::SeqCst);
        let start = TrameCommand::StartTurnByTurn {
            initiative_order: Vec::new(),
            initiative_totals: Default::default(),
        };
        room.send_envelope(gm_session, submit(start, "c-start"))
            .await
            .unwrap();
        let frames = drain(&mut gm_rx);
        let rolled = frames.iter().any(
            |f| matches!(f, ServerEnvelope::DiceRolled(r) if r.reason == "Initiative: Goblin"),
        );
        assert_eq!(rolled, broadcast, "case {case}");
        assert_eq!(accepted(&frames), broadcast, "case {case}");
        assert_eq!(rejection(&frames).is_some(), !broadcast, "case {case}");
    }
}

#[tokio::test]
async fn every_rejection_carries_the_correlation_id() {
    let c = Campaign::seed();
    let room = c.boot(25).await;
    let player = Uuid::new_v4();
    let (player_session, mut player_rx) = connect(&room, player, CampaignRole::Player).await;
    drain(&mut player_rx);

    // (case_id, envelope, expected correlation id)
    let cases: Vec<(&str, ClientEnvelope, Option<&str>)> = vec![
        (
            "rbac_rejection",
            submit(c.damage(1), "c-rbac"),
            Some("c-rbac"),
        ),
        (
            "engine_rejection",
            submit(TrameCommand::UndoLastAction, "c-engine"),
            Some("c-engine"),
        ),
        (
            "dice_rejection",
            ClientEnvelope::RollDice {
                expression: "not dice".to_string(),
                visibility: trame_server::dice::RollVisibility::Public,
                reason: "Attack".to_string(),
                correlation_id: Some("c-dice".to_string()),
            },
            Some("c-dice"),
        ),
        (
            "legacy_client_without_id",
            ClientEnvelope::SubmitCommand(Box::new(c.damage(1).into())),
            None,
        ),
    ];
    for (case, envelope, expected) in cases {
        room.send_envelope(player_session, envelope).await.unwrap();
        let frames = drain(&mut player_rx);
        let (_, correlation_id) =
            rejection(&frames).unwrap_or_else(|| panic!("case {case}: expected rejection"));
        assert_eq!(correlation_id.as_deref(), expected, "case {case}");
    }
}

// ---------------------------------------------------------------------------
// D4: poisoned entries are quarantined
// ---------------------------------------------------------------------------

#[tokio::test]
async fn poisoned_entry_quarantined() {
    let missing = Uuid::new_v4();
    // (case_id, WAL tail after the seq-0 snapshot, expected hp, expected quarantined seqs)
    type Tail = fn(&Campaign, Uuid) -> Vec<WalEntry>;
    let cases: [(&str, Tail, i32, Vec<u64>); 3] = [
        (
            "poisoned_middle_entry_and_tail",
            |c, missing| {
                vec![
                    c.entry(1, c.damage(2)),
                    c.entry(2, damage(missing, 3)),
                    c.entry(3, c.damage(4)),
                ]
            },
            MAX_HP - 2,
            vec![2, 3],
        ),
        (
            "legacy_undo_after_snapshot",
            |c, _| vec![c.entry(1, TrameCommand::UndoLastAction)],
            MAX_HP,
            vec![1],
        ),
        (
            "clean_tail_replays",
            |c, _| vec![c.entry(1, c.damage(2)), c.entry(2, c.damage(3))],
            MAX_HP - 5,
            vec![],
        ),
    ];
    for (case, tail, expected_hp, expected_seqs) in cases {
        let c = Campaign::seed();
        let entries = tail(&c, missing);
        let last_seq = entries.last().map_or(0, |e| e.seq_id);
        for entry in entries {
            c.wal.inner.append_entry(entry).unwrap();
        }

        let room = c.boot(25).await;
        assert_eq!(
            Campaign::hp(&room, c.token).await,
            expected_hp,
            "case {case}"
        );
        assert_eq!(
            room.metrics().await.unwrap().seq_id,
            last_seq,
            "case {case}"
        );

        let quarantined = c.wal.list_quarantined_entries(c.id).unwrap();
        let seqs: Vec<u64> = quarantined.iter().map(|q| q.seq_id).collect();
        assert_eq!(seqs, expected_seqs, "case {case}");
        let remaining: Vec<u64> = c
            .wal
            .load_entries_after(c.id, 0)
            .unwrap()
            .iter()
            .map(|e| e.seq_id)
            .collect();
        assert!(
            remaining.iter().all(|s| !expected_seqs.contains(s)),
            "case {case}: quarantined entries left the WAL"
        );

        let (_, mut gm_rx) = connect(&room, c.gm, CampaignRole::Gm).await;
        let (_, mut player_rx) = connect(&room, Uuid::new_v4(), CampaignRole::Player).await;
        let notice = |frames: Vec<ServerEnvelope>| {
            frames.into_iter().find_map(|f| match f {
                ServerEnvelope::WalEntriesQuarantined { entries } => Some(entries),
                _ => None,
            })
        };
        let gm_notice = notice(drain(&mut gm_rx));
        assert!(
            notice(drain(&mut player_rx)).is_none(),
            "case {case}: GM only"
        );
        assert_eq!(
            gm_notice.map(|n| n.iter().map(|e| e.seq_id).collect::<Vec<_>>()),
            (!expected_seqs.is_empty()).then(|| expected_seqs.clone()),
            "case {case}"
        );

        let (next_seq, _) = room
            .dispatch_direct_command(c.gm_actor(), c.damage(1))
            .await
            .unwrap();
        assert_eq!(
            next_seq,
            last_seq + 1,
            "case {case}: sequence never repeats"
        );

        let rebooted = c.boot(25).await;
        assert_eq!(
            Campaign::hp(&rebooted, c.token).await,
            expected_hp - 1,
            "case {case}"
        );
        assert_eq!(
            c.wal.list_quarantined_entries(c.id).unwrap().len(),
            expected_seqs.len(),
            "case {case}: quarantined entries are never replayed or re-quarantined"
        );
    }
}

#[tokio::test]
async fn quarantine_payload_keeps_the_original_entry() {
    let c = Campaign::seed();
    c.wal
        .inner
        .append_entry(c.entry(1, TrameCommand::UndoLastAction))
        .unwrap();
    c.boot(25).await;
    let quarantined = c.wal.list_quarantined_entries(c.id).unwrap();
    let [entry] = quarantined.as_slice() else {
        panic!("expected one quarantined entry, got {quarantined:?}");
    };
    assert_eq!(entry.command_kind, "UNDO_LAST_ACTION");
    assert!(!entry.error.is_empty());
    let original: WalEntry = serde_json::from_value(entry.payload.clone()).unwrap();
    assert!(
        matches!(&original.command, WalRecord::Command(cmd) if matches!(**cmd, TrameCommand::UndoLastAction))
    );
}

#[tokio::test]
async fn undecodable_rows_are_quarantined_and_the_room_opens() {
    // (case_id, raw payload planted at seq 2 between two healthy damage entries)
    let cases = [
        (
            "payload_not_a_wal_entry",
            serde_json::json!({ "garbage": true }),
        ),
        ("payload_is_a_string", serde_json::json!("corrupted")),
        (
            "unknown_command_variant",
            serde_json::json!({
                "seq_id": 2, "campaign_id": Uuid::nil(), "timestamp_ms": 0,
                "actor_user_id": Uuid::nil(), "role": "GM",
                "command": { "type": "FROM_THE_FUTURE" }, "events": []
            }),
        ),
    ];
    for (case, payload) in cases {
        let c = Campaign::seed();
        c.wal.inner.append_entry(c.entry(1, c.damage(2))).unwrap();
        c.wal
            .inner
            .append_raw_row(
                c.id,
                StoredWalRow {
                    seq_id: 2,
                    payload: payload.clone(),
                },
            )
            .unwrap();
        c.wal.inner.append_entry(c.entry(3, c.damage(4))).unwrap();

        let room = c.boot(25).await;
        assert_eq!(Campaign::hp(&room, c.token).await, MAX_HP - 2, "case {case}");
        assert_eq!(room.metrics().await.unwrap().seq_id, 3, "case {case}");
        let quarantined = c.wal.list_quarantined_entries(c.id).unwrap();
        let seqs: Vec<u64> = quarantined.iter().map(|q| q.seq_id).collect();
        assert_eq!(seqs, vec![2, 3], "case {case}");
        assert_eq!(
            quarantined[0].command_kind, UNDECODABLE_COMMAND_KIND,
            "case {case}"
        );
        assert_eq!(quarantined[0].payload, payload, "case {case}: raw payload kept");
        let (next_seq, _) = room
            .dispatch_direct_command(c.gm_actor(), c.damage(1))
            .await
            .unwrap_or_else(|e| panic!("case {case}: room stays writable: {e}"));
        assert_eq!(next_seq, 4, "case {case}");
    }
}

// ---------------------------------------------------------------------------
// Ambiguous appends: no ghost row survives a rejected command
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ambiguous_append_leaves_no_ghost_row() {
    // (case_id, compensation fails too, actor keeps running)
    let cases = [
        ("compensation_deletes_ghost_row", false, true),
        ("failed_compensation_halts_actor", true, false),
    ];
    for (case, fail_discard, keeps_running) in cases {
        let c = Campaign::seed();
        let room = c.boot(25).await;
        let (gm_session, mut gm_rx) = connect(&room, c.gm, CampaignRole::Gm).await;
        drain(&mut gm_rx);
        c.wal.ghost_append.store(true, Ordering::SeqCst);
        c.wal.fail_discard.store(fail_discard, Ordering::SeqCst);

        room.send_envelope(gm_session, submit(c.damage(5), "c-ghost"))
            .await
            .unwrap();
        let mut frames = Vec::new();
        let mut close_code = None;
        while let Ok(frame) = gm_rx.try_recv() {
            match frame {
                OutboundClientFrame::Binary(bytes) => {
                    frames.push(rmp_serde::from_slice(&bytes).unwrap());
                }
                OutboundClientFrame::Close { code, .. } => close_code = Some(code),
            }
        }
        assert!(!accepted(&frames), "case {case}");
        assert_eq!(
            rejection(&frames).and_then(|r| r.1).as_deref(),
            Some("c-ghost"),
            "case {case}"
        );
        c.wal.ghost_append.store(false, Ordering::SeqCst);
        c.wal.fail_discard.store(false, Ordering::SeqCst);

        if keeps_running {
            assert_eq!(close_code, None, "case {case}");
            assert!(
                c.wal.load_entries_after(c.id, 0).unwrap().is_empty(),
                "case {case}: no entry above the room's seq"
            );
            let (seq, _) = room
                .dispatch_direct_command(c.gm_actor(), c.damage(2))
                .await
                .unwrap();
            assert_eq!(seq, 1, "case {case}: seq 1 reused by the next command");
            let rebooted = c.boot(25).await;
            assert_eq!(
                Campaign::hp(&rebooted, c.token).await,
                MAX_HP - 2,
                "case {case}: the rejected command is never replayed"
            );
        } else {
            assert_eq!(close_code, Some(1011), "case {case}");
            assert!(room.metrics().await.is_err(), "case {case}: actor stopped");
        }
    }
}

// ---------------------------------------------------------------------------
// Player initiative rolls never outlive a TurnByTurn transition
// ---------------------------------------------------------------------------

#[tokio::test]
async fn player_initiative_cleared_on_turn_by_turn_transitions() {
    #[derive(Clone, Copy)]
    enum Step {
        PlayerRolls,
        StartWithExplicitOrder,
        End,
    }
    use Step::*;
    // (case_id, steps before the final player roll, final roll accepted)
    let cases: [(&str, Vec<Step>, bool); 3] = [
        ("no_transition_keeps_roll", vec![PlayerRolls], false),
        (
            "explicit_order_start_clears",
            vec![PlayerRolls, StartWithExplicitOrder],
            true,
        ),
        (
            "end_of_encounter_clears",
            vec![StartWithExplicitOrder, PlayerRolls, End],
            true,
        ),
    ];
    for (case, steps, expect_roll) in cases {
        let c = Campaign::seed();
        let player = Uuid::new_v4();
        let hero = Uuid::new_v4();
        let mut state = TableState::new(100.0, 5.0, Vec::new());
        let goblin = TokenState::new_default(c.token, "Goblin", Point2D::new(0.0, 0.0));
        let mut hero_token = TokenState::new_default(hero, "Hero", Point2D::new(10.0, 0.0));
        hero_token.owner_user_id = Some(player);
        state.data.tokens.insert(c.token, goblin);
        state.data.tokens.insert(hero, hero_token);
        c.wal
            .inner
            .save_snapshot(TableStateSnapshot::capture(c.id, 0, 0, &state))
            .unwrap();
        let room = c.boot(25).await;
        let (player_session, mut player_rx) = connect(&room, player, CampaignRole::Player).await;
        let roll = || ClientEnvelope::RollDice {
            expression: "1d20".to_string(),
            visibility: trame_server::dice::RollVisibility::Public,
            reason: "Initiative".to_string(),
            correlation_id: Some("c-init".to_string()),
        };
        for step in steps {
            match step {
                PlayerRolls => room.send_envelope(player_session, roll()).await.unwrap(),
                StartWithExplicitOrder => {
                    room.dispatch_direct_command(
                        c.gm_actor(),
                        TrameCommand::StartTurnByTurn {
                            initiative_order: vec![c.token],
                            initiative_totals: Default::default(),
                        },
                    )
                    .await
                    .unwrap();
                }
                End => {
                    room.dispatch_direct_command(c.gm_actor(), TrameCommand::EndTurnByTurn)
                        .await
                        .unwrap();
                }
            }
        }
        drain(&mut player_rx);
        room.send_envelope(player_session, roll()).await.unwrap();
        let frames = drain(&mut player_rx);
        let rolled = frames.iter().any(
            |f| matches!(f, ServerEnvelope::DiceRolled(r) if r.reason == "Initiative: Hero"),
        );
        assert_eq!(rolled, expect_roll, "case {case}");
        assert_eq!(rejection(&frames).is_some(), !expect_roll, "case {case}");
    }
}

// ---------------------------------------------------------------------------
// RT9: a dead actor is replaced
// ---------------------------------------------------------------------------

#[tokio::test]
async fn dead_actor_handle_is_replaced_on_next_wake() {
    let c = Campaign::seed();
    let mgr = RoomLeaseManager::new(c.wal.clone(), 25, 900_000);
    let room = mgr.get_or_wake_room(c.id).await.unwrap();
    room.dispatch_direct_command(c.gm_actor(), c.damage(3))
        .await
        .unwrap();
    // Ending the actor behind the manager's back leaves its handle registered.
    room.hibernate().await.unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while mgr.active_room_count().await != 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "dead handle never removed"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let fresh = mgr.get_or_wake_room(c.id).await.unwrap();
    assert_eq!(fresh.metrics().await.unwrap().seq_id, 1);
    assert_eq!(Campaign::hp(&fresh, c.token).await, MAX_HP - 3);
}

// ---------------------------------------------------------------------------
// RT10 over a real WebSocket: wire shape of correlation ids
// ---------------------------------------------------------------------------

async fn serve(app: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

async fn ws_open(addr: SocketAddr, path: &str, cookie: &str) -> TcpStream {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Cookie: {cookie}\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.unwrap();
        head.push(byte[0]);
    }
    assert!(String::from_utf8_lossy(&head).contains(" 101 "));
    stream
}

async fn ws_read(stream: &mut TcpStream) -> ServerEnvelope {
    let (_, payload) = ws_read_frame(stream).await;
    rmp_serde::from_slice(&payload).unwrap()
}

/// Reads frames until a Close frame and returns its status code.
async fn ws_read_close_code(stream: &mut TcpStream) -> u16 {
    loop {
        let (opcode, payload) = ws_read_frame(stream).await;
        if opcode == 0x8 {
            return u16::from_be_bytes([payload[0], payload[1]]);
        }
    }
}

/// Reads one unmasked server frame and returns `(opcode, payload)`.
async fn ws_read_frame(stream: &mut TcpStream) -> (u8, Vec<u8>) {
    let mut hdr = [0u8; 2];
    stream.read_exact(&mut hdr).await.unwrap();
    let len = match hdr[1] & 0x7f {
        126 => {
            let mut ext = [0u8; 2];
            stream.read_exact(&mut ext).await.unwrap();
            u16::from_be_bytes(ext) as usize
        }
        127 => {
            let mut ext = [0u8; 8];
            stream.read_exact(&mut ext).await.unwrap();
            u64::from_be_bytes(ext) as usize
        }
        n => n as usize,
    };
    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload).await.unwrap();
    (hdr[0] & 0x0f, payload)
}

/// Writes one masked binary frame (zero mask key, so the payload is sent as is).
async fn ws_write(stream: &mut TcpStream, payload: &[u8]) {
    let mut frame = vec![0x82u8, 0x80 | 127];
    frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    frame.extend_from_slice(&[0, 0, 0, 0]);
    frame.extend_from_slice(payload);
    stream.write_all(&frame).await.unwrap();
}

#[tokio::test]
async fn websocket_rejections_echo_the_wire_correlation_id() {
    let wal = Arc::new(InMemoryWalStorage::new());
    let campaign_id = Uuid::new_v4();
    wal.save_snapshot(TableStateSnapshot::capture(
        campaign_id,
        0,
        0,
        &TableState::new(100.0, 5.0, Vec::new()),
    ))
    .unwrap();
    let state = app_state(wal);
    let (user_id, cookie) = session(&state).await;
    state
        .auth_state
        .session_store
        .assign_campaign_member(campaign_id, user_id, None, "PLAYER")
        .await
        .unwrap();
    let addr = serve(build_router_with_state(state)).await;
    let mut ws = ws_open(addr, &format!("/ws/campaigns/{campaign_id}"), &cookie).await;
    assert!(matches!(
        ws_read(&mut ws).await,
        ServerEnvelope::StateSnapshot { .. }
    ));

    // (case_id, raw frame, expected correlation id)
    let tagged = rmp_serde::to_vec_named(&serde_json::json!({
        "SubmitCommand": { "cmd": "UNDO_LAST_ACTION", "correlation_id": "wire-1" }
    }))
    .unwrap();
    let cases: Vec<(&str, Vec<u8>, Option<&str>)> = vec![
        ("tagged_submit", tagged, Some("wire-1")),
        ("malformed_frame", vec![0xc1, 0x00, 0xff], None),
    ];
    for (case, frame, expected) in cases {
        ws_write(&mut ws, &frame).await;
        let ServerEnvelope::CommandRejected { correlation_id, .. } = ws_read(&mut ws).await else {
            panic!("case {case}: expected CommandRejected");
        };
        assert_eq!(correlation_id.as_deref(), expected, "case {case}");
    }
}

// ---------------------------------------------------------------------------
// Stalled actors and late membership removal over a real WebSocket
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stalled_room_actor_closes_sockets_with_1011() {
    // (case_id, a second socket attaches while the actor is stalled (else the first one's
    // frame is what waits))
    let cases = [
        ("frame_to_stalled_actor", false),
        ("attach_to_stalled_actor", true),
    ];
    for (case, attach) in cases {
        let c = Campaign::seed();
        let policy = SecurityPolicy {
            ws_room_call_timeout: Duration::from_millis(200),
            ..SecurityPolicy::default()
        };
        let state = app_state_with(c.wal.clone(), policy);
        let (user_id, cookie) = session(&state).await;
        state
            .auth_state
            .session_store
            .assign_campaign_member(c.id, user_id, None, "GM")
            .await
            .unwrap();
        let addr = serve(build_router_with_state(state)).await;
        let path = format!("/ws/campaigns/{}", c.id);
        let mut ws = ws_open(addr, &path, &cookie).await;
        assert!(
            matches!(ws_read(&mut ws).await, ServerEnvelope::StateSnapshot { .. }),
            "case {case}"
        );

        c.wal.stall_append.store(true, Ordering::SeqCst);
        let frame = rmp_serde::to_vec_named(&submit(c.damage(1), "c-stall")).unwrap();
        ws_write(&mut ws, &frame).await;
        let mut target = if attach {
            tokio::time::sleep(Duration::from_millis(50)).await;
            ws_open(addr, &path, &cookie).await
        } else {
            ws
        };
        let code = tokio::time::timeout(Duration::from_secs(1), ws_read_close_code(&mut target))
            .await
            .unwrap_or_else(|_| panic!("case {case}: socket left hanging"));
        assert_eq!(code, 1011, "case {case}");
        c.wal.stall_append.store(false, Ordering::SeqCst);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn membership_removed_during_attach_closes_4403() {
    // (case_id, membership removed while the attach is still queued)
    let cases = [
        ("removed_mid_attach_closes_4403", true),
        ("still_member_stays_attached", false),
    ];
    for (case, remove) in cases {
        let c = Campaign::seed();
        let state = app_state_with(c.wal.clone(), SecurityPolicy::default());
        let (user_id, cookie) = session(&state).await;
        let store = state.auth_state.session_store.clone();
        store
            .assign_campaign_member(c.id, user_id, None, "PLAYER")
            .await
            .unwrap();
        let room = state.lease_manager.get_or_wake_room(c.id).await.unwrap();
        let addr = serve(build_router_with_state(state)).await;

        // Keeps the actor busy so the socket's attach waits in the mailbox.
        c.wal.stall_append.store(true, Ordering::SeqCst);
        let busy = tokio::spawn({
            let (room, actor, cmd) = (room.clone(), c.gm_actor(), c.damage(1));
            async move { room.dispatch_direct_command(actor, cmd).await }
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut ws = ws_open(addr, &format!("/ws/campaigns/{}", c.id), &cookie).await;
        if remove {
            assert!(store.remove_campaign_member(c.id, user_id).await.unwrap());
        }
        c.wal.stall_append.store(false, Ordering::SeqCst);
        busy.await.unwrap().unwrap();

        if remove {
            assert_eq!(ws_read_close_code(&mut ws).await, 4403, "case {case}");
        } else {
            assert!(
                matches!(ws_read(&mut ws).await, ServerEnvelope::StateSnapshot { .. }),
                "case {case}"
            );
            let ping = rmp_serde::to_vec_named(&ClientEnvelope::Ping { client_time_ms: 7 }).unwrap();
            ws_write(&mut ws, &ping).await;
            assert!(
                matches!(ws_read(&mut ws).await, ServerEnvelope::Pong { client_time_ms: 7, .. }),
                "case {case}"
            );
        }
    }
}

fn app_state(wal: Arc<InMemoryWalStorage>) -> AppState {
    app_state_with(wal, SecurityPolicy::default())
}

fn app_state_with(wal: Arc<dyn WalStorage>, policy: SecurityPolicy) -> AppState {
    AppState {
        lease_manager: Arc::new(RoomLeaseManager::new(wal, 25, 900_000)),
        asset_store: Arc::new(InMemoryAssetStore::new()),
        membership: Arc::new(InMemoryMembershipValidator::new()),
        instance_id: Uuid::new_v4(),
        timeline_storage: Arc::new(InMemoryTimelineStorage::new()),
        campaign_store: InMemoryCampaignStore::new(),
        blob_store: InMemoryBlobStore::new(),
        auth_state: AuthState::with_security(
            Arc::new(MagicLinkService::new(
                DEV_HMAC_SECRET.to_vec(),
                "trame-test",
            )),
            Arc::new(InMemorySessionStore::new()),
            Arc::new(TotpService::new(
                ServerSecrets::dev().master_encryption_key,
                "TRAME",
            )),
            Arc::new(policy),
        ),
        db_healthy: Arc::new(AtomicBool::new(true)),
        map_storage: InMemoryMapStorage::new(),
        postgres_store: None,
        campaign_data: Default::default(),
        static_dir: None,
    }
}

/// Creates an account with a live session and returns `(user_id, cookie_header)`.
async fn session(state: &AppState) -> (Uuid, String) {
    let user_id = Uuid::new_v4();
    let store = &state.auth_state.session_store;
    store
        .save_user(UserRecord {
            id: user_id,
            username: format!("user-{user_id}"),
            role: "PLAYER".to_string(),
            is_guest: false,
            created_at: 0,
            email: Some(format!("{user_id}@example.com")),
            password_hash: None,
            mfa_enabled: false,
            totp_secret: None,
            pending_totp_secret: None,
            instance_role: InstanceRole::Member,
        })
        .await
        .unwrap();
    let token = format!("wal-session-{user_id}");
    store
        .create_session(user_id, &hash_session_token(&token), 3600)
        .await
        .unwrap();
    (user_id, format!("trame_session={token}"))
}
