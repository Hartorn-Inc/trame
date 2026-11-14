//! ============================================================================
//! CAMPAIGN ROOM ACTOR & IDLE-LEASE HIBERNATION MANAGER (room.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Isolates each active campaign session into a dedicated single-owner Tokio
//! actor (`TableRoomActor`) communicating via a bounded MPSC mailbox
//! (`TableRoomHandle`), eliminating lock contention across concurrent campaigns
//! while serializing all commands, CSPRNG dice rolls, WAL appends, and per-client
//! 2.5D BVH visibility projections within a room. `RoomLeaseManager` coordinates
//! on-demand WAL wake-up, `Idle-Lease` hibernation, and SIGTERM scale-to-zero
//! graceful shutdown lifecycle handling (`04-RUNTIME-AND-DEDICATED-HOSTING.md`).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Single-Writer Actor Serialization`:
//!      - `TableState`, `seq_id`, and `SeededDiceRoller` are owned exclusively
//!        by `TableRoomActor` (zero shared mutable locks on table state),
//!        preventing race conditions between simultaneous player commands.
//!   2. `Write-Ahead Log Before Fan-Out, With Rollback (RT5)`:
//!      - On every valid `ClientEnvelope::SubmitCommand`, `TableRoomActor`
//!        clones `TableState`, applies the command, and persists the `WalEntry`
//!        *before* broadcasting `ServerEnvelope::CommandAccepted`. If the
//!        append fails, the clone and the previous `seq_id` are restored and the
//!        command is rejected, so memory never runs ahead of storage.
//!      - `UndoLastAction` and composite batches are persisted by a snapshot at
//!        the new `seq_id` instead of a `WalEntry` (the undo ring is not stored,
//!        so an undo can never be replayed; RT3). A failure there also rolls back.
//!      - The periodic write-behind snapshot (every `snapshot_interval`
//!        commands) is best effort: its failure is logged, and the command,
//!        already durable in the WAL, still commits and broadcasts.
//!      - MCP staging proposals are appended as `WalRecord::McpStaging` so they
//!        survive a crash (RT3).
//!      - Every failure path answers the sender with `CommandRejected` carrying
//!        the client's `correlation_id` (RT10); storage errors are reported with
//!        a generic reason.
//!      - An append error is ambiguous: the store may have committed the row
//!        before failing. The actor then deletes every stored entry after its
//!        current `seq_id` (`WalStorage::discard_entries_from`), so recovery can
//!        never replay a command the client was told was rejected. If that
//!        cleanup fails too, the actor closes every socket with `1011` and
//!        stops; supervision (RT9) re-wakes it from storage, whose state then
//!        becomes the truth everyone reconnects to.
//!   3. `Double-Checked Room Wake-Up`:
//!      - `RoomLeaseManager::get_or_wake_room` uses a fast read-lock path
//!        followed by a double-checked write-lock rehydration from `WalStorage`
//!        so concurrent connection bursts never spawn duplicate actors for the
//!        same `campaign_id`.
//!      - Actor supervision (RT9): a watcher removes the handle as soon as the
//!        actor task ends (hibernation, panic), and a closed handle found in the
//!        registry is replaced, so the next connection always gets a live actor.
//!   3b. `Quarantine Notice (D4)`:
//!      - When recovery quarantined WAL entries, the actor keeps their summaries
//!        and unicasts `ServerEnvelope::WalEntriesQuarantined` to every GM that
//!        connects during its lifetime. Players never receive it.
//!   4. `Zero-Data-Loss Idle-Lease Hibernation`:
//!      - `sweep_idle_rooms` evicts only rooms with `active_connections == 0`
//!        whose idle duration (`current_time_ms - last_activity_ms`) meets or
//!        exceeds `idle_timeout_ms`, flushing a final compacted snapshot before
//!        terminating the actor loop.
//!   5. `Graceful Cloud Run Shutdown & WebSocket Close Frame 1001`:
//!      - On shutdown or room hibernation, `TableRoomHandle::hibernate` sends
//!        WebSocket Close frame code `1001` ("Going Away") to all active client
//!        connections and serializes uncommitted actor state to `WalStorage`
//!        before terminating the actor task.
//!   6. `Damage Authority & Bounds (G6)`:
//!      - `authorize_command` rejects `ApplyDamage` outside `0..=MAX_RAW_DAMAGE`
//!        and, for non-GM actors, against tokens they do not control or with a
//!        non-`Normal` affinity, before the command reaches the engine or the WAL.
//!   7. `Hidden Initiative & Sheet Privacy (G5, RT7)`:
//!      - Initiative for a token some player cannot see (`CHANNEL_GM_HIDDEN`, or
//!        out of the line of sight of a token controller or a campaign player)
//!        is rolled `RollVisibility::GmOnly`: only the GM and the token's
//!        controller receive it, and its timeline record and the `initiative`
//!        order record are GM-only. Tokens whose player already rolled
//!        initiative keep that roll; `ActorUpdated` sheets go only to the GM and
//!        to the persistent actor's owning `Player` (`actor_owner_user_id`) when
//!        they control a linked token on the live table (so unspawned
//!        `ActorsTab` edits preserve REST `expected_version` `409 VERSION_CONFLICT`,
//!        while GM-owned NPC/Monster tokens assigned to players and Spectators
//!        never receive `ActorUpdated` or `statBlock`, which is stripped for
//!        non-GM recipients).
//!   8. `Server-Only Initiative (SEC3)`:
//!      - A player's initiative `RollDice` ignores the submitted expression: the
//!        server rolls `1d20 + TokenState::initiative_modifier()` for their token,
//!        once per encounter. The d20 term follows the server-derived mode
//!        (`resolution::initiative_roll_mode`: Invisible or Feral Instinct give
//!        `2d20kh1`; Incapacitated, Poisoned or Frightened give `2d20kl1`; both
//!        cancel). Encounter-start rolls are broadcast only after the
//!        command commits, so a rejected start leaks no hidden combatant.
//!      - Stored player rolls are dropped on every committed transition into or
//!        out of `TurnByTurn`, whatever supplied the initiative order, so a roll
//!        made for one encounter never carries over to the next.
//!      - `RecordDeathSave` follows the same rule: a player's d20 is replaced by
//!        a server `1d20` (`2d20kh1` with Survivor) minus `2 * effective_exhaustion`
//!        (`resolve_death_save_roll`), forwarding the kept natural d20 face to the
//!        engine and broadcasting the roll after commit like an initiative roll
//!        (the token's controller always receives it). Batches (MCP) resolve an
//!        empty `d20` the same way.
//!   9. `Bounded Fan-Out & Pointer Pings (RT2)`:
//!      - Each client has a `CLIENT_OUTBOUND_QUEUE_FRAMES`-deep queue the actor
//!        fills without waiting (`ClientSender`). A full queue drops the frame
//!        and closes that socket with `1013`; the client reconnects and resyncs
//!        from a fresh `StateSnapshot`, and everyone else is unaffected.
//!      - A `PointerPing` is broadcast only when its position is finite and on
//!        the map, its color is a palette color, its `scene_id` (if any) is the
//!        active scene, and the user's previous ping (any of their sessions,
//!        monotonic `tokio::time::Instant`) is at least
//!        `POINTER_PING_MIN_INTERVAL_MS` old. Invalid pings are rejected;
//!        throttled ones are dropped silently.
//!  10. `Server-Rolled Action Resolution (D6, ADR-0042)`:
//!      - `ResolveAction` and `RollConcentrationCheck` are always filled by the
//!        room (`resolve_action_rolls`, `resolution.rs`), whatever the client
//!        sent, and cannot be batched. Resolution rolls never reach the dice
//!        log; a Concentration roll is `GmOnly` and reaches the GM and the
//!        token's controller only, like `ConcentrationCheckRolled` (sync.rs
//!        invariant 8).
//!      - `ApplyResolution` adjustments are bounded like `ApplyDamage`.
//!  11. `Unchanged Projections Are Not Resent (RT12)`:
//!      - The actor keeps, per session, the `ProjectionHash` (SHA-256 of the
//!        MessagePack projection) of the last state frame it sent. After a
//!        command commits, a recipient whose projection hash is unchanged and
//!        whose filtered events are empty gets no `CommandAccepted` at all: a
//!        GM-only change no longer ships every player a full state frame.
//!      - Clients replace their table only from strictly newer `seq_id`s, so a
//!        skipped `seq_id` is harmless; the next frame carries the full state.
//!      - Every attach sends a full `StateSnapshot` and records its hash, so a
//!        reconnect or resync always starts from a complete frame.
//!      - State changed outside the command stream (sheet tactical sync, MCP
//!        staging) sends a `StateSnapshot` to each session whose hash changed
//!        (`push_changed_projections`), so a sheet HP edit reaches the table
//!        without waiting for the next command.
//!  12. `Dead Sessions Are Pruned (RT4)`:
//!      - Before every mailbox message the actor drops sessions whose socket
//!        task is gone (`ClientSender::is_closed`, what `send` reports as
//!        `OutboundSendError::Closed`) with their projection hash and command
//!        bucket. A timed-out attach or a lost `DisconnectClient` therefore
//!        cannot keep `active_connections` above zero and block hibernation.
//!  13. `Per-Session Command Rate Limit`:
//!      - `SubmitCommand` and `RollDice` spend one token of the session's
//!        bucket (`COMMAND_RATE_BURST` = 20, refilled at
//!        `COMMAND_RATE_REFILL_PER_SEC` = 10/s, monotonic clock). An empty
//!        bucket answers `CommandRejected` with `CommandError::RateLimited`
//!        and the client's `correlation_id`, before any authorization, dice
//!        or WAL work. Pings and pointer pings are not counted.
//!  14. `Campaign Player Roster`:
//!      - Hidden roll privacy (invariant 7) counts every `Player` member of
//!        the campaign (`set_player_roster`, refreshed by the HTTP layer when
//!        it wakes or attaches to a room and when membership changes), not only
//!        connected ones: the timeline is read later by offline players.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `RoomLeaseManager::get_or_wake_room(campaign_id)`
//!     ├── 1. Check read lock for existing `TableRoomHandle`.
//!     ├── 2. Acquire write lock, re-check, and call `TableRoomActor::spawn(...)`.
//!     │    ├── Rehydrate `(TableState, seq_id)` via `recover_table_state`.
//!     │    └── Spawn `actor.run()` loop on Tokio runtime.
//!     └── 3. Return cloneable `TableRoomHandle` for client attachment and envelopes.
//! ============================================================================

use crate::dice::{DiceRollOutcome, RollVisibility, SeededDiceRoller, project_roll_for_recipient};
use crate::sync::{
    ClientEnvelope, McpStagingProposal, ProjectedTableState, QuarantinedWalSummary, ServerEnvelope,
    encode_server_envelope, filter_events_for_recipient, project_state_for_recipient,
    visible_token_ids_for_recipient,
};
use crate::wal::{
    TableStateSnapshot, WalEntry, WalError, WalRecord, WalStorage, recover_table_state,
};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::sync::{RwLock, mpsc, oneshot};
use trame_engine::commands::{
    CampaignRole, CommandActor, RejectionDetail, TableMode, TableState, TrameCommand, TrameEvent,
};
use trame_engine::rules::DamageAffinity;
use uuid::Uuid;

/// Global atomic boolean flag indicating if the server runtime is in the process of shutting down.
/// When set to `true`, incoming HTTP/WebSocket connections are rejected.
pub static IS_SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// RFC 6455 WebSocket Close Code `1001 Going Away` emitted during graceful scale-to-zero / hibernation.
pub const WS_CLOSE_CODE_GOING_AWAY: u16 = 1001;

/// Standard reason string broadcast alongside close code 1001.
pub const WS_CLOSE_REASON_GOING_AWAY: &str = "Server Hibernating";

/// RFC 6455 close code `1011 Internal Error`: the room actor stopped (storage could not be
/// made consistent) or did not answer in time; the client reconnects to a fresh actor.
pub const WS_CLOSE_CODE_INTERNAL_ERROR: u16 = 1011;

/// Application close code sent to the sockets of a user whose campaign membership was
/// removed (SEC13); reconnecting fails the membership check with `403`.
pub const WS_CLOSE_CODE_MEMBERSHIP_REVOKED: u16 = 4403;

/// Upper bound on `ApplyDamage.raw_damage` (HP). Far above any 5e damage roll while keeping
/// engine multipliers (`Vulnerable` doubles damage) well inside `i32`.
pub const MAX_RAW_DAMAGE: i32 = 10_000;

/// SHA-256 digest (32 bytes) of a recipient's `ProjectedTableState` (see `projection_hash`).
pub type ProjectionHash = [u8; 32];

/// SHA-256 of the MessagePack encoding of `state`. Every map in the projection is a
/// `BTreeMap`, so equal projections encode to equal bytes. A cryptographic digest keeps a
/// player from crafting a collision that would freeze another recipient's view. `None` when
/// the state cannot be encoded: the frame is then always sent.
pub fn projection_hash(state: &ProjectedTableState) -> Option<ProjectionHash> {
    use sha2::{Digest, Sha256};
    let bytes = rmp_serde::to_vec_named(state).ok()?;
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&Sha256::digest(&bytes));
    Some(hash)
}

fn is_gm_hidden(token: &trame_engine::commands::TokenState) -> bool {
    token.visibility_channel & trame_engine::geometry::CHANNEL_GM_HIDDEN != 0
}

/// A server-rolled initiative: the token it was rolled for and the outcome.
type InitiativeRoll = (Uuid, DiceRollOutcome);

/// Initiative privacy (RT7): `Public` only when the token is not GM-hidden and every player
/// in `views` (`TableRoomActor::player_views`) can see it; otherwise `GmOnly`, which keeps
/// the roll out of other players' sockets and makes its timeline record GM-only.
fn initiative_roll_visibility(
    token: &trame_engine::commands::TokenState,
    views: &[HashSet<Uuid>],
) -> RollVisibility {
    if is_gm_hidden(token) || views.iter().any(|seen| !seen.contains(&token.id)) {
        RollVisibility::GmOnly
    } else {
        RollVisibility::Public
    }
}

