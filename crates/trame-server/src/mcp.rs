//! ============================================================================
//! NATIVE MODEL CONTEXT PROTOCOL (MCP) JSON-RPC 2.0 SERVER (mcp.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Implements the native Model Context Protocol (MCP) JSON-RPC 2.0 server
//! endpoint at `POST /api/v1/mcp` (`04-RUNTIME-AND-DEDICATED-HOSTING.md`),
//! enabling AI assistants and external orchestrators to inspect campaign
//! timelines/notes and execute or stage authoritative tabletop commands.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//! 1. `Zero-Trust PAT & GM Session Authentication`:
//!    - Every request to `POST /api/v1/mcp` must carry either a valid
//!      `Authorization: Bearer trame_pat_*` Personal Access Token or an active
//!      `trame_session` cookie belonging to a user with `GameMaster` privileges
//!      for the target `campaign_id`.
//!    - Unauthenticated requests fail closed with HTTP `401 Unauthorized`;
//!      non-GM callers fail closed with HTTP `403 Forbidden`.
//! 2. `25-Command Batch Ceiling`:
//!    - `mcp.execute_batch` and `mcp.stage_encounter` enforce a strict maximum
//!      of `MAX_MCP_BATCH_COMMANDS = 25` commands per invocation to bound single
//!      actor mailbox execution slices and prevent event-loop starvation.
//! 3. `Dry-Run Staging Mode Isolation`:
//!    - When `mcp_staging_mode` is `true` on `trame.dispatch_command` /
//!      `mcp.execute_batch`, or whenever `mcp.stage_encounter` is invoked,
//!      mutations are packaged into a `McpStagingProposal` in `TableRoomActor`
//!      and broadcast via `ServerEnvelope::McpStagingProposed` to connected
//!      Game Masters without mutating live tokens or the WAL until the GM
//!      issues `TrameCommand::CommitMcpStaging`.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//! `mcp_jsonrpc_handler(state, headers, req)`
//!   ├── 1. Authenticate caller via `Bearer trame_pat_*` or `trame_session` cookie.
//!   ├── 2. Route JSON-RPC 2.0 `method`:
//!   │    ├── `"initialize"` -> Return server protocol version and capabilities.
//!   │    ├── `"tools/list"` -> Return schemas for `trame.dispatch_command`,
//!   │    │                     `mcp.execute_batch`, and `mcp.stage_encounter`.
//!   │    ├── `"tools/call"` -> Verify GM role for `campaign_id`, wake room actor,
//!   │    │                     and either execute commands or stage a proposal.
//!   │    └── `"resources/read"` -> Parse `trame://campaigns/{id}/timeline` or
//!   │                              `trame://campaigns/{id}/notes` and return JSON.
//!   └── 3. Wrap outcome in a standard JSON-RPC 2.0 response envelope.
//! ============================================================================

use crate::auth::pat::PatMiddleware;
use crate::http::{AppState, is_authorized_campaign_gm, resolve_authenticated_user};
use crate::sync::McpStagingProposal;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use trame_engine::commands::{CampaignRole, CommandActor, TrameCommand};
use uuid::Uuid;

/// Maximum number of `TrameCommand` items permitted in a single MCP batch tool call.
pub const MAX_MCP_BATCH_COMMANDS: usize = 25;

/// Standard JSON-RPC 2.0 request envelope accepted by `POST /api/v1/mcp`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct JsonRpcRequest {
    /// Protocol version string (expected `"2.0"`).
    pub jsonrpc: String,
    /// Optional request correlation identifier (`number`, `string`, or `null`).
    #[serde(default)]
    pub id: Option<Value>,
    /// MCP method name (`"initialize"`, `"tools/list"`, `"tools/call"`, `"resources/read"`).
    pub method: String,
    /// Optional method parameters object.
    #[serde(default)]
    pub params: Option<Value>,
}

