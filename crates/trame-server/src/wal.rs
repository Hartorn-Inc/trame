use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use thiserror::Error;
use trame_engine::commands::{
    CampaignRole, CommandActor, TableSnapshotData, TableState, TrameCommand, TrameEvent,
};
use trame_engine::geometry::Bvh2D;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum WalError {
    #[error("Storage lock poisoned")]
    LockPoisoned,
    #[error("Serialization failure: {0}")]
    Serialization(String),
    #[error("Replay error at seq_id {seq_id}: {reason}")]
    ReplayFailed { seq_id: u64, reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalEntry {
    pub seq_id: u64,
    pub campaign_id: Uuid,
    pub timestamp_ms: u64,
    pub actor_user_id: Uuid,
    pub role: CampaignRole,
    pub command: TrameCommand,
    pub events: Vec<TrameEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableStateSnapshot {
    pub campaign_id: Uuid,
    pub snapshot_seq_id: u64,
    pub captured_at_ms: u64,
    pub cell_size_px: f64,
    pub feet_per_cell: f64,
    pub data: TableSnapshotData,
}

/// Write-Ahead Log & Write-Behind Snapshot storage seam.
pub trait WalStorage: Send + Sync {
    fn append_entry(&self, entry: WalEntry) -> Result<(), WalError>;
    fn save_snapshot(&self, snapshot: TableStateSnapshot) -> Result<(), WalError>;
    fn load_latest_snapshot(
        &self,
        campaign_id: Uuid,
    ) -> Result<Option<TableStateSnapshot>, WalError>;
    fn load_entries_after(
        &self,
        campaign_id: Uuid,
        after_seq_id: u64,
    ) -> Result<Vec<WalEntry>, WalError>;
}

#[derive(Default, Clone)]
pub struct InMemoryWalStorage {
    snapshots: Arc<RwLock<HashMap<Uuid, TableStateSnapshot>>>,
    entries: Arc<RwLock<HashMap<Uuid, Vec<WalEntry>>>>,
}

impl InMemoryWalStorage {
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

/// Rehydrates a campaign's authoritative `TableState` from the latest snapshot + subsequent WAL entries.
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