/// Dice expression for an `AuthoritativeInitiativeRoll` of `token`: the d20 term of its
/// server-derived mode (`resolution::initiative_roll_mode`: `1d20`, `2d20kh1` or `2d20kl1`)
/// plus its signed initiative modifier.
fn initiative_expression(token: &trame_engine::commands::TokenState) -> String {
    let term = trame_engine::resolution::initiative_roll_mode(token).d20_term();
    let modifier = token.initiative_modifier();
    match modifier.cmp(&0) {
        std::cmp::Ordering::Greater => format!("{term}+{modifier}"),
        std::cmp::Ordering::Less => format!("{term}{modifier}"),
        std::cmp::Ordering::Equal => term.to_string(),
    }
}

/// Dice expression for a server-rolled `RecordDeathSave`: the d20 term of `mode` (`1d20`, or
/// `2d20kh1` with Survivor) minus `2 * effective_exhaustion` (`1d20-2`..`1d20-12`, omitted
/// when `0`).
fn death_save_expression(
    mode: trame_engine::resolution::RollMode,
    effective_exhaustion: u8,
) -> String {
    let term = mode.d20_term();
    let penalty = 2 * i32::from(effective_exhaustion);
    if penalty > 0 {
        format!("{term}-{penalty}")
    } else {
        term.to_string()
    }
}

/// RFC 6455 close code `1013 Try Again Later`: the client's outbound queue overflowed (slow
/// consumer, RT2). The web client treats it like any close of an opened socket: it reconnects
/// with backoff and resyncs from the `StateSnapshot`.
pub const WS_CLOSE_CODE_SLOW_CONSUMER: u16 = 1013;

/// Frames a client's outbound queue holds (`client_channel`). A `CommandAccepted` carries the
/// whole projected state, so a consumer this far behind is better served by a resync.
pub const CLIENT_OUTBOUND_QUEUE_FRAMES: usize = 64;

/// Minimum spacing between two broadcast `PointerPing`s of one user, across all their
/// sessions (`ms`, monotonic clock); faster pings are dropped silently (RT2).
pub const POINTER_PING_MIN_INTERVAL_MS: u64 = 250;

/// Longest accepted `PointerPing.color_hex` (`bytes`).
pub const MAX_POINTER_PING_COLOR_LEN: usize = 48;

/// Commands and dice rolls one session may send back to back (token bucket capacity). Above
/// any burst of real play (a GM resolving a fireball on a dozen targets, a player spamming
/// undo-able moves) while keeping one socket from monopolizing the room actor.
pub const COMMAND_RATE_BURST: u32 = 20;

/// Tokens refilled per second into a session's command bucket (`COMMAND_RATE_BURST` cap).
pub const COMMAND_RATE_REFILL_PER_SEC: u32 = 10;

/// Per-session token bucket for `SubmitCommand` and `RollDice` (see `COMMAND_RATE_BURST`).
/// Monotonic clock (`tokio::time::Instant`) so wall-clock jumps cannot refill or freeze it.
#[derive(Debug, Clone, Copy)]
struct CommandBucket {
    /// Tokens left, `0.0..=COMMAND_RATE_BURST`.
    tokens: f64,
    /// When `tokens` was last refilled.
    refilled_at: tokio::time::Instant,
}

impl CommandBucket {
    fn full(now: tokio::time::Instant) -> Self {
        Self {
            tokens: f64::from(COMMAND_RATE_BURST),
            refilled_at: now,
        }
    }

    /// Refills for the time elapsed since the last call, then spends one token if available.
    fn try_take(&mut self, now: tokio::time::Instant) -> bool {
        let elapsed = now.duration_since(self.refilled_at).as_secs_f64();
        self.tokens = (self.tokens + elapsed * f64::from(COMMAND_RATE_REFILL_PER_SEC))
            .min(f64::from(COMMAND_RATE_BURST));
        self.refilled_at = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Why `ClientSender::send` did not queue a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboundSendError {
    /// The queue was full: the frame was dropped and the socket is being closed with
    /// `WS_CLOSE_CODE_SLOW_CONSUMER`.
    Overflow,
    /// The socket task is gone; the actor drops the session (`prune_closed_clients`).
    Closed,
}

/// Sending half of a client's bounded outbound queue (RT2).
///
/// `send` never waits, so one stalled browser cannot stall the room actor and every other
/// client with it. On a full queue the frame is dropped and the overflow signal fires; the
/// socket task then closes the socket with `WS_CLOSE_CODE_SLOW_CONSUMER` without draining the
/// backlog, and the client recovers by reconnecting (fresh `StateSnapshot`).
#[derive(Debug, Clone)]
pub struct ClientSender {
    tx: mpsc::Sender<OutboundClientFrame>,
    overflow: Arc<tokio::sync::Notify>,
}

impl ClientSender {
    /// Queues `frame` without waiting (see the type docs for the overflow policy).
    pub fn send(&self, frame: OutboundClientFrame) -> Result<(), OutboundSendError> {
        match self.tx.try_send(frame) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.overflow.notify_one();
                Err(OutboundSendError::Overflow)
            }
            Err(mpsc::error::TrySendError::Closed(_)) => Err(OutboundSendError::Closed),
        }
    }

    /// Signal fired when a frame was dropped because the queue was full; the socket task
    /// waits on it to close the socket.
    pub fn overflow_signal(&self) -> Arc<tokio::sync::Notify> {
        self.overflow.clone()
    }

    /// `true` once the receiving socket task is gone: every further `send` would return
    /// `OutboundSendError::Closed`.
    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
}

/// Bounded outbound queue of one client, `CLIENT_OUTBOUND_QUEUE_FRAMES` deep.
pub fn client_channel() -> (ClientSender, mpsc::Receiver<OutboundClientFrame>) {
    client_channel_with_capacity(CLIENT_OUTBOUND_QUEUE_FRAMES)
}

/// Bounded outbound queue holding at most `capacity` frames (`>= 1`).
pub fn client_channel_with_capacity(
    capacity: usize,
) -> (ClientSender, mpsc::Receiver<OutboundClientFrame>) {
    let (tx, rx) = mpsc::channel(capacity.max(1));
    let sender = ClientSender {
        tx,
        overflow: Arc::new(tokio::sync::Notify::new()),
    };
    (sender, rx)
}

/// Checks a `PointerPing` against the active map (RT2): finite coordinates inside
/// `0..=map_width_px` x `0..=map_height_px`, a palette color (`#RGB`, `#RRGGBB`,
/// `#RRGGBBAA`, or `var(--token)`), and, when the client named one, the active scene.
pub fn validate_pointer_ping(
    state: &TableState,
    pos: &trame_engine::geometry::Point2D,
    color_hex: &str,
    scene_id: Option<Uuid>,
) -> Result<(), String> {
    let on_map = |v: f64, max: u32| v.is_finite() && (0.0..=f64::from(max)).contains(&v);
    if !on_map(pos.x, state.data.map_width_px) || !on_map(pos.y, state.data.map_height_px) {
        return Err("invalid pointer ping: position is not on the map".to_string());
    }
    if scene_id.is_some() && scene_id != state.data.active_scene_id {
        return Err("invalid pointer ping: scene is not the active scene".to_string());
    }
    let is_hex = |s: &str| {
        s.strip_prefix('#').is_some_and(|digits| {
            matches!(digits.len(), 3 | 6 | 8) && digits.chars().all(|c| c.is_ascii_hexdigit())
        })
    };
    let is_token = |s: &str| {
        s.strip_prefix("var(--")
            .and_then(|rest| rest.strip_suffix(')'))
            .is_some_and(|name| {
                !name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            })
    };
    if color_hex.len() > MAX_POINTER_PING_COLOR_LEN || !(is_hex(color_hex) || is_token(color_hex)) {
        return Err("invalid pointer ping: color is not a palette color".to_string());
    }
    Ok(())
}

/// Outbound frame sent from a room actor to a connected client's socket transmission task.
#[derive(Debug, Clone)]
pub enum OutboundClientFrame {
    /// Binary payload carrying MessagePack-encoded `ServerEnvelope`.
    Binary(Vec<u8>),
    /// WebSocket Close frame with status code and descriptive reason.
    Close {
        /// 16-bit WebSocket status code (e.g. 1001).
        code: u16,
        /// Descriptive close reason string.
        reason: String,
    },
}