/// Standard JSON-RPC 2.0 response envelope returned by `POST /api/v1/mcp`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct JsonRpcResponse {
    /// Protocol version string (`"2.0"`).
    pub jsonrpc: String,
    /// Echoed correlation identifier from the request.
    pub id: Value,
    /// Method execution result payload when successful.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// Structured JSON-RPC error object when the call fails.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

/// Structured JSON-RPC 2.0 error object.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct JsonRpcError {
    /// Standard JSON-RPC numeric error code (e.g., `-32601` Method Not Found, `-32602` Invalid Params).
    pub code: i32,
    /// Human-readable error description.
    pub message: String,
    /// Optional structured diagnostic metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcResponse {
    /// Constructs a successful JSON-RPC 2.0 response for `id`.
    pub fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    /// Constructs a failed JSON-RPC 2.0 response for `id`.
    pub fn error(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }
}

#[derive(Debug, Clone)]
struct McpCaller {
    user_id: Uuid,
    scoped_campaign_id: Option<Uuid>,
}

async fn authenticate_mcp_caller(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<McpCaller, StatusCode> {
    if let Some(auth_hdr) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        let trimmed = auth_hdr.trim();
        if let Some(token) = trimmed.strip_prefix("Bearer ")
            && token.trim().starts_with(crate::auth::pat::PAT_PREFIX)
        {
            let pat_mw = PatMiddleware::new(state.auth_state.session_store.clone());
            let record = pat_mw
                .authenticate_header(trimmed)
                .await
                .map_err(|_| StatusCode::UNAUTHORIZED)?;
            return Ok(McpCaller {
                user_id: record.user_id,
                scoped_campaign_id: record.campaign_id,
            });
        }
    }

    let user_id = resolve_authenticated_user(state, headers, None).await?;
    Ok(McpCaller {
        user_id,
        scoped_campaign_id: None,
    })
}

