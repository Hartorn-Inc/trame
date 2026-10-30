use crate::dice::{SeededDiceRoller, project_roll_for_recipient};
use crate::sync::{
    ClientEnvelope, ServerEnvelope, encode_server_envelope, filter_events_for_recipient,
    project_state_for_recipient,
};
use crate::wal::{TableStateSnapshot, WalEntry, WalError, WalStorage, recover_table_state};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::sync::{RwLock, mpsc, oneshot};
use trame_engine::commands::{CampaignRole, CommandActor, TableState};
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum RoomError {
    #[error("Room actor channel closed")]
    ActorClosed,
    #[error("WAL storage error: {0}")]
    Wal(#[from] WalError),
}

pub struct ConnectedClient {
    pub session_id: Uuid,
    pub user_id: Uuid,
    pub role: CampaignRole,
    pub tx: mpsc::UnboundedSender<Vec<u8>>,
}

pub enum RoomActorMessage {
    ConnectClient {
        client: ConnectedClient,
        reply: oneshot::Sender<Result<(), RoomError>>,
    },
    DisconnectClient {
        session_id: Uuid,
    },
    HandleEnvelope {
        session_id: Uuid,
        envelope: ClientEnvelope,
        reply: oneshot::Sender<Result<(), RoomError>>,
    },
    QueryMetrics {
        reply: oneshot::Sender<RoomMetrics>,
    },
    Hibernate {
        reply: oneshot::Sender<Result<u64, RoomError>>,
    },
}

#[derive(Debug, Clone, Copy)]
pub struct RoomMetrics {
    pub campaign_id: Uuid,
    pub seq_id: u64,
    pub active_connections: usize,
    pub last_activity_ms: u64,
}

#[derive(Clone)]
pub struct TableRoomHandle {
    pub campaign_id: Uuid,
    tx: mpsc::Sender<RoomActorMessage>,
}

impl TableRoomHandle {
    pub async fn connect_client(&self, client: ConnectedClient) -> Result<(), RoomError> {
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

    pub async fn disconnect_client(&self, session_id: Uuid) -> Result<(), RoomError> {
        self.tx
            .send(RoomActorMessage::DisconnectClient { session_id })
            .await
            .map_err(|_| RoomError::ActorClosed)
    }

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

    pub async fn metrics(&self) -> Result<RoomMetrics, RoomError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(RoomActorMessage::QueryMetrics { reply: reply_tx })
            .await
            .map_err(|_| RoomError::ActorClosed)?;
        reply_rx.await.map_err(|_| RoomError::ActorClosed)
    }

    pub async fn hibernate(&self) -> Result<u64, RoomError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(RoomActorMessage::Hibernate { reply: reply_tx })
            .await
            .map_err(|_| RoomError::ActorClosed)?;
        reply_rx.await.map_err(|_| RoomError::ActorClosed)?
    }
}

pub struct TableRoomActor {
    campaign_id: Uuid,
    state: TableState,
    seq_id: u64,
    snapshot_interval: u64,
    last_snapshot_seq: u64,
    last_activity_ms: u64,
    clients: HashMap<Uuid, ConnectedClient>,
    dice_roller: SeededDiceRoller,
    wal: Arc<dyn WalStorage>,
    rx: mpsc::Receiver<RoomActorMessage>,
}

impl TableRoomActor {
    pub fn spawn(
        campaign_id: Uuid,
        wal: Arc<dyn WalStorage>,
        snapshot_interval: u64,
    ) -> Result<TableRoomHandle, RoomError> {
        let (state, seq_id) = recover_table_state(wal.as_ref(), campaign_id)?;
        let (tx, rx) = mpsc::channel(256);
        let actor = Self {
            campaign_id,
            state,
            seq_id,
            snapshot_interval: snapshot_interval.max(1),
            last_snapshot_seq: seq_id,
            last_activity_ms: now_ms(),
            clients: HashMap::new(),
            dice_roller: SeededDiceRoller::from_os_csprng(),
            wal,
            rx,
        };
        tokio::spawn(actor.run());
        Ok(TableRoomHandle { campaign_id, tx })
    }