/// Errors raised when interacting with a `TableRoomActor` or its underlying `WalStorage`.
#[derive(Debug, Error)]
pub enum RoomError {
    /// The room actor's MPSC mailbox or oneshot reply channel closed unexpectedly.
    #[error("Room actor channel closed")]
    ActorClosed,
    /// Underlying Write-Ahead Log or snapshot persistence failure.
    #[error("WAL storage error: {0}")]
    Wal(#[from] WalError),
    /// The server is shutting down and cannot accept new room connections.
    #[error("Server is shutting down")]
    ShuttingDown,
    /// Hibernation timed out.
    #[error("Hibernation timed out")]
    Timeout,
    /// Authoritative command execution rejected by `TableState`.
    #[error("Command rejected: {0}")]
    CommandRejected(String),
    /// `TableState::apply_command` / `apply_batch` refused the command; the client receives
    /// its message plus its structured `RejectionDetail`.
    #[error("Command rejected: {0}")]
    Engine(trame_engine::commands::CommandError),
}

/// Armor Class a synced sheet can give a token, the stat block bound (`statblock.rs`).
pub const SHEET_AC_RANGE: std::ops::RangeInclusive<i32> = 1..=30;

/// Highest walking speed a synced sheet can give a token (`ft`), the stat block bound.
pub const MAX_SHEET_SPEED_FT: f64 = 200.0;

/// Sheet condition ids as `SetTokenConditions` would store them (trimmed, ASCII lowercase,
/// deduplicated, `1..=MAX_CONDITION_ID_LEN` bytes, at most `MAX_TOKEN_CONDITIONS`). A sheet
/// save is never rejected for its conditions, so invalid ids are dropped and the list is
/// truncated instead.
fn sheet_condition_ids(raw: &[String]) -> Vec<String> {
    use trame_engine::commands::{MAX_CONDITION_ID_LEN, MAX_TOKEN_CONDITIONS};
    let mut ids: Vec<String> = Vec::new();
    for id in raw {
        let id = id.trim().to_ascii_lowercase();
        if ids.len() == MAX_TOKEN_CONDITIONS {
            break;
        }
        if !id.is_empty() && id.len() <= MAX_CONDITION_ID_LEN && !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

/// Tactical subset of persistent actor fields synchronized out-of-band into linked `TokenState` instances (`ADR-0037`).
#[derive(Debug, Clone, Default)]
pub struct ActorTacticalSync {
    /// Updated display name for the token.
    pub name: Option<String>,
    /// Updated current Hit Points (`hp_current`).
    pub hp_current: Option<i32>,
    /// Updated maximum Hit Points (`hp_max`).
    pub hp_max: Option<i32>,
    /// Updated Temporary Hit Points (`temp_hp`).
    pub temp_hp: Option<i32>,
    /// Updated Armor Class (`ac`), from the sheet's `derived.armorClass` (GS6).
    pub ac: Option<i32>,
    /// Updated Dexterity ability modifier (`dex_mod`).
    pub dex_mod: Option<i32>,
    /// Updated non-Dexterity initiative bonus (`TokenState::initiative_extra`, SEC3).
    pub initiative_extra: Option<i32>,
    /// Updated walking speed in feet (`ft`, clamped to `0..=MAX_SHEET_SPEED_FT`) after
    /// exhaustion and class features, from the sheet's `derived.speed`, else
    /// `attributes.speedFt` (GS6); copied onto `speed_max_ft`.
    pub speed_ft: Option<f64>,
    /// Updated list of active condition labels (`conditions`).
    pub conditions: Option<Vec<String>>,
    /// Updated `(resistances, immunities, vulnerabilities)` damage-type lists (A68), copied
    /// onto `TokenState::damage_*` so typed `ApplyDamage` derives the affinity server-side.
    pub damage_affinities: Option<(Vec<String>, Vec<String>, Vec<String>)>,
    /// Opportunity-attack reach in feet (`ft`, `0..=100`) derived server-side from the
    /// equipped weapon or the stat block's melee attacks; copied onto `TokenState::reach_ft`.
    pub reach_ft: Option<f64>,
    /// Darkvision radius in feet (`ft`, `0..=500`) from the species or stat block senses;
    /// copied onto `TokenState::senses.darkvision_range_ft`.
    pub darkvision_ft: Option<f64>,
    /// Saving throw bonuses by ability id derived from the sheet (bounded scores), copied onto
    /// `TokenState::save_bonuses` so the room can roll a hidden target's save.
    pub save_bonuses: Option<BTreeMap<String, i32>>,
    /// Server-rolled d20s the sheet's features give Advantage on (`"initiative"`,
    /// `"death_save"` only), copied onto `TokenState::feature_roll_advantages`. `None` keeps
    /// the token's current list.
    pub feature_roll_advantages: Option<Vec<String>>,
    /// SRD 5.2.1 Exhaustion level (`0..=6`) from the sheet, copied onto
    /// `TokenState::exhaustion` so engine-resolved d20 tests (such as `RecordDeathSave`)
    /// apply `-2 * effective_exhaustion`. `None` keeps the token's current level.
    pub exhaustion: Option<u8>,
    /// Accumulated death saving throw successes (`0..=3`) from the sheet's
    /// `attributes.deathSaves.successes` (`Dnd5eActorData`) or `deathSaves.successes`
    /// (`Dnd5eActorSheet`). `None` keeps the token's counter.
    pub death_save_successes: Option<u8>,
    /// Accumulated death saving throw failures (`0..=3`) from the sheet's
    /// `attributes.deathSaves.failures` (`Dnd5eActorData`) or `deathSaves.failures`
    /// (`Dnd5eActorSheet`). `None` keeps the token's counter.
    pub death_save_failures: Option<u8>,
    /// Whether the actor is Stable at `0` HP (`attributes.deathSaves.isStable` or
    /// `deathSaves.isStable`). `None` keeps the token's flag (cleared when HP `> 0` or dead).
    pub is_stable: Option<bool>,
    /// Whether the actor is dead (`isDead`, `deathSaves.isDead`, `failures >= 3`, or
    /// Exhaustion level `6`). `None` keeps the token's flag.
    pub is_dead: Option<bool>,
}

impl ActorTacticalSync {
    /// Copies every synced field onto `token` (the sheet resync and actor-linked `SpawnToken`
    /// share it, so both ignore client values). The sheet is client-written, so values get
    /// the stat block bounds: AC `SHEET_AC_RANGE`, speed `0..=MAX_SHEET_SPEED_FT`, and
    /// conditions normalized and capped (`sheet_condition_ids`). `mode` decides the remaining speed: the full
    /// speed in `Exploration`, at most the new speed in `TurnByTurn`. A token whose conditions
    /// set its Speed to 0 (`condition_effects().speed_zero`, GM rulings included) ends with
    /// `speed_remaining_ft == 0` while `speed_max_ft` keeps the sheet speed, so lifting the
    /// condition restores the speed at the next turn without another sheet save.
    pub fn apply_to_token(&self, token: &mut trame_engine::commands::TokenState, mode: TableMode) {
        if let Some(ref name) = self.name {
            token.name = name.clone();
        }
        if let Some(hp_max) = self.hp_max {
            token.max_hp = hp_max.max(1);
            token.hp = token.hp.clamp(0, token.max_hp);
        }
        if let Some(hp_current) = self.hp_current {
            token.hp = hp_current.clamp(0, token.max_hp);
        }
        if let Some(temp_hp) = self.temp_hp {
            token.temp_hp = temp_hp.max(0);
        }
        if let Some(successes) = self.death_save_successes {
            token.death_save_successes =
                successes.min(trame_engine::rules::DEATH_SAVE_SUCCESSES_TO_STABILIZE);
        }
        if let Some(failures) = self.death_save_failures {
            token.death_save_failures =
                failures.min(trame_engine::rules::DEATH_SAVE_FAILURES_TO_DIE);
        }
        if let Some(is_stable) = self.is_stable {
            token.is_stable = is_stable;
        }
        if let Some(is_dead) = self.is_dead {
            token.is_dead = is_dead;
        }
        if token.hp > 0 {
            token.death_save_successes = 0;
            token.death_save_failures = 0;
            token.is_stable = false;
        }
        if token.is_dead {
            token.is_stable = false;
        }
        if let Some(ac) = self.ac {
            token.ac = ac.clamp(*SHEET_AC_RANGE.start(), *SHEET_AC_RANGE.end());
        }
        if let Some(dex_mod) = self.dex_mod {
            token.dex_mod = dex_mod;
        }
        if let Some(extra) = self.initiative_extra {
            token.initiative_extra = extra;
        }
        if let Some(speed_ft) = self.speed_ft
            && speed_ft.is_finite()
        {
            let speed_ft = speed_ft.clamp(0.0, MAX_SHEET_SPEED_FT);
            token.speed_max_ft = speed_ft;
            if mode == TableMode::Exploration {
                token.speed_remaining_ft = speed_ft;
            } else {
                token.speed_remaining_ft = token.speed_remaining_ft.min(speed_ft);
            }
        }
        if let Some(ref conditions) = self.conditions {
            token.conditions = sheet_condition_ids(conditions);
        }
        if token.is_dead || token.condition_effects().speed_zero {
            token.speed_remaining_ft = 0.0;
        }
        if let Some((ref resist, ref immune, ref vuln)) = self.damage_affinities {
            token.damage_resistances = resist.clone();
            token.damage_immunities = immune.clone();
            token.damage_vulnerabilities = vuln.clone();
        }
        self.apply_sheet_rules(token);
    }

    /// Copies the sheet-derived rules fields (reach, darkvision) onto `token`.
    fn apply_sheet_rules(&self, token: &mut trame_engine::commands::TokenState) {
        if let Some(reach_ft) = self.reach_ft {
            token.reach_ft = reach_ft;
        }
        if let Some(darkvision_ft) = self.darkvision_ft {
            token.senses.darkvision_range_ft = darkvision_ft;
        }
        if let Some(ref save_bonuses) = self.save_bonuses {
            token.save_bonuses = save_bonuses.clone();
        }
        if let Some(ref advantages) = self.feature_roll_advantages {
            token.feature_roll_advantages = advantages.clone();
        }
        if let Some(exhaustion) = self.exhaustion {
            token.exhaustion = exhaustion.min(trame_engine::rules::MAX_EXHAUSTION_LEVEL);
        }
    }
}

/// Vitals of an actor-linked token after a tabletop command changed them, forwarded to the
/// persistence sink so the actor sheet in storage follows the table (S1, G4). Synthetic tokens
/// (`actor_id == None`) never produce one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedVitalsChange {
    /// Campaign hosting the room.
    pub campaign_id: Uuid,
    /// Persistent actor linked through `TokenState::actor_id`.
    pub actor_id: Uuid,
    /// Current hit points after the command (`0..=max_hp`).
    pub hp: i32,
    /// Temporary hit points after the command (`>= 0`).
    pub temp_hp: i32,
    /// Accumulated death saving throw successes after the command (`0..=3`).
    pub death_save_successes: u8,
    /// Accumulated death saving throw failures after the command (`0..=3`).
    pub death_save_failures: u8,
    /// Whether the token is Stable at `0` HP after the command.
    pub is_stable: bool,
    /// Whether the token is dead after the command.
    pub is_dead: bool,
    /// Condition ids of the token (`TokenState::conditions`, without GM overrides) when the
    /// command changed them; `None` leaves the sheet's conditions untouched.
    pub conditions: Option<Vec<String>>,
}

/// Table-side fields of an actor-linked token mirrored into its actor sheet.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LinkedVitals {
    hp: i32,
    temp_hp: i32,
    death_save_successes: u8,
    death_save_failures: u8,
    is_stable: bool,
    is_dead: bool,
    conditions: Vec<String>,
}

/// `LinkedVitals` keyed by `(token_id, actor_id)`.
type LinkedVitalsMap = BTreeMap<(Uuid, Uuid), LinkedVitals>;

/// Room-side record of a dice roll or initiative result destined for the session timeline.
#[derive(Debug, Clone, PartialEq)]
pub struct TimelineNote {
    /// Campaign hosting the room.
    pub campaign_id: Uuid,
    /// Timeline event type (`"dice_roll"`, `"initiative"`).
    pub event_type: String,
    /// JSON payload; carries `"visibility": "gm"` for rolls players must not see.
    pub payload: serde_json::Value,
}

/// Out-of-band channels a room uses to reach storage without blocking its mailbox.
#[derive(Clone, Default)]
pub struct RoomSinks {
    /// Receives linked-token vitals changes (`LinkedVitalsChange`).
    pub vitals: Option<mpsc::UnboundedSender<LinkedVitalsChange>>,
    /// Receives dice and initiative timeline records (`TimelineNote`).
    pub timeline: Option<mpsc::UnboundedSender<TimelineNote>>,
}

/// Represents a live WebSocket client session attached to a `TableRoomActor`.
pub struct ConnectedClient {
    /// Unique per-connection session identifier.
    pub session_id: Uuid,
    /// Authenticated user identifier.
    pub user_id: Uuid,
    /// Campaign role (`Gm`, `Player`, or `Spectator`) governing RBAC and state projection.
    pub role: CampaignRole,
    /// Bounded outbound queue (`client_channel`) carrying frames to the socket task.
    pub tx: ClientSender,
}

/// Internal control messages processed sequentially by `TableRoomActor::run`.
pub enum RoomActorMessage {
    /// Registers a newly connected client and pushes an initial role-filtered `StateSnapshot`.
    ConnectClient {
        /// Client session descriptor and outbound frame channel.
        client: ConnectedClient,
        /// Oneshot acknowledgment signal once initial snapshot enqueue completes.
        reply: oneshot::Sender<Result<(), RoomError>>,
    },
    /// Removes a disconnected client session from the room's broadcast table.
    DisconnectClient {
        /// Session UUID to remove.
        session_id: Uuid,
    },
    /// Replaces the room's roster of the campaign's `Player` members (connected or not), used
    /// by hidden roll privacy (`TableRoomActor::player_views`).
    SetPlayerRoster {
        /// User ids of every `Player` member of the campaign.
        players: Vec<Uuid>,
    },
    /// Closes (code `WS_CLOSE_CODE_MEMBERSHIP_REVOKED`) and removes every session of `user_id`.
    EvictUser {
        /// Account whose membership changed.
        user_id: Uuid,
        /// Oneshot channel receiving the number of sessions closed.
        reply: oneshot::Sender<usize>,
    },
    /// Processes an inbound `ClientEnvelope` (command, dice roll, pointer ping, or latency ping).
    HandleEnvelope {
        /// Originating client session UUID.
        session_id: Uuid,
        /// Deserialized client wire payload.
        envelope: ClientEnvelope,
        /// Oneshot completion result.
        reply: oneshot::Sender<Result<(), RoomError>>,
    },
    /// Queries live telemetry (`seq_id`, connection count, last activity timestamp) for `Idle-Lease` sweeps.
    QueryMetrics {
        /// Oneshot channel receiving the current `RoomMetrics`.
        reply: oneshot::Sender<RoomMetrics>,
    },
    /// Flushes a final `TableStateSnapshot` to `WalStorage`, sends close code 1001 to all clients, and stops.
    Hibernate {
        /// Oneshot channel receiving the final persisted `seq_id`.
        reply: oneshot::Sender<Result<u64, RoomError>>,
    },
    /// Dispatches an authoritative `TrameCommand` directly from a server-side HTTP or MCP handler.
    DispatchDirectCommand {
        /// Authenticated caller identity and role.
        actor: CommandActor,
        /// Tabletop command to apply.
        command: TrameCommand,
        /// Oneshot channel receiving `(seq_id, events)` on acceptance.
        reply: oneshot::Sender<Result<(u64, Vec<TrameEvent>), RoomError>>,
    },
    /// Broadcasts `ServerEnvelope::ActorUpdated` and synchronizes linked `TokenState` fields without touching `undo_stack` (`ADR-0037`).
    NotifyActorUpdated {
        /// Persistent actor UUID.
        actor_id: Uuid,
        /// Owning player of the persistent actor sheet (`None` for GM-owned NPC/Monster actors).
        actor_owner_user_id: Option<Uuid>,
        /// New optimistic concurrency version.
        version: u64,
        /// Full serialized actor payload.
        data: serde_json::Value,
        /// Tactical combat fields to sync onto linked tokens (`token.actor_id == Some(actor_id)`).
        tactical_sync: ActorTacticalSync,
        /// Oneshot channel receiving the number of linked tabletop tokens updated.
        reply: oneshot::Sender<Result<usize, RoomError>>,
    },
    /// Stages an MCP dry-run command batch in `TableState` and broadcasts `ServerEnvelope::McpStagingProposed` to GMs.
    StageMcpProposal {
        /// Proposal to stage.
        proposal: McpStagingProposal,
        /// Oneshot channel receiving the staged proposal.
        reply: oneshot::Sender<Result<McpStagingProposal, RoomError>>,
    },
    /// Retrieves a clone of the current `(seq_id, TableState)` for inspection or MCP resource reads.
    GetTableSnapshot {
        /// Oneshot channel receiving `(seq_id, TableState)`.
        reply: oneshot::Sender<(u64, TableState)>,
    },
    /// Applies `commands` atomically through `TableState::apply_batch` (one composite undo entry).
    DispatchBatch {
        /// Authenticated caller identity and role.
        actor: CommandActor,
        /// Commands applied all-or-nothing.
        commands: Vec<TrameCommand>,
        /// Undo label of the composite entry.
        description: String,
        /// Oneshot channel receiving `(seq_id, events)` on acceptance.
        reply: oneshot::Sender<Result<(u64, Vec<TrameEvent>), RoomError>>,
    },
    /// Records a dice roll made outside the WebSocket (REST) in the live table log.
    BroadcastDiceRoll {
        /// Completed roll (already persisted to the timeline by the caller).
        outcome: crate::dice::DiceRollOutcome,
    },
    /// Sends revealed handout content to every connected client.
    BroadcastHandout {
        /// Journal-persisted handout payload.
        handout: crate::notes::HandoutRevealedBroadcast,
    },
}

/// Point-in-time operational telemetry for an active `TableRoomActor`.
#[derive(Debug, Clone, Copy)]
pub struct RoomMetrics {
    /// Campaign UUID hosted by the room actor.
    pub campaign_id: Uuid,
    /// Latest monotonically increasing WAL sequence number (`>= 0`).
    pub seq_id: u64,
    /// Number of currently connected WebSocket sessions.
    pub active_connections: usize,
    /// Unix epoch timestamp in milliseconds (`ms`) of the most recent client event or connection change.
    pub last_activity_ms: u64,
}

/// Cloneable async handle used by HTTP/WebSocket handlers and `RoomLeaseManager` to communicate with a `TableRoomActor`.
#[derive(Clone, Debug)]
pub struct TableRoomHandle {
    /// Campaign UUID associated with this room handle.
    pub campaign_id: Uuid,
    tx: mpsc::Sender<RoomActorMessage>,
}

impl TableRoomHandle {
    /// Attaches a `ConnectedClient` to the room and triggers an immediate `ServerEnvelope::StateSnapshot` push.
    pub async fn connect_client(&self, client: ConnectedClient) -> Result<(), RoomError> {
        if IS_SHUTTING_DOWN.load(Ordering::Acquire) {
            return Err(RoomError::ShuttingDown);
        }
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(RoomActorMessage::ConnectClient {
                client,
                reply: reply_tx,
            })
            .await
            .map_err(|_| RoomError::ActorClosed)?;
        reply_rx.await.map_err(|_| RoomError::ActorClosed)?
    }

