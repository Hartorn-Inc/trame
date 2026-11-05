//! ============================================================================
//! WRITE-AHEAD LOG (WAL), SNAPSHOT RECOVERY & ENTRY QUARANTINE (wal.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Defines the persistence seam (`WalStorage`) and deterministic crash-recovery
//! pipeline (`recover_table_state`) that guarantee zero data loss when a
//! `TableRoomActor` hibernates under the `Idle-Lease` policy or recovers from an
//! unexpected process restart (`04-RUNTIME-AND-DEDICATED-HOSTING.md`). Recovery
//! never refuses to open a campaign because of one bad entry: the entry and
//! every later one become `QuarantinedWalEntry` records (ADR-0040, D4).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Monotonic Sequence Replay`:
//!      - Every `WalEntry` carries a strictly increasing `seq_id`. During
//!        `recover_table_state`, only entries with `entry.seq_id > snapshot_seq_id`
//!        are replayed in order onto the base `TableStateSnapshot`.
//!   2. `BVH Reconstruction on Snapshot Load`:
//!      - `recover_table_state` immediately rebuilds `state.bvh` from
//!        `snap.data.walls` before replaying trailing `WalEntry` commands so
//!        that any movement or door command in the WAL tail evaluates against
//!        the exact spatial index.
//!   3. `Quarantine Instead of Lock-Out (D4)`:
//!      - Each entry is applied to a clone of the state; a failing entry leaves
//!        the last good state untouched. That entry and every later one are
//!        moved atomically to quarantine (`WalStorage::quarantine_entries`),
//!        never replayed again, and reported in `RecoveredTable::quarantined`.
//!        Later entries are quarantined too because they were validated against
//!        a state that included the failing one.
//!      - The sequence counter resumes after the highest quarantined `seq_id`,
//!        so sequence numbers seen by clients never repeat, and a fresh snapshot
//!        is written at that sequence. A failed fresh snapshot is logged only:
//!        the good entries stay in the WAL and replay again on the next wake.
//!   4. `Fail-Closed Storage Errors`:
//!      - Poisoned locks, unreadable snapshots, and a failed quarantine move
//!        still abort room initialization rather than serving a state whose
//!        provenance is unknown.
//!   5. `Two Record Kinds`:
//!      - `WalRecord::Command` replays through `TableState::apply_command`;
//!        `WalRecord::McpStaging` re-inserts a staged MCP proposal (RT3). The
//!        record is untagged on the wire so entries written before staging was
//!        logged (`"command": {"cmd": ...}`) still deserialize.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `recover_table_state(storage, campaign_id)`
//!     ├── 1. Load latest `TableStateSnapshot` (or `TableState::default()` at `seq_id = 0`).
//!     ├── 2. Rebuild `Bvh2D` from snapshot wall segments.
//!     ├── 3. Query `storage.load_entries_after(campaign_id, snapshot_seq_id)`.
//!     ├── 4. Replay each `WalEntry.command` on a clone; commit the clone on success.
//!     ├── 5. On the first failure: quarantine it and every later entry, then
//!     │      write a fresh snapshot at the highest quarantined `seq_id`.
//!     └── 6. Return `RecoveredTable { state, seq_id, quarantined }`.
//! ============================================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use thiserror::Error;
use trame_engine::commands::{
    CampaignRole, CommandActor, McpStagingProposal, TableSnapshotData, TableState, TrameCommand,
    TrameEvent,
};
use trame_engine::geometry::Bvh2D;
use uuid::Uuid;

/// Errors returned by `WalStorage` implementations and `recover_table_state`.
#[derive(Debug, Error)]
pub enum WalError {
    /// An internal `RwLock` protecting in-memory WAL structures was poisoned by a thread panic.
    #[error("Storage lock poisoned")]
    LockPoisoned,
    /// Snapshot or WAL entry serialization/deserialization failed.
    #[error("Serialization failure: {0}")]
    Serialization(String),
    /// Replaying a historical `WalEntry` onto `TableState` failed during recovery.
    #[error("Replay error at seq_id {seq_id}: {reason}")]
    ReplayFailed {
        /// Sequence number (`seq_id`) of the entry that failed to apply.
        seq_id: u64,
        /// Underlying `CommandError` message.
        reason: String,
    },
}

