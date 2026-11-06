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
use crate::http::{AppState, resolve_authenticated_user, resolve_campaign_role};
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

    let user_id = resolve_authenticated_user(state, headers).await?;
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
    if resolve_campaign_role(state, campaign_id, caller.user_id).await != Some(CampaignRole::Gm) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(())
}

/// Wraps the `schemars` schema of `TrameCommand` into a tool `inputSchema`: the command
/// definitions move to the root `$defs` (so every `#/$defs/...` reference resolves from the
/// tool schema root) and `command_slot(ref)` places the `TrameCommand` reference.
fn tool_schema(
    required: &[&str],
    command_slot: impl FnOnce(Value) -> (String, Value),
    extra: Value,
) -> Value {
    let mut root =
        serde_json::to_value(schemars::schema_for!(TrameCommand)).unwrap_or_else(|_| json!({}));
    let mut defs = root
        .as_object_mut()
        .and_then(|o| o.remove("$defs"))
        .unwrap_or_else(|| json!({}));
    if let Some(o) = root.as_object_mut() {
        o.remove("$schema");
    }
    defs["TrameCommand"] = root;
    let (slot_name, slot_schema) = command_slot(json!({ "$ref": "#/$defs/TrameCommand" }));
    let mut properties = json!({
        "campaign_id": { "type": "string", "format": "uuid" },
        "summary": { "type": "string" },
    });
    properties[slot_name] = slot_schema;
    if let (Some(props), Some(extra)) = (properties.as_object_mut(), extra.as_object()) {
        props.extend(extra.clone());
    }
    json!({
        "type": "object",
        "required": required,
        "properties": properties,
        "$defs": defs,
    })
}

/// `tools/list` result; command schemas are generated from `TrameCommand` (A13).
pub fn tools_list() -> Value {
    let staging_flag = json!({
        "mcp_staging_mode": {
            "type": "boolean",
            "default": false,
            "description": "Stage instead of executing; forced on when the campaign setting is enabled."
        }
    });
    let batch = |r: Value| {
        (
            "commands".to_string(),
            json!({ "type": "array", "minItems": 1, "maxItems": MAX_MCP_BATCH_COMMANDS, "items": r }),
        )
    };
    json!({
        "tools": [
            {
                "name": "trame.dispatch_command",
                "description": "Dispatches a single authoritative TrameCommand to a campaign room (staged when mcp_staging_mode or the campaign staging setting is on).",
                "inputSchema": tool_schema(
                    &["campaign_id", "command"],
                    |r| ("command".to_string(), r),
                    staging_flag.clone(),
                ),
            },
            {
                "name": "mcp.execute_batch",
                "description": "Applies up to 25 TrameCommands atomically as one undoable step (staged when mcp_staging_mode or the campaign staging setting is on).",
                "inputSchema": tool_schema(&["campaign_id", "commands"], batch, staging_flag),
            },
            {
                "name": "mcp.stage_encounter",
                "description": "Stages an encounter batch (up to 25 TrameCommands) as a dry-run McpStagingProposal for GM approval on the tabletop.",
                "inputSchema": tool_schema(&["campaign_id", "commands"], batch, json!({})),
            }
        ]
    })
}