    /// Notifies the room actor that `session_id` has disconnected.
    pub async fn disconnect_client(&self, session_id: Uuid) -> Result<(), RoomError> {
        self.tx
            .send(RoomActorMessage::DisconnectClient { session_id })
            .await
            .map_err(|_| RoomError::ActorClosed)
    }

    /// Replaces the room's roster of `Player` members (see `RoomActorMessage::SetPlayerRoster`).
    /// Fire-and-forget like `disconnect_client`: later messages see the new roster.
    pub async fn set_player_roster(&self, players: Vec<Uuid>) -> Result<(), RoomError> {
        self.tx
            .send(RoomActorMessage::SetPlayerRoster { players })
            .await
            .map_err(|_| RoomError::ActorClosed)
    }

    /// Closes every live socket of `user_id`; returns how many sessions were closed.
    pub async fn evict_user(&self, user_id: Uuid) -> Result<usize, RoomError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(RoomActorMessage::EvictUser {
                user_id,
                reply: reply_tx,
            })
            .await
            .map_err(|_| RoomError::ActorClosed)?;
        reply_rx.await.map_err(|_| RoomError::ActorClosed)
    }

    /// Submits a deserialized `ClientEnvelope` from `session_id` to the room actor for authoritative execution.
    pub async fn send_envelope(
        &self,
        session_id: Uuid,
        envelope: ClientEnvelope,
    ) -> Result<(), RoomError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(RoomActorMessage::HandleEnvelope {
                session_id,
                envelope,
                reply: reply_tx,
            })
            .await
            .map_err(|_| RoomError::ActorClosed)?;
        reply_rx.await.map_err(|_| RoomError::ActorClosed)?
    }

    /// Queries the room actor's current `RoomMetrics` (`seq_id`, `active_connections`, `last_activity_ms`).
    pub async fn metrics(&self) -> Result<RoomMetrics, RoomError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(RoomActorMessage::QueryMetrics { reply: reply_tx })
            .await
            .map_err(|_| RoomError::ActorClosed)?;
        reply_rx.await.map_err(|_| RoomError::ActorClosed)
    }

    /// Commands the room actor to flush state, broadcast WebSocket Close 1001 to all clients, and terminate.
    pub async fn hibernate(&self) -> Result<u64, RoomError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(RoomActorMessage::Hibernate { reply: reply_tx })
            .await
            .map_err(|_| RoomError::ActorClosed)?;
        reply_rx.await.map_err(|_| RoomError::ActorClosed)?
    }

    /// Executes an authoritative `TrameCommand` directly from a server-side HTTP or MCP handler,
    /// appending to the WAL and broadcasting `ServerEnvelope::CommandAccepted` to connected clients.
    pub async fn dispatch_direct_command(
        &self,
        actor: CommandActor,
        command: TrameCommand,
    ) -> Result<(u64, Vec<TrameEvent>), RoomError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(RoomActorMessage::DispatchDirectCommand {
                actor,
                command,
                reply: reply_tx,
            })
            .await
            .map_err(|_| RoomError::ActorClosed)?;
        reply_rx.await.map_err(|_| RoomError::ActorClosed)?
    }

    /// Broadcasts `ServerEnvelope::ActorUpdated` to `CampaignRole::Gm` and to the persistent
    /// actor's owning `CampaignRole::Player` when they control a linked token on the live table
    /// (with `statBlock` stripped for non-GMs, so unspawned `ActorsTab` edits preserve REST
    /// `expected_version` `409 VERSION_CONFLICT` while GM-owned NPC/Monster tokens assigned to
    /// players and Spectators never receive `ActorUpdated` or `statBlock`) and synchronizes
    /// linked `TokenState` tactical fields (`hp_current`, `hp_max`, `temp_hp`, `ac`, `speed_ft`,
    /// `conditions`) without pushing onto the 50-entry tactical `undo_stack` (`ADR-0037`).
    pub async fn notify_actor_updated(
        &self,
        actor_id: Uuid,
        actor_owner_user_id: Option<Uuid>,
        version: u64,
        data: serde_json::Value,
        tactical_sync: ActorTacticalSync,
    ) -> Result<usize, RoomError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(RoomActorMessage::NotifyActorUpdated {
                actor_id,
                actor_owner_user_id,
                version,
                data,
                tactical_sync,
                reply: reply_tx,
            })
            .await
            .map_err(|_| RoomError::ActorClosed)?;
        reply_rx.await.map_err(|_| RoomError::ActorClosed)?
    }

    /// Stages an MCP dry-run command batch in `TableState` and broadcasts `ServerEnvelope::McpStagingProposed` to GMs.
    pub async fn stage_mcp_proposal(
        &self,
        proposal: McpStagingProposal,
    ) -> Result<McpStagingProposal, RoomError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(RoomActorMessage::StageMcpProposal {
                proposal,
                reply: reply_tx,
            })
            .await
            .map_err(|_| RoomError::ActorClosed)?;
        reply_rx.await.map_err(|_| RoomError::ActorClosed)?
    }

    /// Applies `commands` all-or-nothing as one undoable step. The batch is made durable by a
    /// snapshot at the new `seq_id` (a batch is not a single `WalEntry` command), so recovery
    /// never replays half of it.
    pub async fn dispatch_batch(
        &self,
        actor: CommandActor,
        commands: Vec<TrameCommand>,
        description: String,
    ) -> Result<(u64, Vec<TrameEvent>), RoomError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(RoomActorMessage::DispatchBatch {
                actor,
                commands,
                description,
                reply: reply_tx,
            })
            .await
            .map_err(|_| RoomError::ActorClosed)?;
        reply_rx.await.map_err(|_| RoomError::ActorClosed)?
    }

    /// Fans a REST dice roll out to connected clients, projected per recipient.
    pub async fn broadcast_dice_roll(
        &self,
        outcome: crate::dice::DiceRollOutcome,
    ) -> Result<(), RoomError> {
        self.tx
            .send(RoomActorMessage::BroadcastDiceRoll { outcome })
            .await
            .map_err(|_| RoomError::ActorClosed)
    }

    /// Sends revealed handout content to every connected client.
    pub async fn broadcast_handout(
        &self,
        handout: crate::notes::HandoutRevealedBroadcast,
    ) -> Result<(), RoomError> {
        self.tx
            .send(RoomActorMessage::BroadcastHandout { handout })
            .await
            .map_err(|_| RoomError::ActorClosed)
    }

    /// Retrieves a clone of the current `(seq_id, TableState)` from the room actor.
    pub async fn get_table_snapshot(&self) -> Result<(u64, TableState), RoomError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(RoomActorMessage::GetTableSnapshot { reply: reply_tx })
            .await
            .map_err(|_| RoomError::ActorClosed)?;
        reply_rx.await.map_err(|_| RoomError::ActorClosed)
    }
}

/// Authoritative single-campaign actor owning `TableState`, `SeededDiceRoller`, and WAL sequencing.
pub struct TableRoomActor {
    campaign_id: Uuid,
    state: TableState,
    seq_id: u64,
    snapshot_interval: u64,
    last_snapshot_seq: u64,
    last_activity_ms: u64,
    clients: HashMap<Uuid, ConnectedClient>,
    /// `ProjectionHash` of the last state frame sent to each session (invariant 11). Kept in
    /// step with `clients`: an entry exists exactly while its session is connected.
    sent_projection_hashes: HashMap<Uuid, ProjectionHash>,
    dice_roller: SeededDiceRoller,
    wal: Arc<dyn WalStorage>,
    rx: mpsc::Receiver<RoomActorMessage>,
    /// Server-rolled initiative total per non-GM user who asked to roll (`RollDice` whose
    /// reason starts with `"initiative"`, case-insensitive), consumed by the next encounter
    /// start so their tokens keep that result. One entry per user per encounter (SEC3).
    player_initiative_rolls: HashMap<Uuid, i32>,
    /// Monotonic time of the last broadcast `PointerPing` per user, for the throttle. Keyed
    /// by user so extra tabs or reconnects do not multiply the allowance, and kept across
    /// disconnects (one entry per member who pinged); a monotonic clock so a wall-clock jump
    /// can neither lift nor freeze the throttle.
    last_pointer_ping: HashMap<Uuid, tokio::time::Instant>,
    /// Command token bucket per session (`COMMAND_RATE_BURST`), kept in step with `clients`.
    command_buckets: HashMap<Uuid, CommandBucket>,
    /// Every `Player` member of the campaign, connected or not (`set_player_roster`). Hidden
    /// roll privacy counts them so a roll is not public just because a player was offline.
    player_roster: BTreeSet<Uuid>,
    sinks: RoomSinks,
    /// Entries quarantined when this actor recovered (empty on a clean replay); sent to GMs.
    quarantine_notice: Vec<QuarantinedWalSummary>,
    /// Set when storage may hold a write memory does not (failed compensation); the run loop
    /// then closes every socket with `WS_CLOSE_CODE_INTERNAL_ERROR` and ends the actor.
    halted: bool,
}

/// Client-facing reason for a failed envelope. Storage failures get a generic message so
/// database details never reach the wire (SEC15).
fn rejection_reason(err: &RoomError) -> String {
    match err {
        RoomError::CommandRejected(reason) => reason.clone(),
        RoomError::Engine(err) => err.to_string(),
        RoomError::Wal(_) => {
            "storage unavailable: the action was not saved and has not been applied".to_string()
        }
        other => other.to_string(),
    }
}

/// Structured detail of an engine refusal; `None` for server-side refusals.
fn rejection_detail(err: &RoomError) -> Option<RejectionDetail> {
    match err {
        RoomError::Engine(err) => Some(err.rejection_detail()),
        _ => None,
    }
}

/// Unicasts `CommandRejected` to one client.
fn send_rejection(
    tx: &ClientSender,
    reason: String,
    detail: Option<RejectionDetail>,
    correlation_id: Option<String>,
) {
    let out = ServerEnvelope::CommandRejected {
        reason,
        detail,
        correlation_id,
    };
    if let Ok(bytes) = encode_server_envelope(&out) {
        let _ = tx.send(OutboundClientFrame::Binary(bytes));
    }
}

impl TableRoomActor {
    /// Rehydrates `campaign_id` from `wal` (`recover_table_state`), seeds the room's ChaCha20 CSPRNG,
    /// and spawns the asynchronous actor loop with a 256-message bounded mailbox.
    pub fn spawn(
        campaign_id: Uuid,
        wal: Arc<dyn WalStorage>,
        snapshot_interval: u64,
    ) -> Result<TableRoomHandle, RoomError> {
        Self::spawn_with_sinks(campaign_id, wal, snapshot_interval, RoomSinks::default())
    }

    /// Same as `spawn`, forwarding linked vitals and timeline records to `sinks`.
    pub fn spawn_with_sinks(
        campaign_id: Uuid,
        wal: Arc<dyn WalStorage>,
        snapshot_interval: u64,
        sinks: RoomSinks,
    ) -> Result<TableRoomHandle, RoomError> {
        let recovered = recover_table_state(wal.as_ref(), campaign_id)?;
        let seq_id = recovered.seq_id;
        let (tx, rx) = mpsc::channel(256);
        let actor = Self {
            campaign_id,
            state: recovered.state,
            seq_id,
            snapshot_interval: snapshot_interval.max(1),
            last_snapshot_seq: seq_id,
            last_activity_ms: now_ms(),
            clients: HashMap::new(),
            sent_projection_hashes: HashMap::new(),
            dice_roller: SeededDiceRoller::from_os_csprng(),
            wal,
            rx,
            player_initiative_rolls: HashMap::new(),
            last_pointer_ping: HashMap::new(),
            command_buckets: HashMap::new(),
            player_roster: BTreeSet::new(),
            sinks,
            quarantine_notice: recovered
                .quarantined
                .iter()
                .map(QuarantinedWalSummary::from)
                .collect(),
            halted: false,
        };
        tokio::spawn(actor.run());
        Ok(TableRoomHandle { campaign_id, tx })
    }

