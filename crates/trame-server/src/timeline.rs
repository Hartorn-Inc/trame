use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TimelineError {
    #[error("Storage lock poisoned")]
    LockPoisoned,
    #[error("Invalid limit: {0}")]
    InvalidLimit(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionTimelineEvent {
    pub seq_id: u64,
    pub timestamp: u64,
    pub event_type: String,
    pub actor_id: Option<String>,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppendEventInput {
    pub event_type: String,
    pub actor_id: Option<String>,
    pub payload: serde_json::Value,
    pub timestamp: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionTimelineResponse {
    pub campaign_id: String,
    pub session_num: u32,
    pub session_id: String,
    pub events: Vec<SessionTimelineEvent>,
    pub has_more: bool,
}

pub trait TimelineStorage: Send + Sync {
    fn append_event(
        &self,
        campaign_id: &str,
        session_num: u32,
        event: AppendEventInput,
    ) -> Result<SessionTimelineEvent, TimelineError>;

    fn get_timeline(
        &self,
        campaign_id: &str,
        session_num: u32,
        after_seq: u64,
        limit: usize,
    ) -> Result<SessionTimelineResponse, TimelineError>;
}

#[derive(Default)]
struct SessionLog {
    lock: Mutex<()>, // Serializes appends for this session
    events: RwLock<Vec<SessionTimelineEvent>>,
}

#[derive(Default, Clone)]
pub struct InMemoryTimelineStorage {
    sessions: Arc<RwLock<HashMap<(String, u32), Arc<SessionLog>>>>,
}

impl InMemoryTimelineStorage {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    fn get_or_create_log(&self, campaign_id: &str, session_num: u32) -> Arc<SessionLog> {
        let key = (campaign_id.to_string(), session_num);
        {
            let reader = self.sessions.read().expect("sessions read lock");
            if let Some(log) = reader.get(&key) {
                return log.clone();
            }
        }
        let mut writer = self.sessions.write().expect("sessions write lock");
        writer.entry(key).or_default().clone()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl TimelineStorage for InMemoryTimelineStorage {
    fn append_event(
        &self,
        campaign_id: &str,
        session_num: u32,
        input: AppendEventInput,
    ) -> Result<SessionTimelineEvent, TimelineError> {
        let log = self.get_or_create_log(campaign_id, session_num);
        // Acquire per-session mutex ensuring strictly monotonic, contiguous sequence allocation under concurrency
        let _guard = log.lock.lock().map_err(|_| TimelineError::LockPoisoned)?;
        let mut events = log
            .events
            .write()
            .map_err(|_| TimelineError::LockPoisoned)?;

        let next_seq = (events.len() as u64) + 1;
        let timestamp = input.timestamp.unwrap_or_else(now_ms);

        let event = SessionTimelineEvent {
            seq_id: next_seq,
            timestamp,
            event_type: input.event_type,
            actor_id: input.actor_id,
            payload: input.payload,
        };

        events.push(event.clone());
        Ok(event)
    }

    fn get_timeline(
        &self,
        campaign_id: &str,
        session_num: u32,
        after_seq: u64,
        limit: usize,
    ) -> Result<SessionTimelineResponse, TimelineError> {
        let effective_limit = limit.clamp(1, 200);
        let log = self.get_or_create_log(campaign_id, session_num);
        let events = log.events.read().map_err(|_| TimelineError::LockPoisoned)?;

        let eligible: Vec<SessionTimelineEvent> = events
            .iter()
            .filter(|e| e.seq_id > after_seq)
            .cloned()
            .collect();

        let has_more = eligible.len() > effective_limit;
        let page: Vec<SessionTimelineEvent> = eligible.into_iter().take(effective_limit).collect();

        Ok(SessionTimelineResponse {
            campaign_id: campaign_id.to_string(),
            session_num,
            session_id: format!("{campaign_id}:{session_num}"),
            events: page,
            has_more,
        })
    }
}

/// Formats session timeline events as Markdown for LLM ingestion via the MCP tool `get_session_timeline`.
pub fn format_mcp_timeline(
    campaign_id: &str,
    session_num: u32,
    events: &[SessionTimelineEvent],
) -> (String, String) {
    let resource_uri = format!("campaign://{campaign_id}/sessions/{session_num}/timeline");
    let mut md = format!("# Session Timeline: Campaign {campaign_id}, Session {session_num}\n\n");

    for ev in events {
        let actor_str = ev.actor_id.as_deref().unwrap_or("System");
        let payload_str = ev.payload.to_string();
        md.push_str(&format!(
            "- [seq {}] [{}] ({}): {}\n",
            ev.seq_id, ev.event_type, actor_str, payload_str
        ));
    }

    (resource_uri, md)
}