async fn authorize_campaign_gm(
    state: &AppState,
    caller: &McpCaller,
    campaign_id: Uuid,
) -> Result<(), StatusCode> {
    if let Some(scoped_id) = caller.scoped_campaign_id
        && scoped_id != campaign_id
    {
        return Err(StatusCode::FORBIDDEN);
    }
    if !is_authorized_campaign_gm(state, campaign_id, caller.user_id).await {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(())
}

/// Axum handler for `POST /api/v1/mcp` implementing JSON-RPC 2.0 over HTTP.
pub async fn mcp_jsonrpc_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<JsonRpcRequest>,
) -> Response {
    let caller = match authenticate_mcp_caller(&state, &headers).await {
        Ok(c) => c,
        Err(status) => {
            return (
                status,
                Json(JsonRpcResponse::error(
                    req.id.unwrap_or(Value::Null),
                    -32001,
                    "unauthorized: valid PAT or GameMaster session required",
                )),
            )
                .into_response();
        }
    };

    let req_id = req.id.unwrap_or(Value::Null);
    if req.jsonrpc != "2.0" {
        return (
            StatusCode::BAD_REQUEST,
            Json(JsonRpcResponse::error(
                req_id,
                -32600,
                "invalid JSON-RPC version: expected '2.0'",
            )),
        )
            .into_response();
    }

    let params = req.params.unwrap_or_else(|| json!({}));

    match req.method.as_str() {
        "initialize" => {
            let result = json!({
                "protocolVersion": "2024-11-05",
                "serverInfo": {
                    "name": "trame-mcp-server",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {
                    "tools": { "listChanged": false },
                    "resources": { "subscribe": false, "listChanged": false }
                }
            });
            (
                StatusCode::OK,
                Json(JsonRpcResponse::success(req_id, result)),
            )
                .into_response()
        }
        "tools/list" => {
            let result = json!({
                "tools": [
                    {
                        "name": "trame.dispatch_command",
                        "description": "Dispatches a single authoritative TrameCommand to a campaign room (or stages it if mcp_staging_mode is true).",
                        "inputSchema": {
                            "type": "object",
                            "required": ["campaign_id", "command"],
                            "properties": {
                                "campaign_id": { "type": "string", "format": "uuid" },
                                "command": { "type": "object" },
                                "mcp_staging_mode": { "type": "boolean", "default": false },
                                "summary": { "type": "string" }
                            }
                        }
                    },
                    {
                        "name": "mcp.execute_batch",
                        "description": "Executes up to 25 authoritative TrameCommands in sequence on a campaign room (or stages them if mcp_staging_mode is true).",
                        "inputSchema": {
                            "type": "object",
                            "required": ["campaign_id", "commands"],
                            "properties": {
                                "campaign_id": { "type": "string", "format": "uuid" },
                                "commands": {
                                    "type": "array",
                                    "maxItems": MAX_MCP_BATCH_COMMANDS,
                                    "items": { "type": "object" }
                                },
                                "mcp_staging_mode": { "type": "boolean", "default": false },
                                "summary": { "type": "string" }
                            }
                        }
                    },
                    {
                        "name": "mcp.stage_encounter",
                        "description": "Stages an encounter batch (up to 25 TrameCommands) as a dry-run McpStagingProposal for GM approval on the tabletop.",
                        "inputSchema": {
                            "type": "object",
                            "required": ["campaign_id", "commands"],
                            "properties": {
                                "campaign_id": { "type": "string", "format": "uuid" },
                                "summary": { "type": "string" },
                                "commands": {
                                    "type": "array",
                                    "maxItems": MAX_MCP_BATCH_COMMANDS,
                                    "items": { "type": "object" }
                                }
                            }
                        }
                    }
                ]
            });
            (
                StatusCode::OK,
                Json(JsonRpcResponse::success(req_id, result)),
            )
                .into_response()
        }
        "tools/call" => handle_tools_call(&state, &caller, req_id, params).await,
        "resources/read" => handle_resources_read(&state, &caller, req_id, params).await,
        other => (
            StatusCode::OK,
            Json(JsonRpcResponse::error(
                req_id,
                -32601,
                format!("method not found: {other}"),
            )),
        )
            .into_response(),
    }
}

async fn handle_tools_call(
    state: &AppState,
    caller: &McpCaller,
    req_id: Value,
    params: Value,
) -> Response {
    let Some(tool_name) = params.get("name").and_then(Value::as_str) else {
        return (
            StatusCode::OK,
            Json(JsonRpcResponse::error(
                req_id,
                -32602,
                "missing 'name' in tools/call params",
            )),
        )
            .into_response();
    };

    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| params.clone());

    let campaign_id = match args
        .get("campaign_id")
        .or_else(|| args.get("campaignId"))
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok())
        .or(caller.scoped_campaign_id)
    {
        Some(id) => id,
        None => {
            return (
                StatusCode::OK,
                Json(JsonRpcResponse::error(
                    req_id,
                    -32602,
                    "missing or invalid 'campaign_id' argument",
                )),
            )
                .into_response();
        }
    };

    if authorize_campaign_gm(state, caller, campaign_id)
        .await
        .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(JsonRpcResponse::error(
                req_id,
                -32003,
                "forbidden: caller is not an authorized GameMaster for this campaign",
            )),
        )
            .into_response();
    }

    let staging_flag = args
        .get("mcp_staging_mode")
        .or_else(|| args.get("staging"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    match tool_name {
        "trame.dispatch_command" => {
            let Some(cmd_val) = args.get("command").cloned() else {
                return (
                    StatusCode::OK,
                    Json(JsonRpcResponse::error(
                        req_id,
                        -32602,
                        "missing 'command' argument",
                    )),
                )
                    .into_response();
            };
            let cmd: TrameCommand = match serde_json::from_value(cmd_val) {
                Ok(c) => c,
                Err(e) => {
                    return (
                        StatusCode::OK,
                        Json(JsonRpcResponse::error(
                            req_id,
                            -32602,
                            format!("invalid TrameCommand payload: {e}"),
                        )),
                    )
                        .into_response();
                }
            };

            let room = match state.lease_manager.get_or_wake_room(campaign_id).await {
                Ok(r) => r,
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(JsonRpcResponse::error(req_id, -32603, e.to_string())),
                    )
                        .into_response();
                }
            };

            if staging_flag {
                let summary = args
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or("Staged MCP command")
                    .to_string();
                let proposal = McpStagingProposal {
                    proposal_id: Uuid::new_v4(),
                    summary,
                    commands: vec![cmd],
                };
                match room.stage_mcp_proposal(proposal).await {
                    Ok(staged) => {
                        let out = json!({
                            "staged": true,
                            "proposal_id": staged.proposal_id,
                            "proposal": staged,
                            "content": [{ "type": "text", "text": format!("Staged proposal {}", staged.proposal_id) }]
                        });
                        (StatusCode::OK, Json(JsonRpcResponse::success(req_id, out)))
                            .into_response()
                    }
                    Err(e) => (
                        StatusCode::OK,
                        Json(JsonRpcResponse::error(req_id, -32603, e.to_string())),
                    )
                        .into_response(),
                }
            } else {
                let actor = CommandActor {
                    user_id: caller.user_id,
                    role: CampaignRole::Gm,
                };
                match room.dispatch_direct_command(actor, cmd).await {
                    Ok((seq_id, events)) => {
                        let out = json!({
                            "staged": false,
                            "seq_id": seq_id,
                            "events": events,
                            "content": [{ "type": "text", "text": format!("Executed command at seq_id {seq_id}") }]
                        });
                        (StatusCode::OK, Json(JsonRpcResponse::success(req_id, out)))
                            .into_response()
                    }
                    Err(e) => (
                        StatusCode::OK,
                        Json(JsonRpcResponse::error(req_id, -32000, e.to_string())),
                    )
                        .into_response(),
                }
            }
        }
        "mcp.execute_batch" | "mcp.stage_encounter" => {
            let force_stage = tool_name == "mcp.stage_encounter" || staging_flag;
            let Some(cmds_arr) = args.get("commands").and_then(Value::as_array) else {
                return (
                    StatusCode::OK,
                    Json(JsonRpcResponse::error(
                        req_id,
                        -32602,
                        "missing 'commands' array argument",
                    )),
                )
                    .into_response();
            };

            if cmds_arr.is_empty() || cmds_arr.len() > MAX_MCP_BATCH_COMMANDS {
                return (
                    StatusCode::OK,
                    Json(JsonRpcResponse::error(
                        req_id,
                        -32602,
                        format!(
                            "batch must contain between 1 and {MAX_MCP_BATCH_COMMANDS} commands (got {})",
                            cmds_arr.len()
                        ),
                    )),
                )
                    .into_response();
            }

            let mut parsed_cmds = Vec::with_capacity(cmds_arr.len());
            for raw in cmds_arr {
                match serde_json::from_value::<TrameCommand>(raw.clone()) {
                    Ok(c) => parsed_cmds.push(c),
                    Err(e) => {
                        return (
                            StatusCode::OK,
                            Json(JsonRpcResponse::error(
                                req_id,
                                -32602,
                                format!("invalid TrameCommand in batch: {e}"),
                            )),
                        )
                            .into_response();
                    }
                }
            }

            let room = match state.lease_manager.get_or_wake_room(campaign_id).await {
                Ok(r) => r,
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(JsonRpcResponse::error(req_id, -32603, e.to_string())),
                    )
                        .into_response();
                }
            };

            if force_stage {
                let summary = args
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or("Staged MCP encounter batch")
                    .to_string();
                let proposal = McpStagingProposal {
                    proposal_id: Uuid::new_v4(),
                    summary,
                    commands: parsed_cmds,
                };
                match room.stage_mcp_proposal(proposal).await {
                    Ok(staged) => {
                        let out = json!({
                            "staged": true,
                            "proposal_id": staged.proposal_id,
                            "proposal": staged,
                            "content": [{ "type": "text", "text": format!("Staged encounter proposal {}", staged.proposal_id) }]
                        });
                        (StatusCode::OK, Json(JsonRpcResponse::success(req_id, out)))
                            .into_response()
                    }
                    Err(e) => (
                        StatusCode::OK,
                        Json(JsonRpcResponse::error(req_id, -32603, e.to_string())),
                    )
                        .into_response(),
                }
            } else {
                let actor = CommandActor {
                    user_id: caller.user_id,
                    role: CampaignRole::Gm,
                };
                let mut last_seq_id = 0u64;
                let mut all_events = Vec::new();
                for cmd in parsed_cmds {
                    match room.dispatch_direct_command(actor.clone(), cmd).await {
                        Ok((seq, evs)) => {
                            last_seq_id = seq;
                            all_events.extend(evs);
                        }
                        Err(e) => {
                            return (
                                StatusCode::OK,
                                Json(JsonRpcResponse::error(req_id, -32000, e.to_string())),
                            )
                                .into_response();
                        }
                    }
                }
                let out = json!({
                    "staged": false,
                    "seq_id": last_seq_id,
                    "events": all_events,
                    "content": [{ "type": "text", "text": format!("Executed batch up to seq_id {last_seq_id}") }]
                });
                (StatusCode::OK, Json(JsonRpcResponse::success(req_id, out))).into_response()
            }
        }
        other => (
            StatusCode::OK,
            Json(JsonRpcResponse::error(
                req_id,
                -32601,
                format!("unknown tool: {other}"),
            )),
        )
            .into_response(),
    }
}