/// Fills `ActivateScene` payloads from storage so staged and executed commands never carry
/// client-supplied geometry, and takes an actor-linked `SpawnToken`'s reach and darkvision
/// from the stored sheet.
async fn resolve_commands(
    state: &AppState,
    campaign_id: Uuid,
    commands: Vec<TrameCommand>,
) -> Result<Vec<TrameCommand>, String> {
    let mut out = Vec::with_capacity(commands.len());
    for cmd in commands {
        let cmd = crate::campaigns::resolve_linked_spawn(state, campaign_id, cmd).await;
        out.push(crate::maps::resolve_scene_command(state, campaign_id, cmd).await?);
    }
    Ok(out)
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
        "tools/list" => (
            StatusCode::OK,
            Json(JsonRpcResponse::success(req_id, tools_list())),
        )
            .into_response(),
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

    let rpc_error = |code: i32, msg: String| {
        (
            StatusCode::OK,
            Json(JsonRpcResponse::error(req_id.clone(), code, msg)),
        )
            .into_response()
    };

    let raw_commands: Vec<Value> = match tool_name {
        "trame.dispatch_command" => match args.get("command") {
            Some(c) => vec![c.clone()],
            None => return rpc_error(-32602, "missing 'command' argument".to_string()),
        },
        "mcp.execute_batch" | "mcp.stage_encounter" => {
            match args.get("commands").and_then(Value::as_array) {
                Some(arr) => arr.clone(),
                None => return rpc_error(-32602, "missing 'commands' array argument".to_string()),
            }
        }
        other => return rpc_error(-32601, format!("unknown tool: {other}")),
    };
    if raw_commands.is_empty() || raw_commands.len() > MAX_MCP_BATCH_COMMANDS {
        return rpc_error(
            -32602,
            format!(
                "batch must contain between 1 and {MAX_MCP_BATCH_COMMANDS} commands (got {})",
                raw_commands.len()
            ),
        );
    }
    let mut commands = Vec::with_capacity(raw_commands.len());
    for raw in raw_commands {
        match serde_json::from_value::<TrameCommand>(raw) {
            Ok(c) => commands.push(c),
            Err(e) => return rpc_error(-32602, format!("invalid TrameCommand payload: {e}")),
        }
    }
    let commands = match resolve_commands(state, campaign_id, commands).await {
        Ok(c) => c,
        Err(e) => return rpc_error(-32602, e),
    };

    let setting_staging = match crate::campaigns::load_settings(state, campaign_id).await {
        Ok(s) => s.mcp_staging_mode,
        Err(e) => return rpc_error(-32603, e),
    };
    let requested_staging = args
        .get("mcp_staging_mode")
        .or_else(|| args.get("staging"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let stage = tool_name == "mcp.stage_encounter" || requested_staging || setting_staging;

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
    let summary = args
        .get("summary")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("MCP {tool_name} ({} commands)", commands.len()));

    if stage {
        let proposal = McpStagingProposal {
            proposal_id: Uuid::new_v4(),
            summary,
            commands,
        };
        return match room.stage_mcp_proposal(proposal).await {
            Ok(staged) => {
                let out = json!({
                    "staged": true,
                    "proposal_id": staged.proposal_id,
                    "proposal": staged,
                    "content": [{ "type": "text", "text": format!("Staged proposal {}", staged.proposal_id) }]
                });
                (StatusCode::OK, Json(JsonRpcResponse::success(req_id, out))).into_response()
            }
            Err(e) => rpc_error(-32603, e.to_string()),
        };
    }

    let actor = CommandActor {
        user_id: caller.user_id,
        role: CampaignRole::Gm,
    };
    let result = if tool_name == "trame.dispatch_command" {
        let cmd = commands.into_iter().next().expect("one command");
        room.dispatch_direct_command(actor, cmd).await
    } else {
        room.dispatch_batch(actor, commands, summary).await
    };
    match result {
        Ok((seq_id, events)) => {
            let out = json!({
                "staged": false,
                "seq_id": seq_id,
                "events": events,
                "content": [{ "type": "text", "text": format!("Executed at seq_id {seq_id}") }]
            });
            (StatusCode::OK, Json(JsonRpcResponse::success(req_id, out))).into_response()
        }
        Err(e) => rpc_error(-32000, e.to_string()),
    }
}

/// Pagination cursor parsed from a `trame://campaigns/{id}/timeline?...` URI.
///
/// Unknown or malformed parameters fall back to their defaults so an agent
/// asking for `?after=abc` still gets the first page instead of an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimelineCursor {
    /// Session number (`session_num`), defaults to `1`.
    pub session_num: u32,
    /// Exclusive `seq_id` lower bound (`after`), defaults to `0`.
    pub after: u64,
    /// Page size (`limit`), defaults to `100`; storage clamps it to `1..=200`.
    pub limit: usize,
}

impl TimelineCursor {
    /// Parses a raw `a=1&b=2` query string (without the leading `?`).
    pub fn parse(query: &str) -> Self {
        let mut cursor = Self {
            session_num: 1,
            after: 0,
            limit: 100,
        };
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            match key {
                "session_num" => cursor.session_num = value.parse().unwrap_or(cursor.session_num),
                "after" => cursor.after = value.parse().unwrap_or(cursor.after),
                "limit" => cursor.limit = value.parse().unwrap_or(cursor.limit),
                _ => {}
            }
        }
        cursor
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

    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let parts: Vec<&str> = path.split('/').collect();
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
            let cursor = TimelineCursor::parse(query);
            let page = match state.timeline_storage.get_timeline(
                &campaign_id.to_string(),
                cursor.session_num,
                cursor.after,
                cursor.limit,
            ) {
                Ok(page) => page,
                Err(e) => {
                    return (
                        StatusCode::OK,
                        Json(JsonRpcResponse::error(req_id, -32603, e.to_string())),
                    )
                        .into_response();
                }
            };
            let text_json = serde_json::to_string(&page).unwrap_or_else(|_| "{}".to_string());
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