    async fn run(mut self) {
        while let Some(msg) = self.rx.recv().await {
            self.prune_closed_clients();
            match msg {
                RoomActorMessage::ConnectClient { client, reply } => {
                    self.last_activity_ms = now_ms();
                    let projected = project_state_for_recipient(
                        self.campaign_id,
                        &self.state,
                        client.user_id,
                        client.role,
                    );
                    let hash = projection_hash(&projected);
                    let snapshot_env = ServerEnvelope::StateSnapshot {
                        seq_id: self.seq_id,
                        state: projected,
                    };
                    if let Ok(bytes) = encode_server_envelope(&snapshot_env) {
                        let _ = client.tx.send(OutboundClientFrame::Binary(bytes));
                        if let Some(hash) = hash {
                            self.sent_projection_hashes.insert(client.session_id, hash);
                        }
                    }
                    if client.role == CampaignRole::Gm && !self.quarantine_notice.is_empty() {
                        let notice = ServerEnvelope::WalEntriesQuarantined {
                            entries: self.quarantine_notice.clone(),
                        };
                        if let Ok(bytes) = encode_server_envelope(&notice) {
                            let _ = client.tx.send(OutboundClientFrame::Binary(bytes));
                        }
                    }
                    self.clients.insert(client.session_id, client);
                    let _ = reply.send(Ok(()));
                }
                RoomActorMessage::DisconnectClient { session_id } => {
                    self.clients.remove(&session_id);
                    self.forget_departed_sessions();
                    self.last_activity_ms = now_ms();
                }
                RoomActorMessage::SetPlayerRoster { players } => {
                    self.player_roster = players.into_iter().collect();
                }
                RoomActorMessage::EvictUser { user_id, reply } => {
                    let before = self.clients.len();
                    self.clients.retain(|_, client| {
                        if client.user_id != user_id {
                            return true;
                        }
                        let _ = client.tx.send(OutboundClientFrame::Close {
                            code: WS_CLOSE_CODE_MEMBERSHIP_REVOKED,
                            reason: "Membership Revoked".to_string(),
                        });
                        false
                    });
                    self.forget_departed_sessions();
                    let _ = reply.send(before - self.clients.len());
                }
                RoomActorMessage::HandleEnvelope {
                    session_id,
                    envelope,
                    reply,
                } => {
                    let res = self.process_client_envelope(session_id, envelope);
                    let _ = reply.send(res);
                }
                RoomActorMessage::QueryMetrics { reply } => {
                    let _ = reply.send(RoomMetrics {
                        campaign_id: self.campaign_id,
                        seq_id: self.seq_id,
                        active_connections: self.clients.len(),
                        last_activity_ms: self.last_activity_ms,
                    });
                }
                RoomActorMessage::Hibernate { reply } => {
                    // 1. Broadcast Close frame 1001 Going Away to all connected clients
                    for client in self.clients.values() {
                        let _ = client.tx.send(OutboundClientFrame::Close {
                            code: WS_CLOSE_CODE_GOING_AWAY,
                            reason: WS_CLOSE_REASON_GOING_AWAY.to_string(),
                        });
                    }
                    self.clients.clear();

                    // 2. Flush uncommitted state to storage
                    let res = self
                        .flush_snapshot()
                        .map(|()| self.seq_id)
                        .map_err(RoomError::Wal);
                    let _ = reply.send(res);
                    break;
                }
                RoomActorMessage::DispatchDirectCommand {
                    actor,
                    command,
                    reply,
                } => {
                    self.last_activity_ms = now_ms();
                    let res = self.execute_and_broadcast_command(actor, command);
                    let _ = reply.send(res);
                }
                RoomActorMessage::NotifyActorUpdated {
                    actor_id,
                    actor_owner_user_id,
                    version,
                    data,
                    tactical_sync,
                    reply,
                } => {
                    self.last_activity_ms = now_ms();
                    let updated_tokens = self.apply_actor_tactical_sync(
                        actor_id,
                        actor_owner_user_id,
                        version,
                        data,
                        tactical_sync,
                    );
                    // Tactical sync bypasses the WAL command stream, so persist it as a
                    // snapshot or a restart would resurrect the stale token fields. The
                    // sheet itself is already stored, so a failed snapshot is only logged.
                    if updated_tokens > 0 {
                        self.flush_snapshot_best_effort();
                        self.push_changed_projections();
                    }
                    let _ = reply.send(Ok(updated_tokens));
                }
                RoomActorMessage::DispatchBatch {
                    actor,
                    commands,
                    description,
                    reply,
                } => {
                    self.last_activity_ms = now_ms();
                    let res = self.execute_and_broadcast_batch(actor, commands, description);
                    let _ = reply.send(res);
                }
                RoomActorMessage::BroadcastDiceRoll { outcome } => {
                    self.last_activity_ms = now_ms();
                    self.fan_out_roll(&outcome);
                }
                RoomActorMessage::BroadcastHandout { handout } => {
                    self.last_activity_ms = now_ms();
                    if let Ok(bytes) =
                        encode_server_envelope(&ServerEnvelope::HandoutRevealed(handout))
                    {
                        for client in self.clients.values() {
                            let _ = client.tx.send(OutboundClientFrame::Binary(bytes.clone()));
                        }
                    }
                }
                RoomActorMessage::StageMcpProposal {
                    mut proposal,
                    reply,
                } => {
                    self.last_activity_ms = now_ms();
                    if let Err(reason) = proposal
                        .commands
                        .iter_mut()
                        .try_for_each(crate::statblock::normalize_command)
                    {
                        let _ = reply.send(Err(RoomError::CommandRejected(reason)));
                        continue;
                    }
                    let entry = WalEntry {
                        seq_id: self.seq_id + 1,
                        campaign_id: self.campaign_id,
                        timestamp_ms: self.last_activity_ms,
                        actor_user_id: Uuid::nil(),
                        role: CampaignRole::Gm,
                        command: WalRecord::McpStaging {
                            mcp_staging_proposal: proposal.clone(),
                        },
                        events: Vec::new(),
                    };
                    if let Err(err) = self.wal.append_entry(entry) {
                        tracing::error!(campaign_id = %self.campaign_id, error = %err, "WAL append failed; staging rejected");
                        self.discard_ambiguous_append();
                        let _ = reply.send(Err(RoomError::Wal(err)));
                        if self.halted {
                            self.close_all_and_halt();
                            break;
                        }
                        continue;
                    }
                    self.seq_id += 1;
                    self.state
                        .data
                        .mcp_staging_proposals
                        .insert(proposal.proposal_id, proposal.clone());
                    self.maybe_periodic_snapshot();
                    let out = ServerEnvelope::McpStagingProposed {
                        proposal: proposal.clone(),
                    };
                    if let Ok(bytes) = encode_server_envelope(&out) {
                        for client in self.clients.values() {
                            if client.role == CampaignRole::Gm {
                                let _ = client.tx.send(OutboundClientFrame::Binary(bytes.clone()));
                            }
                        }
                    }
                    self.push_changed_projections();
                    let _ = reply.send(Ok(proposal));
                }
                RoomActorMessage::GetTableSnapshot { reply } => {
                    let _ = reply.send((self.seq_id, self.state.clone()));
                }
            }
            if self.halted {
                self.close_all_and_halt();
                break;
            }
        }
    }

    /// Closes every socket with `WS_CLOSE_CODE_INTERNAL_ERROR` before the run loop ends, so
    /// clients reconnect to the actor supervision wakes from storage (RT9).
    fn close_all_and_halt(&mut self) {
        tracing::error!(campaign_id = %self.campaign_id, seq_id = self.seq_id, "room actor halted: storage may hold an unacknowledged write; reloading from storage");
        for client in self.clients.values() {
            let _ = client.tx.send(OutboundClientFrame::Close {
                code: WS_CLOSE_CODE_INTERNAL_ERROR,
                reason: "Room Restarting".to_string(),
            });
        }
        self.clients.clear();
    }

    /// Drops every session whose socket task is gone (`ClientSender::is_closed`, the state in
    /// which `send` returns `OutboundSendError::Closed`). Runs before each mailbox message, so
    /// a session whose attach timed out or whose `DisconnectClient` was lost cannot pin
    /// `active_connections` above zero and block `Idle-Lease` hibernation.
    fn prune_closed_clients(&mut self) {
        let before = self.clients.len();
        self.clients.retain(|_, client| !client.tx.is_closed());
        if self.clients.len() != before {
            self.forget_departed_sessions();
            self.last_activity_ms = now_ms();
        }
    }

    /// Removes per-session bookkeeping (`sent_projection_hashes`, `command_buckets`) of
    /// sessions no longer in `clients`.
    fn forget_departed_sessions(&mut self) {
        let clients = &self.clients;
        self.sent_projection_hashes
            .retain(|session_id, _| clients.contains_key(session_id));
        self.command_buckets
            .retain(|session_id, _| clients.contains_key(session_id));
    }

    /// Spends one token of `session_id`'s command bucket; `false` when it is empty.
    fn take_command_token(&mut self, session_id: Uuid) -> bool {
        let now = tokio::time::Instant::now();
        self.command_buckets
            .entry(session_id)
            .or_insert_with(|| CommandBucket::full(now))
            .try_take(now)
    }

    /// Sends a `StateSnapshot` at the current `seq_id` to every session whose projection
    /// changed since the last state frame it was sent (invariant 11), for state changes made
    /// outside the command stream (sheet tactical sync, MCP staging). Clients accept a
    /// `StateSnapshot` whatever its `seq_id`, so the unchanged `seq_id` of a sheet sync is
    /// still applied.
    fn push_changed_projections(&mut self) {
        for client in self.clients.values() {
            let projected = project_state_for_recipient(
                self.campaign_id,
                &self.state,
                client.user_id,
                client.role,
            );
            let hash = projection_hash(&projected);
            if hash.is_some()
                && self.sent_projection_hashes.get(&client.session_id) == hash.as_ref()
            {
                continue;
            }
            let out = ServerEnvelope::StateSnapshot {
                seq_id: self.seq_id,
                state: projected,
            };
            if let Ok(bytes) = encode_server_envelope(&out) {
                let _ = client.tx.send(OutboundClientFrame::Binary(bytes));
                match hash {
                    Some(hash) => self.sent_projection_hashes.insert(client.session_id, hash),
                    None => self.sent_projection_hashes.remove(&client.session_id),
                };
            }
        }
    }

    /// Compensates an append whose outcome is unknown: deletes every stored entry after
    /// `self.seq_id` (the one that may have been committed, and anything a retry left). When
    /// the delete fails as well, storage may hold the rejected command, so the actor halts.
    fn discard_ambiguous_append(&mut self) {
        if let Err(err) = self
            .wal
            .discard_entries_from(self.campaign_id, self.seq_id + 1)
        {
            tracing::error!(campaign_id = %self.campaign_id, seq_id = self.seq_id, error = %err, "could not discard a possibly committed WAL entry");
            self.halted = true;
        }
    }

    fn process_client_envelope(
        &mut self,
        session_id: Uuid,
        envelope: ClientEnvelope,
    ) -> Result<(), RoomError> {
        let Some(sender) = self.clients.get(&session_id) else {
            return Ok(());
        };
        let actor_user_id = sender.user_id;
        let actor_role = sender.role;
        let sender_tx = sender.tx.clone();

        let rate_limited = match &envelope {
            ClientEnvelope::SubmitCommand(submission) => Some(submission.correlation_id.clone()),
            ClientEnvelope::RollDice { correlation_id, .. } => Some(correlation_id.clone()),
            _ => None,
        }
        .filter(|_| !self.take_command_token(session_id));
        if let Some(correlation_id) = rate_limited {
            let limited = trame_engine::commands::CommandError::RateLimited;
            send_rejection(
                &sender_tx,
                limited.to_string(),
                Some(limited.rejection_detail()),
                correlation_id,
            );
            return Ok(());
        }

        match envelope {
            ClientEnvelope::SubmitCommand(submission) => {
                self.last_activity_ms = now_ms();
                let actor = CommandActor {
                    user_id: actor_user_id,
                    role: actor_role,
                };
                let crate::sync::CommandSubmission {
                    command,
                    correlation_id,
                } = *submission;
                if let Err(err) = self.execute_and_broadcast_command(actor, command) {
                    send_rejection(
                        &sender_tx,
                        rejection_reason(&err),
                        rejection_detail(&err),
                        correlation_id,
                    );
                }
            }
            ClientEnvelope::RollDice {
                expression,
                visibility,
                reason,
                correlation_id,
            } => {
                self.last_activity_ms = now_ms();
                let is_player_initiative = actor_role != CampaignRole::Gm
                    && reason
                        .trim_start()
                        .to_ascii_lowercase()
                        .starts_with("initiative");
                let rolled = if is_player_initiative {
                    self.roll_player_initiative(actor_user_id)
                        .map(|(token_id, outcome)| (Some(token_id), outcome))
                } else {
                    self.dice_roller
                        .roll(actor_user_id, &expression, visibility, reason)
                        .map(|outcome| (None, outcome))
                        .map_err(|err| err.to_string())
                };
                match rolled {
                    Ok((token_id, outcome)) => {
                        match token_id {
                            Some(token_id) => self.fan_out_initiative_roll(token_id, &outcome),
                            None => self.fan_out_roll(&outcome),
                        }
                        self.note_timeline(roll_timeline_note(self.campaign_id, &outcome));
                    }
                    Err(reason) => send_rejection(&sender_tx, reason, None, correlation_id),
                }
            }
            ClientEnvelope::PointerPing {
                pos,
                color_hex,
                scene_id,
            } => {
                if let Err(reason) = validate_pointer_ping(&self.state, &pos, &color_hex, scene_id)
                {
                    send_rejection(&sender_tx, reason, None, None);
                    return Ok(());
                }
                let now = tokio::time::Instant::now();
                let min_interval = Duration::from_millis(POINTER_PING_MIN_INTERVAL_MS);
                if self
                    .last_pointer_ping
                    .get(&actor_user_id)
                    .is_some_and(|last| now.duration_since(*last) < min_interval)
                {
                    return Ok(());
                }
                self.last_pointer_ping.insert(actor_user_id, now);
                self.last_activity_ms = now_ms();
                let out = ServerEnvelope::PointerPingBroadcast {
                    sender_user_id: actor_user_id,
                    pos,
                    color_hex,
                };
                if let Ok(bytes) = encode_server_envelope(&out) {
                    for client in self.clients.values() {
                        let _ = client.tx.send(OutboundClientFrame::Binary(bytes.clone()));
                    }
                }
            }
            ClientEnvelope::Ping { client_time_ms } => {
                // Note: ClientEnvelope::Ping MUST NOT update `self.last_activity_ms` so idle
                // heartbeat frames do not defeat the 15-minute Idle-Lease hibernation sweep.
                let out = ServerEnvelope::Pong {
                    client_time_ms,
                    server_time_ms: now_ms(),
                };
                if let Ok(bytes) = encode_server_envelope(&out) {
                    let _ = sender_tx.send(OutboundClientFrame::Binary(bytes));
                }
            }
        }
        Ok(())
    }