    async fn run(mut self) {
        while let Some(msg) = self.rx.recv().await {
            match msg {
                RoomActorMessage::ConnectClient { client, reply } => {
                    self.last_activity_ms = now_ms();
                    let projected = project_state_for_recipient(
                        self.campaign_id,
                        &self.state,
                        client.user_id,
                        client.role,
                    );
                    let snapshot_env = ServerEnvelope::StateSnapshot {
                        seq_id: self.seq_id,
                        state: projected,
                    };
                    if let Ok(bytes) = encode_server_envelope(&snapshot_env) {
                        let _ = client.tx.send(bytes);
                    }
                    self.clients.insert(client.session_id, client);
                    let _ = reply.send(Ok(()));
                }
                RoomActorMessage::DisconnectClient { session_id } => {
                    self.clients.remove(&session_id);
                    self.last_activity_ms = now_ms();
                }
                RoomActorMessage::HandleEnvelope {
                    session_id,
                    envelope,
                    reply,
                } => {
                    self.last_activity_ms = now_ms();
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
                    let res = self
                        .flush_snapshot()
                        .map(|()| self.seq_id)
                        .map_err(RoomError::Wal);
                    let _ = reply.send(res);
                    break;
                }
            }
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

        match envelope {
            ClientEnvelope::SubmitCommand(cmd) => {
                let actor = CommandActor {
                    user_id: actor_user_id,
                    role: actor_role,
                };
                match self.state.apply_command(&actor, cmd.clone()) {
                    Ok(events) => {
                        self.seq_id += 1;
                        let entry = WalEntry {
                            seq_id: self.seq_id,
                            campaign_id: self.campaign_id,
                            timestamp_ms: self.last_activity_ms,
                            actor_user_id,
                            role: actor_role,
                            command: cmd,
                            events: events.clone(),
                        };
                        self.wal.append_entry(entry)?;

                        if self.seq_id - self.last_snapshot_seq >= self.snapshot_interval {
                            self.flush_snapshot()?;
                        }

                        for client in self.clients.values() {
                            let filtered_events = filter_events_for_recipient(
                                &self.state,
                                &events,
                                client.user_id,
                                client.role,
                            );
                            let projected_state = project_state_for_recipient(
                                self.campaign_id,
                                &self.state,
                                client.user_id,
                                client.role,
                            );
                            let out = ServerEnvelope::CommandAccepted {
                                seq_id: self.seq_id,
                                events: filtered_events,
                                state: projected_state,
                            };
                            if let Ok(bytes) = encode_server_envelope(&out) {
                                let _ = client.tx.send(bytes);
                            }
                        }
                    }
                    Err(err) => {
                        let out = ServerEnvelope::CommandRejected {
                            reason: err.to_string(),
                        };
                        if let Ok(bytes) = encode_server_envelope(&out) {
                            let _ = sender_tx.send(bytes);
                        }
                    }
                }
            }
            ClientEnvelope::RollDice {
                expression,
                visibility,
                reason,
            } => {
                match self
                    .dice_roller
                    .roll(actor_user_id, &expression, visibility, reason)
                {
                    Ok(outcome) => {
                        for client in self.clients.values() {
                            if let Some(projected_roll) =
                                project_roll_for_recipient(&outcome, client.user_id, client.role)
                            {
                                let out = ServerEnvelope::DiceRolled(projected_roll);
                                if let Ok(bytes) = encode_server_envelope(&out) {
                                    let _ = client.tx.send(bytes);
                                }
                            }
                        }
                    }
                    Err(err) => {
                        let out = ServerEnvelope::CommandRejected {
                            reason: err.to_string(),
                        };
                        if let Ok(bytes) = encode_server_envelope(&out) {
                            let _ = sender_tx.send(bytes);
                        }
                    }
                }
            }
            ClientEnvelope::PointerPing { pos, color_hex } => {
                let out = ServerEnvelope::PointerPingBroadcast {
                    sender_user_id: actor_user_id,
                    pos,
                    color_hex,
                };
                if let Ok(bytes) = encode_server_envelope(&out) {
                    for client in self.clients.values() {
                        let _ = client.tx.send(bytes.clone());
                    }
                }
            }
            ClientEnvelope::Ping { client_time_ms } => {
                let out = ServerEnvelope::Pong {
                    client_time_ms,
                    server_time_ms: self.last_activity_ms,
                };
                if let Ok(bytes) = encode_server_envelope(&out) {
                    let _ = sender_tx.send(bytes);
                }
            }
        }
        Ok(())
    }

    fn flush_snapshot(&mut self) -> Result<(), WalError> {
        let snap = TableStateSnapshot {
            campaign_id: self.campaign_id,
            snapshot_seq_id: self.seq_id,
            captured_at_ms: self.last_activity_ms,
            cell_size_px: self.state.cell_size_px,
            feet_per_cell: self.state.feet_per_cell,
            data: self.state.data.clone(),
        };
        self.wal.save_snapshot(snap)?;
        self.last_snapshot_seq = self.seq_id;
        Ok(())
    }
}

/// Manages active `TableRoomActor` instances and enforces the `Idle-Lease` hibernation policy.
pub struct RoomLeaseManager {
    rooms: RwLock<HashMap<Uuid, TableRoomHandle>>,
    wal: Arc<dyn WalStorage>,
    snapshot_interval: u64,
    idle_timeout_ms: u64,
}

impl RoomLeaseManager {
    pub fn new(wal: Arc<dyn WalStorage>, snapshot_interval: u64, idle_timeout_ms: u64) -> Self {
        Self {
            rooms: RwLock::new(HashMap::new()),
            wal,
            snapshot_interval,
            idle_timeout_ms,
        }
    }

    /// Gets an active room handle or wakes a hibernated room transparently from WAL storage.
    pub async fn get_or_wake_room(&self, campaign_id: Uuid) -> Result<TableRoomHandle, RoomError> {
        {
            let guard = self.rooms.read().await;
            if let Some(handle) = guard.get(&campaign_id) {
                return Ok(handle.clone());
            }
        }

        let mut guard = self.rooms.write().await;
        if let Some(handle) = guard.get(&campaign_id) {
            return Ok(handle.clone());
        }

        let handle = TableRoomActor::spawn(campaign_id, self.wal.clone(), self.snapshot_interval)?;
        guard.insert(campaign_id, handle.clone());
        Ok(handle)
    }

    pub async fn active_room_count(&self) -> usize {
        self.rooms.read().await.len()
    }

    /// Sweeps all rooms and hibernates any room with 0 active connections whose idle duration
    /// exceeds `self.idle_timeout_ms`, flushing a compacted snapshot and freeing RAM.
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

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