/// Payload of a `WalEntry`: what recovery re-applies for that sequence number.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WalRecord {
    /// Tabletop command replayed through `TableState::apply_command`.
    Command(Box<TrameCommand>),
    /// MCP staging proposal re-inserted into `mcp_staging_proposals` (RT3).
    McpStaging {
        /// Proposal exactly as it was staged.
        mcp_staging_proposal: McpStagingProposal,
    },
}

impl WalRecord {
    /// Short label naming the record (`TrameCommand` tag such as `"MOVE_TOKEN"`, or
    /// `"MCP_STAGING"`) for logs and the Game Master quarantine banner.
    pub fn kind(&self) -> String {
        match self {
            WalRecord::McpStaging { .. } => "MCP_STAGING".to_string(),
            WalRecord::Command(cmd) => serde_json::to_value(cmd)
                .ok()
                .and_then(|v| v.get("cmd").and_then(|c| c.as_str()).map(str::to_string))
                .unwrap_or_else(|| "UNKNOWN".to_string()),
        }
    }
}

impl From<TrameCommand> for WalRecord {
    fn from(cmd: TrameCommand) -> Self {
        WalRecord::Command(Box::new(cmd))
    }
}

/// Immutable Write-Ahead Log record representing a single committed `TrameCommand` and its emitted events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalEntry {
    /// Monotonically increasing per-campaign sequence identifier (`>= 1`).
    pub seq_id: u64,
    /// Campaign room UUID to which this entry belongs.
    pub campaign_id: Uuid,
    /// Unix epoch timestamp in milliseconds (`ms`) when the command was committed.
    pub timestamp_ms: u64,
    /// User UUID of the actor who submitted the command.
    pub actor_user_id: Uuid,
    /// Campaign role held by the actor when the command was executed.
    pub role: CampaignRole,
    /// Authoritative payload replayed during crash recovery.
    pub command: WalRecord,
    /// Resulting domain events emitted when the command was originally applied.
    pub events: Vec<TrameEvent>,
}

/// WAL entry set aside because it, or an earlier entry of the same recovery, failed to
/// replay (`GLOSSARY.md`, ADR-0040). Kept for inspection and never replayed automatically.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuarantinedWalEntry {
    /// Campaign the entry belonged to.
    pub campaign_id: Uuid,
    /// Original `WalEntry::seq_id`.
    pub seq_id: u64,
    /// Command label (`WalRecord::kind`), e.g. `"UNDO_LAST_ACTION"` or `"MCP_STAGING"`.
    pub command_kind: String,
    /// Full serialized `WalEntry` (JSON) as it was stored.
    pub payload: serde_json::Value,
    /// Replay error for the failing entry; for later entries, a note naming the failing `seq_id`.
    pub error: String,
    /// Unix epoch timestamp in milliseconds (`ms`) when the entry was quarantined.
    pub quarantined_at_ms: u64,
}

/// Compacted point-in-time checkpoint of a campaign's `TableSnapshotData` at `snapshot_seq_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableStateSnapshot {
    /// Campaign room UUID.
    pub campaign_id: Uuid,
    /// Highest `WalEntry::seq_id` incorporated into this snapshot (`0` for initial seed snapshots).
    pub snapshot_seq_id: u64,
    /// Unix epoch timestamp in milliseconds (`ms`) when the snapshot was captured.
    pub captured_at_ms: u64,
    /// Grid cell size in canvas pixels (`px`).
    pub cell_size_px: f64,
    /// Tactical distance per grid cell in feet (`ft`).
    pub feet_per_cell: f64,
    /// Complete serializable tabletop state (tokens, walls, initiative, lighting, persistent AoEs).
    pub data: TableSnapshotData,
}

impl TableStateSnapshot {
    /// Captures `state` as the checkpoint for `seq_id` of `campaign_id`.
    pub fn capture(
        campaign_id: Uuid,
        seq_id: u64,
        captured_at_ms: u64,
        state: &TableState,
    ) -> Self {
        Self {
            campaign_id,
            snapshot_seq_id: seq_id,
            captured_at_ms,
            cell_size_px: state.cell_size_px,
            feet_per_cell: state.feet_per_cell,
            data: state.data.clone(),
        }
    }
}