    /// Evaluates `AuthoritativeInitiativeRoll` when entering `TurnByTurn` mode with an empty `initiative_order`,
    /// applies the command to `self.state`, persists to WAL, and broadcasts `CommandAccepted` to all clients.
    fn execute_and_broadcast_command(
        &mut self,
        actor: CommandActor,
        mut cmd: TrameCommand,
    ) -> Result<(u64, Vec<TrameEvent>), RoomError> {
        self.authorize_command(&actor, &cmd)
            .map_err(RoomError::CommandRejected)?;
        crate::statblock::normalize_command(&mut cmd).map_err(RoomError::CommandRejected)?;
        let checkpoint = self.state.clone();
        let initiative_checkpoint = self.player_initiative_rolls.clone();
        let prior_mode = self.state.data.mode;
        let (resolved_cmd, initiative_rolls) = self.resolve_authoritative_initiative(&actor, cmd);
        let (resolved_cmd, death_save_roll) = self
            .resolve_death_save_roll(&actor, resolved_cmd)
            .map_err(RoomError::CommandRejected)?;
        let (resolved_cmd, concentration_roll) = self
            .resolve_action_rolls(&actor, resolved_cmd)
            .map_err(RoomError::CommandRejected)?;
        let prior_vitals = self.linked_vitals();
        let is_undo = matches!(resolved_cmd, TrameCommand::UndoLastAction);
        let persisted = match self.state.apply_command(&actor, resolved_cmd.clone()) {
            Err(err) => Err(RoomError::Engine(err)),
            Ok(events) if is_undo => self.persist_snapshot_at(self.seq_id + 1).map(|()| events),
            Ok(events) => self
                .wal
                .append_entry(WalEntry {
                    seq_id: self.seq_id + 1,
                    campaign_id: self.campaign_id,
                    timestamp_ms: self.last_activity_ms,
                    actor_user_id: actor.user_id,
                    role: actor.role,
                    command: resolved_cmd.into(),
                    events: events.clone(),
                })
                .map(|()| events)
                .map_err(RoomError::Wal),
        };
        let events = match persisted {
            Ok(events) => events,
            Err(err) => {
                self.state = checkpoint;
                self.player_initiative_rolls = initiative_checkpoint;
                if let RoomError::Wal(wal_err) = &err {
                    tracing::error!(campaign_id = %self.campaign_id, error = %wal_err, "WAL append failed; command rolled back");
                    if !is_undo {
                        self.discard_ambiguous_append();
                    }
                }
                return Err(err);
            }
        };
        self.seq_id += 1;
        self.forget_initiative_on_mode_change(prior_mode);
        if !is_undo {
            self.maybe_periodic_snapshot();
        }
        for (token_id, outcome) in &initiative_rolls {
            self.fan_out_initiative_roll(*token_id, outcome);
            self.note_timeline(roll_timeline_note(self.campaign_id, outcome));
        }
        if let Some((token_id, outcome)) = &death_save_roll {
            self.fan_out_initiative_roll(*token_id, outcome);
            self.note_timeline(roll_timeline_note(self.campaign_id, outcome));
        }
        if let Some((token_id, outcome)) = &concentration_roll {
            self.fan_out_initiative_roll(*token_id, outcome);
            self.note_timeline(roll_timeline_note(self.campaign_id, outcome));
        }
        self.after_accepted(&events, &checkpoint, &prior_vitals);
        Ok((self.seq_id, events))
    }

    /// Fills the server rolls of `ResolveAction` and `RollConcentrationCheck` (invariant 10),
    /// replacing whatever the client sent. The Concentration roll is returned with its token
    /// for fan-out after commit: `GmOnly`, so only the GM and the token's controller get it
    /// (the `ConcentrationCheckRolled` audience); resolution rolls are never fanned out.
    /// Unknown tokens or a missing check pass through so the engine reports them.
    fn resolve_action_rolls(
        &mut self,
        actor: &CommandActor,
        cmd: TrameCommand,
    ) -> Result<(TrameCommand, Option<InitiativeRoll>), String> {
        match cmd {
            TrameCommand::ResolveAction { request, .. } => {
                let resolution = crate::resolution::fill_action_resolution(
                    &self.state,
                    actor,
                    &request,
                    &mut self.dice_roller,
                )?;
                Ok((
                    TrameCommand::ResolveAction {
                        request,
                        resolution: Some(Box::new(resolution)),
                    },
                    None,
                ))
            }
            TrameCommand::RollConcentrationCheck {
                token_id,
                roll_mode,
                ..
            } => {
                let pending = self
                    .state
                    .data
                    .pending_concentration_checks
                    .get(&token_id)
                    .and_then(|dcs| dcs.first().copied());
                let (Some(token), Some(dc)) = (self.state.data.tokens.get(&token_id), pending)
                else {
                    return Ok((
                        TrameCommand::RollConcentrationCheck {
                            token_id,
                            roll_mode,
                            roll: None,
                        },
                        None,
                    ));
                };
                let bonus = crate::resolution::server_save_bonus(token, "con");
                let reason = format!("Concentration check (DC {dc}): {}", token.name);
                // Same audience as `ConcentrationCheckRolled` (sync.rs invariant 8): the GM
                // and the token's controller, through `fan_out_initiative_roll`.
                let outcome = self
                    .dice_roller
                    .roll(
                        actor.user_id,
                        &crate::resolution::d20_expression(roll_mode, bonus),
                        RollVisibility::GmOnly,
                        reason,
                    )
                    .map_err(|err| err.to_string())?;
                let (d20_rolls, _) = crate::resolution::d20s_of(&outcome, roll_mode);
                Ok((
                    TrameCommand::RollConcentrationCheck {
                        token_id,
                        roll_mode,
                        roll: Some(trame_engine::resolution::ConcentrationRoll {
                            d20_rolls,
                            total: outcome.total,
                        }),
                    },
                    Some((token_id, outcome)),
                ))
            }
            other => Ok((other, None)),
        }
    }

    /// Server-rolled `RecordDeathSave` d20, like `AuthoritativeInitiativeRoll`: a player's
    /// submitted value is ignored and `1d20` (`2d20kh1` with a synced Survivor feature,
    /// `resolution::death_save_roll_mode`) minus `2 * effective_exhaustion` is rolled for
    /// them, forwarding the kept natural d20 face (`1..=20`) to `RecordDeathSave` so natural
    /// `1` and natural `20` retain their unmodified SRD 5.2.1 rules; a Game Master may enter a
    /// physical die result or leave `d20` empty to have it rolled. The roll is broadcast only
    /// after the command commits, with the initiative privacy rule (`GmOnly` when some player
    /// cannot see the token) and the initiative fan-out (`fan_out_initiative_roll`), so the
    /// token's controller always sees their own death save. Unknown tokens pass through so
    /// the engine reports `NotFound`.
    fn resolve_death_save_roll(
        &mut self,
        actor: &CommandActor,
        cmd: TrameCommand,
    ) -> Result<(TrameCommand, Option<(Uuid, DiceRollOutcome)>), String> {
        let TrameCommand::RecordDeathSave { token_id, d20 } = cmd else {
            return Ok((cmd, None));
        };
        if actor.role == CampaignRole::Gm && d20.is_some() {
            return Ok((TrameCommand::RecordDeathSave { token_id, d20 }, None));
        }
        let Some(token) = self.state.data.tokens.get(&token_id) else {
            return Ok((
                TrameCommand::RecordDeathSave {
                    token_id,
                    d20: None,
                },
                None,
            ));
        };
        let visibility = initiative_roll_visibility(token, &self.player_views());
        let reason = format!("Death Saving Throw: {}", token.name);
        let mode = trame_engine::resolution::death_save_roll_mode(token);
        let expr = death_save_expression(mode, token.effective_exhaustion());
        let outcome = self
            .dice_roller
            .roll(actor.user_id, &expr, visibility, reason)
            .map_err(|err| err.to_string())?;
        let (_, kept_d20) = crate::resolution::d20s_of(&outcome, mode);
        Ok((
            TrameCommand::RecordDeathSave {
                token_id,
                d20: Some(kept_d20),
            },
            Some((token_id, outcome)),
        ))
    }

    /// Applies an atomic batch (`TableState::apply_batch`). Durability comes from a snapshot at
    /// the bumped `seq_id` instead of a `WalEntry`, because the WAL replays single commands; if
    /// that snapshot fails, the batch is rolled back and rejected. `RecordDeathSave` d20s are
    /// resolved like single commands (`resolve_death_save_roll`) and fanned out after commit.
    fn execute_and_broadcast_batch(
        &mut self,
        actor: CommandActor,
        commands: Vec<TrameCommand>,
        description: String,
    ) -> Result<(u64, Vec<TrameEvent>), RoomError> {
        let mut resolved = Vec::with_capacity(commands.len());
        let mut death_save_rolls = Vec::new();
        for mut cmd in commands {
            if matches!(
                cmd,
                TrameCommand::ResolveAction { .. } | TrameCommand::RollConcentrationCheck { .. }
            ) {
                return Err(RoomError::CommandRejected(
                    "invalid configuration: server-rolled commands cannot be batched".to_string(),
                ));
            }
            self.authorize_command(&actor, &cmd)
                .map_err(RoomError::CommandRejected)?;
            crate::statblock::normalize_command(&mut cmd).map_err(RoomError::CommandRejected)?;
            let (cmd, roll) = self
                .resolve_death_save_roll(&actor, cmd)
                .map_err(RoomError::CommandRejected)?;
            death_save_rolls.extend(roll);
            resolved.push(cmd);
        }
        let commands = resolved;
        let checkpoint = self.state.clone();
        let prior_mode = self.state.data.mode;
        let prior_vitals = self.linked_vitals();
        let persisted = match self.state.apply_batch(&actor, commands, description) {
            Err(err) => Err(RoomError::Engine(err)),
            Ok(events) => self.persist_snapshot_at(self.seq_id + 1).map(|()| events),
        };
        let events = match persisted {
            Ok(events) => events,
            Err(err) => {
                self.state = checkpoint;
                return Err(err);
            }
        };
        self.seq_id += 1;
        self.forget_initiative_on_mode_change(prior_mode);
        for (token_id, outcome) in &death_save_rolls {
            self.fan_out_initiative_roll(*token_id, outcome);
            self.note_timeline(roll_timeline_note(self.campaign_id, outcome));
        }
        self.after_accepted(&events, &checkpoint, &prior_vitals);
        Ok((self.seq_id, events))
    }

    /// Drops every stored player initiative roll when a committed change moved the table into
    /// or out of `TurnByTurn`, whichever path supplied the order (auto-roll, explicit order,
    /// batch, undo), so a roll never leaks into a later encounter.
    fn forget_initiative_on_mode_change(&mut self, prior_mode: TableMode) {
        let was_turn_by_turn = prior_mode == TableMode::TurnByTurn;
        let is_turn_by_turn = self.state.data.mode == TableMode::TurnByTurn;
        if was_turn_by_turn != is_turn_by_turn {
            self.player_initiative_rolls.clear();
        }
    }

    /// Writes the current state as the snapshot for `seq_id` (the durability step of undo and
    /// batches). Does not advance `self.seq_id`; the caller does once this succeeds.
    fn persist_snapshot_at(&mut self, seq_id: u64) -> Result<(), RoomError> {
        let snap = TableStateSnapshot::capture(
            self.campaign_id,
            seq_id,
            self.last_activity_ms,
            &self.state,
        );
        match self.wal.save_snapshot(snap) {
            Ok(()) => {
                self.last_snapshot_seq = seq_id;
                Ok(())
            }
            Err(err) => {
                tracing::error!(campaign_id = %self.campaign_id, seq_id, error = %err, "durability snapshot failed; command rolled back");
                Err(RoomError::Wal(err))
            }
        }
    }

    /// Write-behind snapshot every `snapshot_interval` commands. Best effort (RT5): the
    /// command is already durable in the WAL.
    fn maybe_periodic_snapshot(&mut self) {
        if self.seq_id - self.last_snapshot_seq >= self.snapshot_interval {
            self.flush_snapshot_best_effort();
        }
    }

    fn flush_snapshot_best_effort(&mut self) {
        if let Err(err) = self.flush_snapshot() {
            tracing::warn!(campaign_id = %self.campaign_id, seq_id = self.seq_id, error = %err, "write-behind snapshot failed; WAL still holds the commands");
        }
    }

    /// Post-commit fan-out shared by single commands and batches: per-recipient
    /// `CommandAccepted` (events filtered against `prior`, the table before the command),
    /// linked vitals persistence, and initiative timeline records.
    ///
    /// A recipient whose filtered events are empty and whose `ProjectionHash` equals the one
    /// of the last state frame it was sent gets nothing (invariant 11, RT12).
    fn after_accepted(
        &mut self,
        events: &[TrameEvent],
        prior: &TableState,
        prior_vitals: &LinkedVitalsMap,
    ) {
        for client in self.clients.values() {
            let filtered_events = filter_events_for_recipient(
                &self.state,
                prior,
                events,
                client.user_id,
                client.role,
            );
            let projected_state = project_state_for_recipient(
                self.campaign_id,
                &self.state,
                client.user_id,
                client.role,
            );
            let hash = projection_hash(&projected_state);
            let unchanged = hash.is_some()
                && self.sent_projection_hashes.get(&client.session_id) == hash.as_ref();
            if unchanged && filtered_events.is_empty() {
                continue;
            }
            let out = ServerEnvelope::CommandAccepted {
                seq_id: self.seq_id,
                events: filtered_events,
                state: projected_state,
            };
            if let Ok(bytes) = encode_server_envelope(&out) {
                let _ = client.tx.send(OutboundClientFrame::Binary(bytes));
                match hash {
                    Some(hash) => self.sent_projection_hashes.insert(client.session_id, hash),
                    None => self.sent_projection_hashes.remove(&client.session_id),
                };
            }
        }
        self.forward_linked_vitals(prior_vitals);
        for ev in events {
            if let TrameEvent::TableModeChanged {
                mode: TableMode::TurnByTurn,
                ..
            }
            | TrameEvent::InitiativeUpdated { .. } = ev
            {
                let order = &self.state.data.initiative_order;
                let views = self.player_views();
                let entries: Vec<serde_json::Value> = order
                    .iter()
                    .filter_map(|id| self.state.data.tokens.get(id))
                    .map(|t| {
                        serde_json::json!({
                            "token_id": t.id,
                            "name": t.name,
                            "total": self.state.data.initiative_totals.get(&t.id),
                            "hidden": initiative_roll_visibility(t, &views) != RollVisibility::Public,
                        })
                    })
                    .collect();
                let any_hidden = entries
                    .iter()
                    .any(|e| e["hidden"].as_bool().unwrap_or(false));
                let mut payload = serde_json::json!({ "seq_id": self.seq_id, "order": entries });
                if any_hidden {
                    payload["visibility"] = serde_json::json!("gm");
                }
                self.note_timeline(TimelineNote {
                    campaign_id: self.campaign_id,
                    event_type: "initiative".to_string(),
                    payload,
                });
            }
        }
    }