async fn handle_resources_read(
    state: &AppState,
    caller: &McpCaller,
    req_id: Value,
    params: Value,
) -> Response {
    let Some(uri) = params.get("uri").and_then(Value::as_str) else {
        return (
            StatusCode::OK,
            Json(JsonRpcResponse::error(
                req_id,
                -32602,
                "missing 'uri' in resources/read params",
            )),
        )
            .into_response();
    };

    let Some(rest) = uri.strip_prefix("trame://campaigns/") else {
        return (
            StatusCode::OK,
            Json(JsonRpcResponse::error(
                req_id,
                -32602,
                format!("unsupported resource URI scheme: {uri}"),
            )),
        )
            .into_response();
    };

    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() != 2 {
        return (
            StatusCode::OK,
            Json(JsonRpcResponse::error(
                req_id,
                -32602,
                format!("malformed campaign resource URI: {uri}"),
            )),
        )
            .into_response();
    }

    let Ok(campaign_id) = Uuid::parse_str(parts[0]) else {
        return (
            StatusCode::OK,
            Json(JsonRpcResponse::error(
                req_id,
                -32602,
                "invalid campaign UUID in resource URI",
            )),
        )
            .into_response();
    };

    if authorize_campaign_gm(state, caller, campaign_id)
        .await
        .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(JsonRpcResponse::error(
                req_id,
                -32003,
                "forbidden: caller is not an authorized GameMaster for this campaign",
            )),
        )
            .into_response();
    }

    match parts[1] {
        "timeline" => {
            let entries = state
                .timeline_storage
                .get_timeline(&campaign_id.to_string(), 1, 0, 100)
                .map(|resp| resp.events)
                .unwrap_or_default();
            let text_json = serde_json::to_string(&entries).unwrap_or_else(|_| "[]".to_string());
            let result = json!({
                "contents": [{
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": text_json
                }]
            });
            (
                StatusCode::OK,
                Json(JsonRpcResponse::success(req_id, result)),
            )
                .into_response()
        }
        "notes" => {
            let notes = crate::http::list_campaign_notes_internal(state, campaign_id).await;
            let text_json = serde_json::to_string(&notes).unwrap_or_else(|_| "[]".to_string());
            let result = json!({
                "contents": [{
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": text_json
                }]
            });
            (
                StatusCode::OK,
                Json(JsonRpcResponse::success(req_id, result)),
            )
                .into_response()
        }
        other => (
            StatusCode::OK,
            Json(JsonRpcResponse::error(
                req_id,
                -32602,
                format!("unsupported campaign resource kind: {other}"),
            )),
        )
            .into_response(),
    }
}