/// Write-Ahead Log & Write-Behind Snapshot storage seam (`04-RUNTIME-AND-DEDICATED-HOSTING.md`).
pub trait WalStorage: Send + Sync {
    /// Appends a committed `WalEntry` to durable storage before broadcasting to clients.
    fn append_entry(&self, entry: WalEntry) -> Result<(), WalError>;
    /// Persists a compacted `TableStateSnapshot` checkpoint for `snapshot.campaign_id`.
    fn save_snapshot(&self, snapshot: TableStateSnapshot) -> Result<(), WalError>;
    /// Loads the most recent `TableStateSnapshot` for `campaign_id`, or `None` if no snapshot exists yet.
    fn load_latest_snapshot(
        &self,
        campaign_id: Uuid,
    ) -> Result<Option<TableStateSnapshot>, WalError>;
    /// Loads all `WalEntry` records for `campaign_id` with `seq_id > after_seq_id` in ascending order.
    fn load_entries_after(
        &self,
        campaign_id: Uuid,
        after_seq_id: u64,
    ) -> Result<Vec<WalEntry>, WalError>;
    /// Atomically stores `entries` as quarantined and removes every WAL entry of
    /// `campaign_id` with `seq_id >= from_seq_id`. Either both happen or neither does.
    fn quarantine_entries(
        &self,
        campaign_id: Uuid,
        from_seq_id: u64,
        entries: Vec<QuarantinedWalEntry>,
    ) -> Result<(), WalError>;
    /// Lists every quarantined entry of `campaign_id`, ordered by `seq_id` then quarantine time.
    fn list_quarantined_entries(
        &self,
        campaign_id: Uuid,
    ) -> Result<Vec<QuarantinedWalEntry>, WalError>;
}

/// Thread-safe in-memory implementation of `WalStorage` for local development, testing, and single-binary hosting.
#[derive(Default, Clone)]
pub struct InMemoryWalStorage {
    snapshots: Arc<RwLock<HashMap<Uuid, TableStateSnapshot>>>,
    entries: Arc<RwLock<HashMap<Uuid, Vec<WalEntry>>>>,
    quarantined: Arc<RwLock<HashMap<Uuid, Vec<QuarantinedWalEntry>>>>,
}

impl InMemoryWalStorage {
    /// Creates an empty `InMemoryWalStorage` store.
    pub fn new() -> Self {
        Self::default()
    }
}

impl WalStorage for InMemoryWalStorage {
    fn append_entry(&self, entry: WalEntry) -> Result<(), WalError> {
        let mut guard = self.entries.write().map_err(|_| WalError::LockPoisoned)?;
        guard.entry(entry.campaign_id).or_default().push(entry);
        Ok(())
    }

    fn save_snapshot(&self, snapshot: TableStateSnapshot) -> Result<(), WalError> {
        let mut guard = self.snapshots.write().map_err(|_| WalError::LockPoisoned)?;
        guard.insert(snapshot.campaign_id, snapshot);
        Ok(())
    }

    fn load_latest_snapshot(
        &self,
        campaign_id: Uuid,
    ) -> Result<Option<TableStateSnapshot>, WalError> {
        let guard = self.snapshots.read().map_err(|_| WalError::LockPoisoned)?;
        Ok(guard.get(&campaign_id).cloned())
    }

