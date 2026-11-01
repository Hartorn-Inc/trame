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
//!   6. `Damage Authority & Bounds (G6)`:
//!      - `authorize_command` rejects `ApplyDamage` outside `0..=MAX_RAW_DAMAGE`
//!        and, for non-GM actors, against tokens they do not control or with a
//!        non-`Normal` affinity, before the command reaches the engine or the WAL.
//!   7. `Hidden Initiative & Sheet Privacy (G5)`:
//!      - Auto-rolled initiative for `CHANNEL_GM_HIDDEN` tokens uses
//!        `RollVisibility::GmOnly`; tokens whose player already rolled
//!        initiative keep that roll; `ActorUpdated` sheets go only to the GM and
//!        the controllers of linked tokens.
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

use crate::dice::{RollVisibility, SeededDiceRoller, project_roll_for_recipient};
use crate::sync::{
    ClientEnvelope, McpStagingProposal, ServerEnvelope, encode_server_envelope,
    filter_events_for_recipient, project_state_for_recipient,
};
use crate::wal::{TableStateSnapshot, WalEntry, WalError, WalStorage, recover_table_state};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::sync::{RwLock, mpsc, oneshot};
use trame_engine::commands::{
    CampaignRole, CommandActor, TableMode, TableState, TrameCommand, TrameEvent,
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

/// Upper bound on `ApplyDamage.raw_damage` (HP). Far above any 5e damage roll while keeping
/// engine multipliers (`Vulnerable` doubles damage) well inside `i32`.
pub const MAX_RAW_DAMAGE: i32 = 10_000;

fn is_gm_hidden(token: &trame_engine::commands::TokenState) -> bool {
    token.visibility_channel & trame_engine::geometry::CHANNEL_GM_HIDDEN != 0
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
    /// Updated Armor Class (`ac`).
    pub ac: Option<i32>,
    /// Updated Dexterity ability modifier (`dex_mod`).
    pub dex_mod: Option<i32>,
    /// Updated maximum movement speed in feet (`speed_ft`).
    pub speed_ft: Option<f64>,
    /// Updated list of active condition labels (`conditions`).
    pub conditions: Option<Vec<String>>,
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
        /// New optimistic concurrency version.
        version: u64,
        /// Full serialized actor payload.
        data: serde_json::Value,
        /// Tactical combat fields to sync onto linked tokens (`token.actor_id == Some(actor_id)` or `token.id == actor_id`).
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

    /// Broadcasts `ServerEnvelope::ActorUpdated` to connected clients and synchronizes linked
    /// `TokenState` tactical fields (`hp_current`, `hp_max`, `temp_hp`, `ac`, `speed_ft`, `conditions`)
    /// without pushing onto the 50-entry tactical `undo_stack` (`ADR-0037`).
    pub async fn notify_actor_updated(
        &self,
        actor_id: Uuid,
        version: u64,
        data: serde_json::Value,
        tactical_sync: ActorTacticalSync,
    ) -> Result<usize, RoomError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(RoomActorMessage::NotifyActorUpdated {
                actor_id,
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
    dice_roller: SeededDiceRoller,
    wal: Arc<dyn WalStorage>,
    rx: mpsc::Receiver<RoomActorMessage>,
    /// Latest initiative total each non-GM user rolled themselves (`RollDice` whose reason
    /// starts with `"initiative"`, case-insensitive), consumed by the next auto-roll so their
    /// tokens keep the player's own result instead of being re-rolled.
    player_initiative_rolls: HashMap<Uuid, i32>,
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
            player_initiative_rolls: HashMap::new(),
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
                    version,
                    data,
                    tactical_sync,
                    reply,
                } => {
                    self.last_activity_ms = now_ms();
                    let updated_tokens =
                        self.apply_actor_tactical_sync(actor_id, version, data, tactical_sync);
                    let _ = reply.send(Ok(updated_tokens));
                }
                RoomActorMessage::StageMcpProposal { proposal, reply } => {
                    self.last_activity_ms = now_ms();
                    self.state
                        .data
                        .mcp_staging_proposals
                        .insert(proposal.proposal_id, proposal.clone());
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
                    let _ = reply.send(Ok(proposal));
                }
                RoomActorMessage::GetTableSnapshot { reply } => {
                    let _ = reply.send((self.seq_id, self.state.clone()));
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
                self.last_activity_ms = now_ms();
                let actor = CommandActor {
                    user_id: actor_user_id,
                    role: actor_role,
                };
                if let Err(RoomError::CommandRejected(reason)) =
                    self.execute_and_broadcast_command(actor, *cmd)
                {
                    let out = ServerEnvelope::CommandRejected { reason };
                    if let Ok(bytes) = encode_server_envelope(&out) {
                        let _ = sender_tx.send(OutboundClientFrame::Binary(bytes));
                    }
                }
            }
            ClientEnvelope::RollDice {
                expression,
                visibility,
                reason,
            } => {
                self.last_activity_ms = now_ms();
                let is_player_initiative = actor_role != CampaignRole::Gm
                    && reason
                        .trim_start()
                        .to_ascii_lowercase()
                        .starts_with("initiative");
                match self
                    .dice_roller
                    .roll(actor_user_id, &expression, visibility, reason)
                {
                    Ok(outcome) => {
                        if is_player_initiative {
                            self.player_initiative_rolls
                                .insert(actor_user_id, outcome.total);
                        }
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
        cmd: TrameCommand,
    ) -> Result<(u64, Vec<TrameEvent>), RoomError> {
        self.authorize_command(&actor, &cmd)
            .map_err(RoomError::CommandRejected)?;
        let resolved_cmd = self.resolve_authoritative_initiative(&actor, cmd);
        match self.state.apply_command(&actor, resolved_cmd.clone()) {
            Ok(events) => {
                self.seq_id += 1;
                let entry = WalEntry {
                    seq_id: self.seq_id,
                    campaign_id: self.campaign_id,
                    timestamp_ms: self.last_activity_ms,
                    actor_user_id: actor.user_id,
                    role: actor.role,
                    command: resolved_cmd,
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
                Ok((self.seq_id, events))
            }
            Err(err) => Err(RoomError::CommandRejected(err.to_string())),
        }
    }

    /// Server-side authority checks layered on top of `TableState::apply_command` (G6):
    /// - `ApplyDamage.raw_damage` must lie in `0..=MAX_RAW_DAMAGE` so engine damage
    ///   multipliers (vulnerability doubling) can never overflow `i32`.
    /// - Non-GM actors may only damage tokens they control (`owner_user_id`).
    /// - Non-GM actors must send `DamageAffinity::Normal`: `TokenState` carries no server-side
    ///   resistances yet, so a client-chosen `Immune` / `Resistant` would let a player shrug
    ///   off damage. Only the GM may apply an affinity until the engine stores it per token.
    fn authorize_command(&self, actor: &CommandActor, cmd: &TrameCommand) -> Result<(), String> {
        if let TrameCommand::ApplyDamage {
            token_id,
            raw_damage,
            affinity,
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

    /// Rolls `1d20 + dex_mod` for each active combatant token on the table when `StartTurnByTurn` or
    /// `SetTableMode { mode: TurnByTurn }` is submitted by a GM with an empty `initiative_order`.
    fn resolve_authoritative_initiative(
        &mut self,
        actor: &CommandActor,
        cmd: TrameCommand,
    ) -> TrameCommand {
        if actor.role != CampaignRole::Gm || self.state.data.tokens.is_empty() {
            return cmd;
        }

        match cmd {
            TrameCommand::StartTurnByTurn {
                ref initiative_order,
            } if initiative_order.is_empty() => {
                let rolled_order = self.roll_table_initiative(actor.user_id);
                TrameCommand::StartTurnByTurn {
                    initiative_order: rolled_order,
                }
            }
            TrameCommand::SetTableMode {
                mode: TableMode::TurnByTurn,
                exploration_paused,
                ref initiative_order,
            } if initiative_order.is_empty() => {
                let rolled_order = self.roll_table_initiative(actor.user_id);
                TrameCommand::SetTableMode {
                    mode: TableMode::TurnByTurn,
                    exploration_paused,
                    initiative_order: rolled_order,
                }
            }
            other => other,
        }
    }

    /// Hidden combatants (`CHANNEL_GM_HIDDEN`) are rolled with `RollVisibility::GmOnly` so their
    /// names and results never reach player sockets through the public initiative feed.
    /// Tokens whose owner already rolled initiative themselves (`player_initiative_rolls`)
    /// reuse that total and are not auto-rolled; the stored rolls are consumed.
    fn roll_table_initiative(&mut self, actor_user_id: Uuid) -> Vec<Uuid> {
        type Candidate = (Uuid, String, i32, bool, Option<Uuid>);
        let to_candidate = |t: &trame_engine::commands::TokenState| -> Candidate {
            (
                t.id,
                t.name.clone(),
                t.dex_mod,
                is_gm_hidden(t),
                t.owner_user_id,
            )
        };
        let combatants: Vec<Candidate> = self
            .state
            .data
            .tokens
            .values()
            .filter(|t| t.hp > 0)
            .map(to_candidate)
            .collect();

        let candidates: Vec<Candidate> = if combatants.is_empty() {
            self.state.data.tokens.values().map(to_candidate).collect()
        } else {
            combatants
        };

        let self_rolls = std::mem::take(&mut self.player_initiative_rolls);
        let mut rolled: Vec<(i32, i32, Uuid)> = Vec::with_capacity(candidates.len());
        for (token_id, token_name, dex_mod, hidden, owner) in candidates {
            if let Some(total) = owner.and_then(|o| self_rolls.get(&o)) {
                rolled.push((*total, dex_mod, token_id));
                continue;
            }
            let expr = match dex_mod.cmp(&0) {
                std::cmp::Ordering::Greater => format!("1d20+{dex_mod}"),
                std::cmp::Ordering::Less => format!("1d20{dex_mod}"),
                std::cmp::Ordering::Equal => "1d20".to_string(),
            };
            let reason = format!("Initiative: {token_name}");
            let visibility = if hidden {
                RollVisibility::GmOnly
            } else {
                RollVisibility::Public
            };
            if let Ok(outcome) = self
                .dice_roller
                .roll(actor_user_id, &expr, visibility, reason)
            {
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
                rolled.push((outcome.total, dex_mod, token_id));
            }
        }

        // Sort descending by total roll, tie-breaking descending by dex_mod, then ascending by token_id
        rolled.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| b.1.cmp(&a.1))
                .then_with(|| a.2.cmp(&b.2))
        });

        rolled.into_iter().map(|(_, _, id)| id).collect()
    }

    /// Synchronizes tactical fields onto any `TokenState` linked to `actor_id` without pushing to `undo_stack`,
    /// then broadcasts `ServerEnvelope::ActorUpdated` to all connected clients (`ADR-0037`).
    fn apply_actor_tactical_sync(
        &mut self,
        actor_id: Uuid,
        version: u64,
        data: serde_json::Value,
        sync: ActorTacticalSync,
    ) -> usize {
        let mut updated_count = 0usize;
        let mut sheet_owners: Vec<Uuid> = Vec::new();
        for token in self.state.data.tokens.values_mut() {
            if token.actor_id == Some(actor_id) || token.id == actor_id {
                if let Some(owner) = token.owner_user_id {
                    sheet_owners.push(owner);
                }
                if let Some(ref name) = sync.name {
                    token.name = name.clone();
                }
                if let Some(hp_max) = sync.hp_max {
                    token.max_hp = hp_max.max(1);
                    token.hp = token.hp.clamp(0, token.max_hp);
                }
                if let Some(hp_current) = sync.hp_current {
                    token.hp = hp_current.clamp(0, token.max_hp);
                }
                if let Some(temp_hp) = sync.temp_hp {
                    token.temp_hp = temp_hp.max(0);
                }
                if let Some(ac) = sync.ac {
                    token.ac = ac.max(0);
                }
                if let Some(dex_mod) = sync.dex_mod {
                    token.dex_mod = dex_mod;
                }
                if let Some(speed_ft) = sync.speed_ft
                    && speed_ft >= 0.0
                {
                    token.speed_max_ft = speed_ft;
                    if self.state.data.mode == TableMode::Exploration {
                        token.speed_remaining_ft = speed_ft;
                    } else {
                        token.speed_remaining_ft = token.speed_remaining_ft.min(speed_ft);
                    }
                }
                if let Some(ref conditions) = sync.conditions {
                    token.conditions = conditions.clone();
                }
                updated_count += 1;
            }
        }

        let out = ServerEnvelope::ActorUpdated {
            actor_id,
            version,
            data,
        };
        // Full sheets carry HP/AC numbers, so only the GM and the linked tokens' controllers
        // receive them (G5).
        if let Ok(bytes) = encode_server_envelope(&out) {
            for client in self.clients.values() {
                if client.role == CampaignRole::Gm || sheet_owners.contains(&client.user_id) {
                    let _ = client.tx.send(OutboundClientFrame::Binary(bytes.clone()));
                }
            }
        }

        updated_count
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
