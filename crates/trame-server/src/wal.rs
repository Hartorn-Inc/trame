//! ============================================================================
//! WRITE-AHEAD LOG (WAL) & WRITE-BEHIND SNAPSHOT RECOVERY (wal.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Defines the persistence seam (`WalStorage`) and deterministic crash-recovery
//! pipeline (`recover_table_state`) that guarantee zero data loss when a
//! `TableRoomActor` hibernates under the `Idle-Lease` policy or recovers from an
//! unexpected process restart (`04-RUNTIME-AND-DEDICATED-HOSTING.md`).
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
//!   3. `Fail-Closed Poison & Replay Detection`:
//!      - Poisoned storage locks (`WalError::LockPoisoned`) or deterministic
//!        command replay failures (`WalError::ReplayFailed`) abort room
//!        initialization rather than serving corrupted campaign state.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `recover_table_state(storage, campaign_id)`
//!     ├── 1. Load latest `TableStateSnapshot` (or initialize `TableState::default()` at `seq_id = 0`).
//!     ├── 2. Rebuild `Bvh2D` from snapshot wall segments.
//!     ├── 3. Query `storage.load_entries_after(campaign_id, snapshot_seq_id)`.
//!     ├── 4. Replay each trailing `WalEntry.command` via `state.apply_command(...)`.
//!     └── 5. Return rehydrated `(TableState, latest_seq_id)`.
//! ============================================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use thiserror::Error;
use trame_engine::commands::{
    CampaignRole, CommandActor, TableSnapshotData, TableState, TrameCommand, TrameEvent,
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
    /// Authoritative command payload replayed during crash recovery.
    pub command: TrameCommand,
    /// Resulting domain events emitted when the command was originally applied.
    pub events: Vec<TrameEvent>,
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
}

/// Thread-safe in-memory implementation of `WalStorage` for local development, testing, and single-binary hosting.
#[derive(Default, Clone)]
pub struct InMemoryWalStorage {
    snapshots: Arc<RwLock<HashMap<Uuid, TableStateSnapshot>>>,
    entries: Arc<RwLock<HashMap<Uuid, Vec<WalEntry>>>>,
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
}

/// Rehydrates a campaign's authoritative `TableState` and latest `seq_id` by loading the newest
/// `TableStateSnapshot` and deterministically replaying all subsequent `WalEntry` records.
pub fn recover_table_state(
    storage: &dyn WalStorage,
    campaign_id: Uuid,
) -> Result<(TableState, u64), WalError> {
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
    for entry in trailing {
        let actor = CommandActor {
            user_id: entry.actor_user_id,
            role: entry.role,
        };
        state
            .apply_command(&actor, entry.command)
            .map_err(|err| WalError::ReplayFailed {
                seq_id: entry.seq_id,
                reason: err.to_string(),
            })?;
        seq_id = entry.seq_id;
    }

    Ok((state, seq_id))
}
