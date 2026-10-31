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
//!   2. `Write-Ahead Log Before Fan-Out`:
//!      - On every valid `ClientEnvelope::SubmitCommand`, `TableRoomActor`
//!        increments `seq_id` and persists the `WalEntry` (plus periodic
//!        write-behind `TableStateSnapshot` every `snapshot_interval` commands)
//!        *before* broadcasting `ServerEnvelope::CommandAccepted` to clients.
//!   3. `Double-Checked Room Wake-Up`:
//!      - `RoomLeaseManager::get_or_wake_room` uses a fast read-lock path
//!        followed by a double-checked write-lock rehydration from `WalStorage`
//!        so concurrent connection bursts never spawn duplicate actors for the
//!        same `campaign_id`.
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

use crate::dice::{SeededDiceRoller, project_roll_for_recipient};
use crate::sync::{
    ClientEnvelope, ServerEnvelope, encode_server_envelope, filter_events_for_recipient,
    project_state_for_recipient,
};
use crate::wal::{TableStateSnapshot, WalEntry, WalError, WalStorage, recover_table_state};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::sync::{RwLock, mpsc, oneshot};
use trame_engine::commands::{CampaignRole, CommandActor, TableState};
use uuid::Uuid;

/// Global atomic boolean flag indicating if the server runtime is in the process of shutting down.
/// When set to `true`, incoming HTTP/WebSocket connections are rejected.
pub static IS_SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// RFC 6455 WebSocket Close Code `1001 Going Away` emitted during graceful scale-to-zero / hibernation.
pub const WS_CLOSE_CODE_GOING_AWAY: u16 = 1001;

/// Standard reason string broadcast alongside close code 1001.
pub const WS_CLOSE_REASON_GOING_AWAY: &str = "Server Hibernating";

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
}

/// Represents a live WebSocket client session attached to a `TableRoomActor`.
pub struct ConnectedClient {
    /// Unique per-connection session identifier.
    pub session_id: Uuid,
    /// Authenticated user identifier.
    pub user_id: Uuid,
    /// Campaign role (`Gm`, `Player`, or `Spectator`) governing RBAC and state projection.
    pub role: CampaignRole,
    /// Outbound channel carrying frames (`OutboundClientFrame`) to the socket task.
    pub tx: mpsc::UnboundedSender<OutboundClientFrame>,
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
    /// Replaces the room's `TableState` (e.g. after importing a starter dungeon or `.uvtt` map),
    /// increments `seq_id`, flushes a snapshot to `WalStorage`, and broadcasts `StateSnapshot` to all connected clients.
    ReplaceTableState {
        /// New authoritative `TableState`.
        new_state: Box<TableState>,
        /// Oneshot channel receiving the updated `seq_id`.
        reply: oneshot::Sender<Result<u64, RoomError>>,
    },
    /// Flushes a final `TableStateSnapshot` to `WalStorage`, sends close code 1001 to all clients, and stops.
    Hibernate {
        /// Oneshot channel receiving the final persisted `seq_id`.
        reply: oneshot::Sender<Result<u64, RoomError>>,
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

    /// Commands the room actor to replace its `TableState`, persist a snapshot, and broadcast `StateSnapshot` to all clients.
    pub async fn replace_state(&self, new_state: TableState) -> Result<u64, RoomError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(RoomActorMessage::ReplaceTableState {
                new_state: Box::new(new_state),
                reply: reply_tx,
            })
            .await
            .map_err(|_| RoomError::ActorClosed)?;
        reply_rx.await.map_err(|_| RoomError::ActorClosed)?
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
    dice_roller: SeededDiceRoller,
    wal: Arc<dyn WalStorage>,
    rx: mpsc::Receiver<RoomActorMessage>,
}

impl TableRoomActor {
    /// Rehydrates `campaign_id` from `wal` (`recover_table_state`), seeds the room's ChaCha20 CSPRNG,
    /// and spawns the asynchronous actor loop with a 256-message bounded mailbox.
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
                        let _ = client.tx.send(OutboundClientFrame::Binary(bytes));
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
                RoomActorMessage::ReplaceTableState { new_state, reply } => {
                    self.last_activity_ms = now_ms();
                    self.state = *new_state;
                    self.seq_id += 1;
                    let res = self.flush_snapshot().map(|()| self.seq_id).map_err(RoomError::Wal);
                    if res.is_ok() {
                        for client in self.clients.values() {
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
                                let _ = client.tx.send(OutboundClientFrame::Binary(bytes));
                            }
                        }
                    }
                    let _ = reply.send(res);
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
                                let _ = client.tx.send(OutboundClientFrame::Binary(bytes));
                            }
                        }
                    }
                    Err(err) => {
                        let out = ServerEnvelope::CommandRejected {
                            reason: err.to_string(),
                        };
                        if let Ok(bytes) = encode_server_envelope(&out) {
                            let _ = sender_tx.send(OutboundClientFrame::Binary(bytes));
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
                                    let _ = client.tx.send(OutboundClientFrame::Binary(bytes));
                                }
                            }
                        }
                    }
                    Err(err) => {
                        let out = ServerEnvelope::CommandRejected {
                            reason: err.to_string(),
                        };
                        if let Ok(bytes) = encode_server_envelope(&out) {
                            let _ = sender_tx.send(OutboundClientFrame::Binary(bytes));
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
                        let _ = client.tx.send(OutboundClientFrame::Binary(bytes.clone()));
                    }
                }
            }
            ClientEnvelope::Ping { client_time_ms } => {
                let out = ServerEnvelope::Pong {
                    client_time_ms,
                    server_time_ms: self.last_activity_ms,
                };
                if let Ok(bytes) = encode_server_envelope(&out) {
                    let _ = sender_tx.send(OutboundClientFrame::Binary(bytes));
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

/// Manages active `TableRoomActor` instances and enforces the `Idle-Lease` and scale-to-zero hibernation policy.
pub struct RoomLeaseManager {
    rooms: RwLock<HashMap<Uuid, TableRoomHandle>>,
    wal: Arc<dyn WalStorage>,
    snapshot_interval: u64,
    idle_timeout_ms: u64,
}

impl RoomLeaseManager {
    /// Creates a new `RoomLeaseManager` backed by `wal`, taking write-behind snapshots every
    /// `snapshot_interval` commands and hibernating zero-connection rooms after `idle_timeout_ms` (`ms`).
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
        if IS_SHUTTING_DOWN.load(Ordering::Acquire) {
            return Err(RoomError::ShuttingDown);
        }

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

        if IS_SHUTTING_DOWN.load(Ordering::Acquire) {
            return Err(RoomError::ShuttingDown);
        }

        let handle = TableRoomActor::spawn(campaign_id, self.wal.clone(), self.snapshot_interval)?;
        guard.insert(campaign_id, handle.clone());
        Ok(handle)
    }

    /// Returns the number of campaign rooms currently awake in memory.
    pub async fn active_room_count(&self) -> usize {
        self.rooms.read().await.len()
    }

    /// Provides access to the underlying Write-Ahead Log storage.
    pub fn wal(&self) -> &Arc<dyn WalStorage> {
        &self.wal
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

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