    fn load_entries_after(
        &self,
        campaign_id: Uuid,
        after_seq_id: u64,
    ) -> Result<Vec<WalEntry>, WalError> {
        let guard = self.entries.read().map_err(|_| WalError::LockPoisoned)?;
        let list = guard
            .get(&campaign_id)
            .map(|entries| {
                entries
                    .iter()
                    .filter(|e| e.seq_id > after_seq_id)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        Ok(list)
    }

    fn quarantine_entries(
        &self,
        campaign_id: Uuid,
        from_seq_id: u64,
        entries: Vec<QuarantinedWalEntry>,
    ) -> Result<(), WalError> {
        let mut wal = self.entries.write().map_err(|_| WalError::LockPoisoned)?;
        let mut quarantined = self
            .quarantined
            .write()
            .map_err(|_| WalError::LockPoisoned)?;
        if let Some(list) = wal.get_mut(&campaign_id) {
            list.retain(|e| e.seq_id < from_seq_id);
        }
        quarantined.entry(campaign_id).or_default().extend(entries);
        Ok(())
    }

    fn list_quarantined_entries(
        &self,
        campaign_id: Uuid,
    ) -> Result<Vec<QuarantinedWalEntry>, WalError> {
        let guard = self
            .quarantined
            .read()
            .map_err(|_| WalError::LockPoisoned)?;
        let mut list = guard.get(&campaign_id).cloned().unwrap_or_default();
        list.sort_by_key(|e| (e.seq_id, e.quarantined_at_ms));
        Ok(list)
    }
}

/// Outcome of `recover_table_state`: the state the room opens at and what was set aside.
#[derive(Debug)]
pub struct RecoveredTable {
    /// Last good tabletop state.
    pub state: TableState,
    /// Sequence counter the room resumes from (`>=` every replayed or quarantined `seq_id`).
    pub seq_id: u64,
    /// Entries quarantined by this recovery, in `seq_id` order (empty on a clean replay).
    pub quarantined: Vec<QuarantinedWalEntry>,
}

/// Applies one WAL record to `state`, returning the replay error message on failure.
fn replay_record(state: &mut TableState, entry: &WalEntry) -> Result<(), String> {
    match &entry.command {
        WalRecord::Command(cmd) => {
            let actor = CommandActor {
                user_id: entry.actor_user_id,
                role: entry.role,
            };
            state
                .apply_command(&actor, (**cmd).clone())
                .map(|_| ())
                .map_err(|err| err.to_string())
        }
        WalRecord::McpStaging {
            mcp_staging_proposal,
        } => {
            state.data.mcp_staging_proposals.insert(
                mcp_staging_proposal.proposal_id,
                mcp_staging_proposal.clone(),
            );
            Ok(())
        }
    }
}

/// Rehydrates a campaign's authoritative `TableState` by loading the newest
/// `TableStateSnapshot` and replaying every later `WalEntry`, quarantining the first
/// failing entry and all entries after it (see the module banner).
pub fn recover_table_state(
    storage: &dyn WalStorage,
    campaign_id: Uuid,
) -> Result<RecoveredTable, WalError> {
    let (mut state, mut seq_id) = match storage.load_latest_snapshot(campaign_id)? {
        Some(snap) => {
            let bvh = Bvh2D::build(snap.data.walls.clone());
            let mut st = TableState::new(snap.cell_size_px, snap.feet_per_cell, Vec::new());
            st.data = snap.data;
            st.bvh = bvh;
            (st, snap.snapshot_seq_id)
        }
        None => (TableState::default(), 0),
    };

    let trailing = storage.load_entries_after(campaign_id, seq_id)?;
    for (index, entry) in trailing.iter().enumerate() {
        let mut candidate = state.clone();
        match replay_record(&mut candidate, entry) {
            Ok(()) => {
                state = candidate;
                seq_id = entry.seq_id;
            }
            Err(reason) => {
                let quarantined =
                    quarantine_tail(storage, campaign_id, &trailing[index..], &reason)?;
                seq_id = quarantined.last().map_or(seq_id, |q| q.seq_id.max(seq_id));
                let snapshot =
                    TableStateSnapshot::capture(campaign_id, seq_id, crate::room::now_ms(), &state);
                if let Err(err) = storage.save_snapshot(snapshot) {
                    tracing::warn!(%campaign_id, seq_id, error = %err, "post-quarantine snapshot failed");
                }
                tracing::warn!(
                    %campaign_id,
                    failed_seq_id = entry.seq_id,
                    quarantined = quarantined.len(),
                    %reason,
                    "WAL replay failed; entries quarantined"
                );
                return Ok(RecoveredTable {
                    state,
                    seq_id,
                    quarantined,
                });
            }
        }
    }

    Ok(RecoveredTable {
        state,
        seq_id,
        quarantined: Vec::new(),
    })
}

/// Moves `tail` (the failing entry first) into quarantine and returns the stored records.
fn quarantine_tail(
    storage: &dyn WalStorage,
    campaign_id: Uuid,
    tail: &[WalEntry],
    reason: &str,
) -> Result<Vec<QuarantinedWalEntry>, WalError> {
    let Some(first) = tail.first() else {
        return Ok(Vec::new());
    };
    let now = crate::room::now_ms();
    let records = tail
        .iter()
        .map(|entry| {
            let payload =
                serde_json::to_value(entry).map_err(|e| WalError::Serialization(e.to_string()))?;
            let error = if entry.seq_id == first.seq_id {
                reason.to_string()
            } else {
                format!("follows failed entry {}", first.seq_id)
            };
            Ok(QuarantinedWalEntry {
                campaign_id,
                seq_id: entry.seq_id,
                command_kind: entry.command.kind(),
                payload,
                error,
                quarantined_at_ms: now,
            })
        })
        .collect::<Result<Vec<_>, WalError>>()?;
    storage.quarantine_entries(campaign_id, first.seq_id, records.clone())?;
    Ok(records)
}