    /// Server-side authority checks layered on top of `TableState::apply_command` (G6):
    /// - `ApplyDamage.raw_damage` must lie in `0..=MAX_RAW_DAMAGE` so engine damage
    ///   multipliers (vulnerability doubling) can never overflow `i32`.
    /// - Non-GM actors may only damage tokens they control (`owner_user_id`).
    /// - Non-GM actors must send `DamageAffinity::Normal`. Typed damage (`damage_type`) is the
    ///   player path: the engine derives the affinity from the target's server-side
    ///   `damage_resistances` / `damage_immunities` / `damage_vulnerabilities` (A68), so a
    ///   client-chosen `Immune` / `Resistant` can never let a player shrug off damage.
    /// - `HealActor.amount` is bounded like damage (`0..=MAX_RAW_DAMAGE`).
    /// - `ActivateScene` must carry the server-resolved payload; the WebSocket and MCP paths
    ///   overwrite whatever the client sent with the stored scene before dispatch.
    /// - Every other new command (`ClearAoe`, `RefundAction`, `RevealHandout`,
    ///   `SetInitiativeTotal`, `ResolveReaction`) relies on the engine's RBAC (GM or token
    ///   controller), which runs before any state change.
    fn authorize_command(&self, actor: &CommandActor, cmd: &TrameCommand) -> Result<(), String> {
        if let TrameCommand::HealActor { amount, .. } = cmd
            && !(0..=MAX_RAW_DAMAGE).contains(amount)
        {
            return Err(format!(
                "invalid configuration: amount must be within 0..={MAX_RAW_DAMAGE}"
            ));
        }
        if let TrameCommand::ActivateScene { scene: None, .. } = cmd {
            return Err("invalid configuration: scene payload was not resolved".to_string());
        }
        if let TrameCommand::ApplyResolution {
            adjustment: Some(adjustment),
            ..
        } = cmd
        {
            if adjustment
                .damage
                .is_some_and(|d| !(0..=MAX_RAW_DAMAGE).contains(&d))
            {
                return Err(format!(
                    "invalid configuration: damage must be within 0..={MAX_RAW_DAMAGE}"
                ));
            }
            if adjustment
                .damage_type
                .as_deref()
                .is_some_and(|t| !t.is_empty() && !crate::statblock::DAMAGE_TYPES.contains(&t))
            {
                return Err(
                    "invalid configuration: damage type is not an SRD damage type".to_string(),
                );
            }
        }
        if let TrameCommand::ApplyDamage {
            token_id,
            raw_damage,
            affinity,
            ..
        } = cmd
        {
            if !(0..=MAX_RAW_DAMAGE).contains(raw_damage) {
                return Err(format!(
                    "invalid configuration: raw_damage must be within 0..={MAX_RAW_DAMAGE}"
                ));
            }
            if actor.role != CampaignRole::Gm {
                let controls_target = self
                    .state
                    .data
                    .tokens
                    .get(token_id)
                    .is_some_and(|t| t.owner_user_id == Some(actor.user_id));
                if !controls_target {
                    return Err(
                        "permission denied: players may only apply damage to tokens they control"
                            .to_string(),
                    );
                }
                if *affinity != DamageAffinity::Normal {
                    return Err(
                        "permission denied: only the GM may apply a damage affinity".to_string()
                    );
                }
            }
        }
        Ok(())
    }

    /// Rolls `1d20 + initiative bonus` for each active combatant token on the table when
    /// `StartTurnByTurn` or `SetTableMode { mode: TurnByTurn }` is submitted by a GM with an
    /// empty `initiative_order`. The roll outcomes are returned, not broadcast: the caller fans
    /// them out only once the command has committed, so a rejected command leaks nothing.
    fn resolve_authoritative_initiative(
        &mut self,
        actor: &CommandActor,
        cmd: TrameCommand,
    ) -> (TrameCommand, Vec<InitiativeRoll>) {
        if actor.role != CampaignRole::Gm || self.state.data.tokens.is_empty() {
            return (cmd, Vec::new());
        }

        match cmd {
            TrameCommand::StartTurnByTurn {
                ref initiative_order,
                ..
            } if initiative_order.is_empty() => {
                let (initiative_order, initiative_totals, rolls) =
                    self.roll_table_initiative(actor.user_id);
                (
                    TrameCommand::StartTurnByTurn {
                        initiative_order,
                        initiative_totals,
                    },
                    rolls,
                )
            }
            TrameCommand::SetTableMode {
                mode: TableMode::TurnByTurn,
                exploration_paused,
                ref initiative_order,
                ..
            } if initiative_order.is_empty() => {
                let (initiative_order, initiative_totals, rolls) =
                    self.roll_table_initiative(actor.user_id);
                (
                    TrameCommand::SetTableMode {
                        mode: TableMode::TurnByTurn,
                        exploration_paused,
                        initiative_order,
                        initiative_totals,
                    },
                    rolls,
                )
            }
            other => (other, Vec::new()),
        }
    }

    /// Server-side initiative for a player who asked to roll (SEC3): whatever expression they
    /// sent is ignored and `1d20 + initiative bonus` is rolled for their owned non-dead token
    /// (living tokens with `hp > 0` first, then lowest id). Rejected when they own no non-dead
    /// token, already rolled for the coming encounter, or one of their tokens is already in the
    /// running encounter's order.
    fn roll_player_initiative(&mut self, user_id: Uuid) -> Result<InitiativeRoll, String> {
        let views = self.player_views();
        let owned: Vec<&trame_engine::commands::TokenState> = self
            .state
            .data
            .tokens
            .values()
            .filter(|t| t.owner_user_id == Some(user_id))
            .collect();
        if self.player_initiative_rolls.contains_key(&user_id)
            || owned
                .iter()
                .any(|t| self.state.data.initiative_order.contains(&t.id))
        {
            return Err("initiative already rolled for this encounter".to_string());
        }
        let Some(token) = owned
            .into_iter()
            .filter(|t| !t.is_dead)
            .min_by_key(|t| (t.hp <= 0 || t.is_dead, t.id))
        else {
            return Err("permission denied: no token to roll initiative for".to_string());
        };
        let visibility = initiative_roll_visibility(token, &views);
        let token_id = token.id;
        let expr = initiative_expression(token);
        let reason = format!("Initiative: {}", token.name);
        let outcome = self
            .dice_roller
            .roll(user_id, &expr, visibility, reason)
            .map_err(|err| err.to_string())?;
        self.player_initiative_rolls.insert(user_id, outcome.total);
        Ok((token_id, outcome))
    }

    /// Combatants some player cannot see (`initiative_roll_visibility`) are rolled with
    /// `RollVisibility::GmOnly` so their names and results never reach other players through
    /// the initiative feed or the timeline. Dead tokens (`is_dead == true`, including
    /// Exhaustion-6 corpses with `hp > 0`) are excluded.
    /// Tokens whose owner already had initiative rolled (`player_initiative_rolls`) reuse that
    /// total and are not re-rolled; the stored rolls are consumed.
    /// Returns the sorted order, each token's total (fed to `initiative_totals`), and the roll
    /// outcomes still to be broadcast.
    fn roll_table_initiative(
        &mut self,
        actor_user_id: Uuid,
    ) -> (Vec<Uuid>, BTreeMap<Uuid, i32>, Vec<InitiativeRoll>) {
        type Candidate = (Uuid, String, i32, String, RollVisibility, Option<Uuid>);
        let views = self.player_views();
        let to_candidate = |t: &trame_engine::commands::TokenState| -> Candidate {
            (
                t.id,
                t.name.clone(),
                t.dex_mod,
                initiative_expression(t),
                initiative_roll_visibility(t, &views),
                t.owner_user_id,
            )
        };
        let combatants: Vec<Candidate> = self
            .state
            .data
            .tokens
            .values()
            .filter(|t| t.hp > 0 && !t.is_dead)
            .map(to_candidate)
            .collect();

        let candidates: Vec<Candidate> = if combatants.is_empty() {
            self.state
                .data
                .tokens
                .values()
                .filter(|t| !t.is_dead)
                .map(to_candidate)
                .collect()
        } else {
            combatants
        };

        let self_rolls = std::mem::take(&mut self.player_initiative_rolls);
        let mut rolled: Vec<(i32, i32, Uuid)> = Vec::with_capacity(candidates.len());
        let mut outcomes = Vec::new();
        for (token_id, token_name, dex_mod, expr, visibility, owner) in candidates {
            if let Some(total) = owner.and_then(|o| self_rolls.get(&o)) {
                rolled.push((*total, dex_mod, token_id));
                continue;
            }
            let reason = format!("Initiative: {token_name}");
            if let Ok(outcome) = self
                .dice_roller
                .roll(actor_user_id, &expr, visibility, reason)
            {
                rolled.push((outcome.total, dex_mod, token_id));
                outcomes.push((token_id, outcome));
            }
        }

        // Sort descending by total roll, tie-breaking descending by dex_mod, then ascending by token_id
        rolled.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| b.1.cmp(&a.1))
                .then_with(|| a.2.cmp(&b.2))
        });

        let totals = rolled.iter().map(|(total, _, id)| (*id, *total)).collect();
        let order = rolled.into_iter().map(|(_, _, id)| id).collect();
        (order, totals, outcomes)
    }

    /// Line of sight (`visible_token_ids_for_recipient`) of every player who could read an
    /// initiative roll or its timeline record: the controllers of tokens on the table, every
    /// `Player` member of the campaign (`player_roster`, connected or not, since the timeline
    /// is read later), and the connected players. A player with no token sees nothing, so
    /// their presence makes every roll `GmOnly`. Spectators control nothing and are left out,
    /// so they cannot hide every roll.
    fn player_views(&self) -> Vec<HashSet<Uuid>> {
        let mut players: BTreeSet<Uuid> = self
            .state
            .data
            .tokens
            .values()
            .filter_map(|t| t.owner_user_id)
            .collect();
        players.extend(self.player_roster.iter().copied());
        players.extend(
            self.clients
                .values()
                .filter(|c| c.role == CampaignRole::Player)
                .map(|c| c.user_id),
        );
        players
            .into_iter()
            .map(|user_id| {
                visible_token_ids_for_recipient(&self.state, user_id, CampaignRole::Player)
            })
            .collect()
    }

    /// Sends an initiative roll for `token_id` like `fan_out_roll`, except that the token's
    /// controller always receives it in full, as its roller would.
    fn fan_out_initiative_roll(&self, token_id: Uuid, outcome: &DiceRollOutcome) {
        let controller = self
            .state
            .data
            .tokens
            .get(&token_id)
            .and_then(|t| t.owner_user_id);
        for client in self.clients.values() {
            let viewer = if controller == Some(client.user_id) {
                outcome.roller_user_id
            } else {
                client.user_id
            };
            if let Some(projected_roll) = project_roll_for_recipient(outcome, viewer, client.role) {
                let out = ServerEnvelope::DiceRolled(projected_roll);
                if let Ok(bytes) = encode_server_envelope(&out) {
                    let _ = client.tx.send(OutboundClientFrame::Binary(bytes));
                }
            }
        }
    }

    /// Sends `outcome` to every connected client through `project_roll_for_recipient`.
    fn fan_out_roll(&self, outcome: &DiceRollOutcome) {
        for client in self.clients.values() {
            if let Some(projected_roll) =
                project_roll_for_recipient(outcome, client.user_id, client.role)
            {
                let out = ServerEnvelope::DiceRolled(projected_roll);
                if let Ok(bytes) = encode_server_envelope(&out) {
                    let _ = client.tx.send(OutboundClientFrame::Binary(bytes));
                }
            }
        }
    }

    fn note_timeline(&self, note: TimelineNote) {
        if let Some(tx) = &self.sinks.timeline {
            let _ = tx.send(note);
        }
    }

    /// `LinkedVitals` of every actor-linked token, keyed by `(token_id, actor_id)`.
    fn linked_vitals(&self) -> LinkedVitalsMap {
        self.state
            .data
            .tokens
            .values()
            .filter_map(|t| {
                t.actor_id.map(|a| {
                    let vitals = LinkedVitals {
                        hp: t.hp,
                        temp_hp: t.temp_hp,
                        death_save_successes: t.death_save_successes,
                        death_save_failures: t.death_save_failures,
                        is_stable: t.is_stable,
                        is_dead: t.is_dead,
                        conditions: t.conditions.clone(),
                    };
                    ((t.id, a), vitals)
                })
            })
            .collect()
    }

    /// Forwards linked tokens whose vitals differ from `before` to the vitals sink. Diffing
    /// (rather than matching damage events) also covers undo, batches, and staged commits;
    /// tokens absent from `before` (just spawned from the sheet) are not echoed back.
    /// Conditions are only forwarded when they changed, so an hp change never rewrites a
    /// sheet's conditions from a token that was spawned without them.
    fn forward_linked_vitals(&self, before: &LinkedVitalsMap) {
        let Some(tx) = &self.sinks.vitals else {
            return;
        };
        for ((token_id, actor_id), vitals) in self.linked_vitals() {
            let Some(prev) = before.get(&(token_id, actor_id)) else {
                continue;
            };
            if *prev != vitals {
                let _ = tx.send(LinkedVitalsChange {
                    campaign_id: self.campaign_id,
                    actor_id,
                    hp: vitals.hp,
                    temp_hp: vitals.temp_hp,
                    death_save_successes: vitals.death_save_successes,
                    death_save_failures: vitals.death_save_failures,
                    is_stable: vitals.is_stable,
                    is_dead: vitals.is_dead,
                    conditions: (prev.conditions != vitals.conditions).then_some(vitals.conditions),
                });
            }
        }
    }

    /// Synchronizes tactical fields onto every `LinkedActorToken` (`token.actor_id == Some(actor_id)`)
    /// without pushing to `undo_stack`; synthetic tokens are never touched even when their
    /// `token.id` happens to equal `actor_id`. When a sheet save brings a linked token to death
    /// (for example reaching Exhaustion level `6` or `3` death save failures), mirrors that new
    /// vitals state (`is_dead`) back onto the sheet via `forward_linked_vitals`. Then broadcasts
    /// `ServerEnvelope::ActorUpdated` strictly to `CampaignRole::Gm` and to the persistent
    /// actor's owning `CampaignRole::Player` (`actor_owner_user_id`) when they control a linked
    /// token on the live table, stripping `data["statBlock"]` for non-GM recipients (`ADR-0037`,
    /// `sync.rs` Invariant 6) while leaving unspawned `ActorsTab` edits to REST
    /// `expected_version` `409 VERSION_CONFLICT` optimistic locking.
    fn apply_actor_tactical_sync(
        &mut self,
        actor_id: Uuid,
        actor_owner_user_id: Option<Uuid>,
        version: u64,
        data: serde_json::Value,
        sync: ActorTacticalSync,
    ) -> usize {
        let before = self.linked_vitals();
        let mut updated_count = 0usize;
        let mut sheet_owners: Vec<Uuid> = Vec::new();
        let mode = self.state.data.mode;
        for token in self.state.data.tokens.values_mut() {
            if token.actor_id == Some(actor_id) {
                if let Some(owner) = token.owner_user_id {
                    sheet_owners.push(owner);
                }
                let prev_dead = token.is_dead;
                sync.apply_to_token(token, mode);
                if token.is_dead && !prev_dead {
                    token.concentrating = false;
                    if let Some(aoe_id) = token.concentrating_on_aoe_id.take() {
                        self.state.data.persistent_aoes.remove(&aoe_id);
                    }
                }
                updated_count += 1;
            }
        }
        // Sheet conditions can incapacitate a concentrating caster outside the command
        // stream; the next projection carries the ended concentration.
        self.state.end_incapacitated_concentration();

        // Only forward back to storage when a sheet-derived transition newly killed the token
        // while the stored sheet had not yet marked `isDead` / `deathSaves.isDead`: ordinary
        // sheet edits (`hp`, `conditions`, `deathSaves`) already come from `data`.
        let sheet_already_dead = data
            .get("isDead")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
            || data
                .pointer("/deathSaves/isDead")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
        if !sheet_already_dead
            && self
                .state
                .data
                .tokens
                .values()
                .any(|t| t.actor_id == Some(actor_id) && t.is_dead)
        {
            self.forward_linked_vitals(&before);
        }

        // Full sheets carry HP/AC/saves, so non-GMs receive `ActorUpdated` only at the
        // intersection of persistent sheet ownership (`actor_owner_user_id`) and active linked
        // token control on the live table (`sheet_owners`): unspawned `ActorsTab` edits never
        // overwrite a player's `SessionState.actors` version before their REST `PUT` (preserving
        // `409 VERSION_CONFLICT`), while Spectators and players controlling GM-owned NPC/Monster
        // tokens never receive `ActorUpdated` (token controllers still get redacted `TokenState`
        // via `push_changed_projections`). Strip `statBlock` for non-GMs as defense-in-depth
        // (`sync.rs` Invariant 6).
        let has_gm = self.clients.values().any(|c| c.role == CampaignRole::Gm);
        let has_owner_player = actor_owner_user_id.is_some_and(|owner_id| {
            sheet_owners.contains(&owner_id)
                && self
                    .clients
                    .values()
                    .any(|c| c.role == CampaignRole::Player && c.user_id == owner_id)
        });
        let player_bytes = if has_owner_player {
            let mut redacted = data.clone();
            if let Some(obj) = redacted.as_object_mut() {
                obj.remove("statBlock");
            }
            encode_server_envelope(&ServerEnvelope::ActorUpdated {
                actor_id,
                version,
                data: redacted,
            })
            .ok()
        } else {
            None
        };
        let gm_bytes = if has_gm {
            encode_server_envelope(&ServerEnvelope::ActorUpdated {
                actor_id,
                version,
                data,
            })
            .ok()
        } else {
            None
        };
        for client in self.clients.values() {
            let bytes = if client.role == CampaignRole::Gm {
                gm_bytes.as_ref()
            } else if client.role == CampaignRole::Player
                && actor_owner_user_id == Some(client.user_id)
                && sheet_owners.contains(&client.user_id)
            {
                player_bytes.as_ref()
            } else {
                None
            };
            if let Some(bytes) = bytes {
                let _ = client.tx.send(OutboundClientFrame::Binary(bytes.clone()));
            }
        }

        updated_count
    }

    fn flush_snapshot(&mut self) -> Result<(), WalError> {
        let snap = TableStateSnapshot::capture(
            self.campaign_id,
            self.seq_id,
            self.last_activity_ms,
            &self.state,
        );
        self.wal.save_snapshot(snap)?;
        self.last_snapshot_seq = self.seq_id;
        Ok(())
    }
}

