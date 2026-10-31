use crate::timeline::{AppendEventInput, TimelineError, TimelineStorage};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use trame_engine::commands::CampaignRole;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NoteVisibility {
    Private,
    Party,
    DmOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteAccessDecision {
    Ok,
    Forbidden,
    NotFound,
}

pub fn evaluate_note_access(
    visibility: NoteVisibility,
    owner_user_id: &str,
    requesting_user_id: &str,
    requesting_role: UserRole,
    is_write: bool,
) -> NoteAccessDecision {
    match visibility {
        NoteVisibility::Private => {
            if owner_user_id == requesting_user_id {
                NoteAccessDecision::Ok
            } else {
                NoteAccessDecision::NotFound
            }
        }
        NoteVisibility::DmOnly => {
            if requesting_role == UserRole::GameMaster {
                NoteAccessDecision::Ok
            } else {
                NoteAccessDecision::Forbidden
            }
        }
        NoteVisibility::Party => {
            if is_write && requesting_role == UserRole::Spectator {
                NoteAccessDecision::Forbidden
            } else {
                NoteAccessDecision::Ok
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum UserRole {
    GameMaster,
    Player,
    Spectator,
}

impl From<CampaignRole> for UserRole {
    fn from(role: CampaignRole) -> Self {
        match role {
            CampaignRole::Gm => UserRole::GameMaster,
            CampaignRole::Player => UserRole::Player,
            CampaignRole::Spectator => UserRole::Spectator,
        }
    }
}

impl From<UserRole> for CampaignRole {
    fn from(role: UserRole) -> Self {
        match role {
            UserRole::GameMaster => CampaignRole::Gm,
            UserRole::Player => CampaignRole::Player,
            UserRole::Spectator => CampaignRole::Spectator,
        }
    }
}

#[derive(Debug, Error)]
pub enum NotesError {
    #[error("Permission denied: {0}")]
    Forbidden(String),
    #[error("Storage lock poisoned")]
    LockPoisoned,
    #[error("Timeline error: {0}")]
    Timeline(#[from] TimelineError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartyJournalEntry {
    pub handout_id: String,
    pub campaign_id: String,
    pub title: String,
    pub content: String,
    pub revealed_at: u64,
    pub revealed_by: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevealHandoutCommand {
    pub action: String,
    pub campaign_id: String,
    pub session_num: u32,
    pub handout_id: String,
    pub title: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoutRevealedBroadcast {
    pub event: String,
    pub handout_id: String,
    pub title: String,
    pub content: String,
    pub revealed_by: String,
    pub timestamp: u64,
}

pub trait PartyJournalStorage: Send + Sync {
    fn insert_entry(&self, entry: PartyJournalEntry) -> Result<(), NotesError>;
    fn list_entries(&self, campaign_id: &str) -> Result<Vec<PartyJournalEntry>, NotesError>;
    fn get_entry(&self, handout_id: &str) -> Result<Option<PartyJournalEntry>, NotesError>;
}

#[derive(Default)]
pub struct InMemoryPartyJournalStorage {
    entries: RwLock<HashMap<String, PartyJournalEntry>>,
}

impl InMemoryPartyJournalStorage {
    pub fn new() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
        }
    }
}

impl PartyJournalStorage for InMemoryPartyJournalStorage {
    fn insert_entry(&self, entry: PartyJournalEntry) -> Result<(), NotesError> {
        let mut map = self.entries.write().map_err(|_| NotesError::LockPoisoned)?;
        map.insert(entry.handout_id.clone(), entry);
        Ok(())
    }

    fn list_entries(&self, campaign_id: &str) -> Result<Vec<PartyJournalEntry>, NotesError> {
        let map = self.entries.read().map_err(|_| NotesError::LockPoisoned)?;
        let mut list: Vec<PartyJournalEntry> = map
            .values()
            .filter(|e| e.campaign_id == campaign_id)
            .cloned()
            .collect();
        list.sort_by(|a, b| b.revealed_at.cmp(&a.revealed_at));
        Ok(list)
    }

    fn get_entry(&self, handout_id: &str) -> Result<Option<PartyJournalEntry>, NotesError> {
        let map = self.entries.read().map_err(|_| NotesError::LockPoisoned)?;
        Ok(map.get(handout_id).cloned())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectiveAstNode {
    Text(String),
    DmDirective {
        raw: String,
        content: String,
    },
    HandoutDirective {
        raw: String,
        id: String,
        title: String,
        revealed: bool,
        content: String,
    },
}

impl DirectiveAstNode {
    pub fn is_confidential(&self) -> bool {
        match self {
            DirectiveAstNode::DmDirective { .. } => true,
            DirectiveAstNode::HandoutDirective { revealed, .. } => !*revealed,
            DirectiveAstNode::Text(_) => false,
        }
    }

    pub fn raw_string(&self) -> &str {
        match self {
            DirectiveAstNode::Text(t) => t.as_str(),
            DirectiveAstNode::DmDirective { raw, .. } => raw.as_str(),
            DirectiveAstNode::HandoutDirective { raw, .. } => raw.as_str(),
        }
    }
}

pub fn parse_markdown_ast(markdown: &str) -> Vec<DirectiveAstNode> {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut nodes = Vec::new();
    let mut text_lines: Vec<&str> = Vec::new();
    let mut idx = 0;

    let flush_text = |nodes: &mut Vec<DirectiveAstNode>, text_lines: &mut Vec<&str>| {
        if !text_lines.is_empty() {
            nodes.push(DirectiveAstNode::Text(text_lines.join("\n")));
            text_lines.clear();
        }
    };

    while idx < lines.len() {
        let line = lines[idx];
        let trimmed = line.trim();

        if trimmed == ":::dm" {
            flush_text(&mut nodes, &mut text_lines);
            let mut raw_lines = vec![line];
            let mut content_lines = Vec::new();
            idx += 1;
            while idx < lines.len() {
                let inner = lines[idx];
                raw_lines.push(inner);
                if inner.trim() == ":::" {
                    idx += 1;
                    break;
                }
                content_lines.push(inner);
                idx += 1;
            }
            nodes.push(DirectiveAstNode::DmDirective {
                raw: raw_lines.join("\n"),
                content: content_lines.join("\n"),
            });
            continue;
        }

        if trimmed.starts_with(":::handout") {
            flush_text(&mut nodes, &mut text_lines);
            let revealed = parse_handout_revealed_attr(trimmed);
            let mut raw_lines = vec![line];
            let mut content_lines = Vec::new();
            idx += 1;
            while idx < lines.len() {
                let inner = lines[idx];
                raw_lines.push(inner);
                if inner.trim() == ":::" {
                    idx += 1;
                    break;
                }
                content_lines.push(inner);
                idx += 1;
            }
            nodes.push(DirectiveAstNode::HandoutDirective {
                raw: raw_lines.join("\n"),
                id: String::new(),
                title: String::new(),
                revealed,
                content: content_lines.join("\n"),
            });
            continue;
        }

        text_lines.push(line);
        idx += 1;
    }

    flush_text(&mut nodes, &mut text_lines);
    nodes
}

/// Merges player-submitted Markdown mutations with stored note Markdown preserving confidential directives.
/// Reinserts stripped `:::dm` and unrevealed `:::handout` directive blocks into player-submitted Markdown.
pub fn merge_party_note_ast(stored_content: &str, player_content: &str) -> String {
    let stored_ast = parse_markdown_ast(stored_content);
    let confidential_nodes: Vec<(usize, &DirectiveAstNode)> = stored_ast
        .iter()
        .enumerate()
        .filter(|(_, n)| n.is_confidential())
        .collect();

    if confidential_nodes.is_empty() {
        return player_content.to_string();
    }

    let mut player_lines: Vec<String> = player_content
        .split('\n')
        .map(ToString::to_string)
        .collect();
    let mut last_insert_idx = 0usize;

    for (ast_idx, node) in confidential_nodes {
        let raw_block = node.raw_string();
        if player_content.contains(raw_block) {
            continue;
        }

        // Determine preceding and following anchor lines from stored AST
        let next_anchor_lines: Vec<&str> = stored_ast[ast_idx + 1..]
            .iter()
            .flat_map(|n| n.raw_string().split('\n'))
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();

        let prev_anchor_lines: Vec<&str> = stored_ast[..ast_idx]
            .iter()
            .rev()
            .flat_map(|n| n.raw_string().split('\n').rev())
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();

        let mut target_line_idx = None;

        if let Some(target_line) = next_anchor_lines.first() {
            for (i, p_line) in player_lines.iter().enumerate().skip(last_insert_idx) {
                if p_line.trim() == *target_line {
                    target_line_idx = Some(i);
                    break;
                }
            }
        }

        if target_line_idx.is_none()
            && let Some(prev_line) = prev_anchor_lines.first()
        {
            for (i, p_line) in player_lines.iter().enumerate().skip(last_insert_idx) {
                if p_line.trim() == *prev_line {
                    target_line_idx = Some(i + 1);
                    break;
                }
            }
        }

        let insert_at = target_line_idx.unwrap_or(player_lines.len());
        let mut block_lines_to_insert: Vec<String> =
            raw_block.split('\n').map(ToString::to_string).collect();

        if insert_at > 0 && !player_lines[insert_at - 1].trim().is_empty() {
            block_lines_to_insert.insert(0, String::new());
        }
        if insert_at < player_lines.len() && !player_lines[insert_at].trim().is_empty() {
            block_lines_to_insert.push(String::new());
        }

        for (offset, line) in block_lines_to_insert.into_iter().enumerate() {
            player_lines.insert(insert_at + offset, line);
        }
        last_insert_idx = insert_at + 1;
    }

    player_lines.join("\n")
}

pub struct FilteredNoteDocument;

impl FilteredNoteDocument {
    /// Pure function filtering raw Markdown notes based on user role.
    /// Preserves everything for GameMaster;
    /// Completely purges all `:::dm` blocks and unrevealed `:::handout` (`revealed="false"`) blocks for non-GM.
    pub fn filter_for_role(raw_content: &str, role: UserRole) -> String {
        if role == UserRole::GameMaster {
            return raw_content.to_string();
        }

        let lines: Vec<&str> = raw_content.split('\n').collect();
        let mut output_lines: Vec<&str> = Vec::with_capacity(lines.len());
        let mut idx = 0;

        while idx < lines.len() {
            let line = lines[idx];
            let trimmed = line.trim();

            if trimmed == ":::dm" {
                idx += 1;
                while idx < lines.len() {
                    if lines[idx].trim() == ":::" {
                        idx += 1;
                        break;
                    }
                    idx += 1;
                }
                continue;
            }

            if trimmed.starts_with(":::handout") {
                let is_revealed = parse_handout_revealed_attr(trimmed);
                if !is_revealed {
                    idx += 1;
                    while idx < lines.len() {
                        if lines[idx].trim() == ":::" {
                            idx += 1;
                            break;
                        }
                        idx += 1;
                    }
                    continue;
                }
            }

            output_lines.push(line);
            idx += 1;
        }

        output_lines.join("\n")
    }

    /// Merges player mutations into a stored note document preserving confidential directives.
    pub fn merge_party_note_ast(stored_content: &str, player_content: &str) -> String {
        merge_party_note_ast(stored_content, player_content)
    }
}

fn tokenize_directive_attrs(input: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut in_quote: Option<char> = None;
    let mut token_start: Option<usize> = None;
    let mut escaped = false;

    for (idx, ch) in input.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
            if token_start.is_none() {
                token_start = Some(idx);
            }
            continue;
        }

        match in_quote {
            Some(q) => {
                if ch == q {
                    in_quote = None;
                }
            }
            None => {
                if ch == '"' || ch == '\'' {
                    in_quote = Some(ch);
                    if token_start.is_none() {
                        token_start = Some(idx);
                    }
                } else if ch.is_whitespace() {
                    if let Some(start) = token_start {
                        tokens.push(&input[start..idx]);
                        token_start = None;
                    }
                } else if token_start.is_none() {
                    token_start = Some(idx);
                }
            }
        }
    }

    if let Some(start) = token_start {
        tokens.push(&input[start..]);
    }

    tokens
}

pub(crate) fn parse_handout_revealed_attr(header: &str) -> bool {
    let Some(start_brace) = header.find('{') else {
        return false;
    };
    let Some(end_brace) = header.rfind('}') else {
        return false;
    };
    if end_brace <= start_brace {
        return false;
    }
    let attrs_str = &header[start_brace + 1..end_brace];
    for part in tokenize_directive_attrs(attrs_str) {
        if let Some((k, v)) = part.split_once('=') {
            let key = k.trim().trim_matches('"').trim_matches('\'');
            let val = v.trim().trim_matches('"').trim_matches('\'');
            if key == "revealed" {
                return val.eq_ignore_ascii_case("true");
            }
        }
    }
    false
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Executes the handout reveal pipeline:
/// 1. Enforces GM-only RBAC
/// 2. Persists entry to Party Journal storage
/// 3. Appends HandoutRevealed event to Session Timeline
/// 4. Returns HandoutRevealedBroadcast for WebSocket fan-out
pub fn reveal_handout(
    actor_role: UserRole,
    actor_user_id: &str,
    cmd: RevealHandoutCommand,
    journal_storage: &dyn PartyJournalStorage,
    timeline_storage: &dyn TimelineStorage,
) -> Result<HandoutRevealedBroadcast, NotesError> {
    if actor_role != UserRole::GameMaster {
        return Err(NotesError::Forbidden(
            "Only users with GameMaster role can reveal handouts to the party".to_string(),
        ));
    }

    let timestamp = now_ms();
    let journal_entry = PartyJournalEntry {
        handout_id: cmd.handout_id.clone(),
        campaign_id: cmd.campaign_id.clone(),
        title: cmd.title.clone(),
        content: cmd.content.clone(),
        revealed_at: timestamp,
        revealed_by: actor_user_id.to_string(),
    };

    journal_storage.insert_entry(journal_entry)?;

    let event_payload = serde_json::json!({
        "handout_id": cmd.handout_id,
        "title": cmd.title,
    });

    timeline_storage.append_event(
        &cmd.campaign_id,
        cmd.session_num,
        AppendEventInput {
            event_type: "handout_revealed".to_string(),
            actor_id: Some(actor_user_id.to_string()),
            payload: event_payload,
            timestamp: Some(timestamp),
        },
    )?;

    Ok(HandoutRevealedBroadcast {
        event: "handout.revealed".to_string(),
        handout_id: cmd.handout_id,
        title: cmd.title,
        content: cmd.content,
        revealed_by: actor_user_id.to_string(),
        timestamp,
    })
}