/// Manages active `TableRoomActor` instances and enforces the `Idle-Lease` and scale-to-zero hibernation policy.
pub struct RoomLeaseManager {
    rooms: Arc<RwLock<HashMap<Uuid, TableRoomHandle>>>,
    wal: Arc<dyn WalStorage>,
    snapshot_interval: u64,
    idle_timeout_ms: u64,
    sinks: std::sync::Mutex<RoomSinks>,
}

/// Default `Idle-Lease`: rooms with no connection and no activity for 15 minutes hibernate.
pub const DEFAULT_IDLE_TIMEOUT_MS: u64 = 15 * 60 * 1000;

/// Whole SIGTERM shutdown (`RoomLeaseManager::shutdown_all`): 8 s, leaving 2 s of Cloud Run's
/// 10 s grace for the HTTP server to stop and the process to exit before `SIGKILL`.
pub const SHUTDOWN_BUDGET: Duration = Duration::from_secs(8);

/// Time given to socket writers, after every room hibernated, to send their queued `1001`
/// close frames (`ms`). Part of `SHUTDOWN_BUDGET`.
pub const SOCKET_FLUSH_GRACE: Duration = Duration::from_millis(500);

impl RoomLeaseManager {
    /// Creates a new `RoomLeaseManager` backed by `wal`, taking write-behind snapshots every
    /// `snapshot_interval` commands and hibernating zero-connection rooms after `idle_timeout_ms` (`ms`).
    pub fn new(wal: Arc<dyn WalStorage>, snapshot_interval: u64, idle_timeout_ms: u64) -> Self {
        Self {
            rooms: Arc::new(RwLock::new(HashMap::new())),
            wal,
            snapshot_interval,
            idle_timeout_ms,
            sinks: std::sync::Mutex::new(RoomSinks::default()),
        }
    }

    /// Installs the storage sinks handed to rooms woken from now on.
    pub fn set_sinks(&self, sinks: RoomSinks) {
        if let Ok(mut guard) = self.sinks.lock() {
            *guard = sinks;
        }
    }

    /// Spawns the `Idle-Lease` sweeper: every `period` it calls `sweep_idle_rooms`, which
    /// hibernates (final snapshot + close 1001) rooms idle for `idle_timeout_ms` with no
    /// connections. Latency `Ping`s do not refresh activity, so idle tabs cannot pin a room.
    pub fn spawn_idle_sweeper(self: &Arc<Self>, period: Duration) -> tokio::task::JoinHandle<()> {
        let mgr = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(period);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let hibernated = mgr.sweep_idle_rooms(now_ms()).await;
                if !hibernated.is_empty() {
                    tracing::info!(rooms = ?hibernated, "idle-lease sweep hibernated rooms");
                }
            }
        })
    }

    /// Gets an active room handle or wakes a hibernated room transparently from WAL storage.
    pub async fn get_or_wake_room(&self, campaign_id: Uuid) -> Result<TableRoomHandle, RoomError> {
        if IS_SHUTTING_DOWN.load(Ordering::Acquire) {
            return Err(RoomError::ShuttingDown);
        }

        {
            let guard = self.rooms.read().await;
            if let Some(handle) = guard.get(&campaign_id)
                && !handle.tx.is_closed()
            {
                return Ok(handle.clone());
            }
        }

        let mut guard = self.rooms.write().await;
        if let Some(handle) = guard.get(&campaign_id)
            && !handle.tx.is_closed()
        {
            return Ok(handle.clone());
        }

        if IS_SHUTTING_DOWN.load(Ordering::Acquire) {
            return Err(RoomError::ShuttingDown);
        }

        let sinks = self.sinks.lock().map(|g| g.clone()).unwrap_or_default();
        let handle = TableRoomActor::spawn_with_sinks(
            campaign_id,
            self.wal.clone(),
            self.snapshot_interval,
            sinks,
        )?;
        guard.insert(campaign_id, handle.clone());
        self.supervise(handle.clone());
        Ok(handle)
    }

    /// Removes `handle` from the registry once its actor task ends (RT9). A newer handle
    /// registered for the same campaign in the meantime is left alone.
    fn supervise(&self, handle: TableRoomHandle) {
        let rooms = Arc::clone(&self.rooms);
        tokio::spawn(async move {
            handle.tx.closed().await;
            let mut guard = rooms.write().await;
            if guard
                .get(&handle.campaign_id)
                .is_some_and(|current| current.tx.same_channel(&handle.tx))
            {
                guard.remove(&handle.campaign_id);
                tracing::info!(campaign_id = %handle.campaign_id, "room actor ended; handle removed");
            }
        });
    }

    /// Returns the active room handle for `campaign_id` if currently awake in memory without waking it.
    pub async fn get_active_room(&self, campaign_id: Uuid) -> Option<TableRoomHandle> {
        self.rooms.read().await.get(&campaign_id).cloned()
    }

    /// Returns the number of campaign rooms currently awake in memory.
    pub async fn active_room_count(&self) -> usize {
        self.rooms.read().await.len()
    }

    /// Commands all active `TableRoomHandle` actors to hibernate within a timeout (default 10 seconds),
    /// broadcasting close code 1001 to all clients and flushing uncommitted state to storage.
    pub async fn hibernate_all(&self, timeout: Duration) -> Result<Vec<Uuid>, RoomError> {
        let active: Vec<(Uuid, TableRoomHandle)> = {
            let mut guard = self.rooms.write().await;
            guard.drain().collect()
        };

        let hibernation_future = async {
            let mut hibernated = Vec::with_capacity(active.len());
            for (campaign_id, handle) in active {
                if handle.hibernate().await.is_ok() {
                    hibernated.push(campaign_id);
                }
            }
            hibernated
        };

        match tokio::time::timeout(timeout, hibernation_future).await {
            Ok(hibernated) => Ok(hibernated),
            Err(_) => Err(RoomError::Timeout),
        }
    }

    /// SIGTERM path: `hibernate_all` within `SHUTDOWN_BUDGET - SOCKET_FLUSH_GRACE`, then, when
    /// any room was awake, waits `SOCKET_FLUSH_GRACE` so socket writers can deliver the queued
    /// `1001` close frames before the process exits. The whole call stays within
    /// `SHUTDOWN_BUDGET`, below Cloud Run's 10 s SIGTERM grace.
    pub async fn shutdown_all(&self) -> Result<Vec<Uuid>, RoomError> {
        let had_rooms = self.active_room_count().await > 0;
        let result = self
            .hibernate_all(SHUTDOWN_BUDGET.saturating_sub(SOCKET_FLUSH_GRACE))
            .await;
        if had_rooms {
            tokio::time::sleep(SOCKET_FLUSH_GRACE).await;
        }
        result
    }

    /// Sweeps all rooms and hibernates any room with `0` active connections whose idle duration
    /// (`current_time_ms - last_activity_ms`) meets or exceeds `self.idle_timeout_ms` (in `ms`),
    /// flushing a compacted snapshot and freeing RAM.
    pub async fn sweep_idle_rooms(&self, current_time_ms: u64) -> Vec<Uuid> {
        let candidates: Vec<(Uuid, TableRoomHandle)> = {
            let guard = self.rooms.read().await;
            guard.iter().map(|(id, h)| (*id, h.clone())).collect()
        };

        let mut hibernated = Vec::new();
        for (campaign_id, handle) in candidates {
            if let Ok(metrics) = handle.metrics().await
                && metrics.active_connections == 0
                && current_time_ms.saturating_sub(metrics.last_activity_ms) >= self.idle_timeout_ms
            {
                let mut guard = self.rooms.write().await;
                if guard.remove(&campaign_id).is_some() && handle.hibernate().await.is_ok() {
                    hibernated.push(campaign_id);
                }
            }
        }

        hibernated
    }
}

/// Timeline record of a dice roll; anything but a `Public` roll is GM-only in the timeline.
pub fn roll_timeline_note(
    campaign_id: Uuid,
    outcome: &crate::dice::DiceRollOutcome,
) -> TimelineNote {
    let mut payload = serde_json::json!({
        "roll_id": outcome.roll_id,
        "roller_user_id": outcome.roller_user_id,
        "expression": outcome.expression,
        "reason": outcome.reason,
        "total": outcome.total,
        "is_critical_success": outcome.is_critical_success,
        "is_critical_failure": outcome.is_critical_failure,
    });
    if outcome.visibility != RollVisibility::Public {
        payload["visibility"] = serde_json::json!("gm");
    }
    TimelineNote {
        campaign_id,
        event_type: "dice_roll".to_string(),
        payload,
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
