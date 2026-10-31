//! ============================================================================
//! PURPOSE:
//!   Authoritative PostgreSQL 18 (`sqlx::PgPool`) storage implementation
//!   (`SqlxPostgresStore`) satisfying all TRAME persistence traits (`WalStorage`,
//!   `SessionStore`, `IdentityStore`, `PatStore`, `OAuthStore`,
//!   `CampaignImportTarget`, `CampaignMembershipValidator`,
//!   `PartyJournalStorage`, `TimelineStorage`, and `AssetStore`).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Every state-mutating `TrameCommand` event is persisted into `wal_entries`
//!     via `sqlx::query` before WebSocket broadcast.
//!   - All queries use parameterized binds (`$1`, `$2`, ...) to prevent SQL
//!     injection.
//!   - Ephemeral users created via Magic Link redemption use deterministic
//!     `ephemeral_<UUID>@trame.local` emails and `is_ephemeral = TRUE`.
//! ============================================================================

use crate::archive::exporter::{ExportEntity, NoteRecord};
use crate::archive::importer::{ArchiveError, CampaignImportTarget};
use crate::archive::manifest::CampaignMetadata;
use crate::assets::store::{AssetStore, AssetStoreError};
use crate::auth::magic_link::{hmac_sha256, now_epoch_seconds};
use crate::auth::oauth::{OAuthError, OAuthProvider, OAuthStore, PendingOAuthState};
use crate::auth::password::IdentityStore;
use crate::auth::pat::{PatError, PatRecord, PatStore};
use crate::auth::session::{
    BoxFuture, CampaignMemberRecord, SessionError, SessionRecord, SessionStore, UserRecord,
};
use crate::http::CampaignMembershipValidator;
use crate::notes::{NotesError, PartyJournalEntry, PartyJournalStorage};
use crate::timeline::{
    AppendEventInput, SessionTimelineEvent, SessionTimelineResponse, TimelineError, TimelineStorage,
};
use crate::wal::{TableStateSnapshot, WalEntry, WalError, WalStorage};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use uuid::Uuid;

/// Campaign summary record returned in lobby listings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignRecord {
    pub id: Uuid,
    pub name: String,
    pub system_id: String,
    pub gm_user_id: Uuid,
    pub active_scene_id: Option<Uuid>,
    pub description: Option<String>,
    pub created_at: String,
}

/// Campaign note record with role-based visibility.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignNoteItem {
    pub campaign_id: Uuid,
    pub slug: String,
    pub id: Uuid,
    pub title: String,
    pub content_markdown: String,
    pub min_role: String,
    pub folder: Option<String>,
    pub author_id: Option<Uuid>,
    pub created_at: String,
    pub updated_at: String,
}

/// Helper to run an async database operation inside a synchronous trait method
/// without panicking if called from a multi-threaded or current-thread Tokio runtime.
fn run_pg_blocking<F, T>(fut: F) -> T
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build current_thread runtime for pg operation");
        rt.block_on(fut)
    })
    .join()
    .expect("pg worker thread panicked")
}

/// Authoritative PostgreSQL 18 storage engine backed by `sqlx::PgPool`.
#[derive(Clone)]
pub struct SqlxPostgresStore {
    pool: PgPool,
    pending_oauth: Arc<RwLock<HashMap<String, PendingOAuthState>>>,
    signing_secret: Vec<u8>,
    base_url: String,
}

impl SqlxPostgresStore {
    /// Creates a new `SqlxPostgresStore` bound to an active `PgPool`.
    pub fn new(pool: PgPool) -> Self {
        let signing_secret = std::env::var("TRAME_JWT_SECRET")
            .or_else(|_| std::env::var("JWT_SECRET"))
            .map(|s| s.into_bytes())
            .unwrap_or_else(|_| b"trame-default-hmac-sha256-signing-secret-key".to_vec());
        Self {
            pool,
            pending_oauth: Arc::new(RwLock::new(HashMap::new())),
            signing_secret,
            base_url: "/assets/download".to_string(),
        }
    }

    /// Connects to PostgreSQL using `database_url` and runs embedded SQL migrations.
    pub async fn connect_and_migrate(
        database_url: &str,
        base_url: impl Into<String>,
    ) -> Result<Self, sqlx::Error> {
        let pool = PgPool::connect(database_url).await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        let mut store = Self::new(pool);
        store.base_url = base_url.into();
        Ok(store)
    }

    /// Verifies PostgreSQL connectivity with `SELECT 1`.
    pub async fn check_health(&self) -> bool {
        sqlx::query("SELECT 1").execute(&self.pool).await.is_ok()
    }

    /// Fetches a `CampaignMetadata` record by `campaign_id`.
    pub async fn get_campaign_async(
        &self,
        campaign_id: Uuid,
    ) -> Result<Option<CampaignMetadata>, String> {
        let details = self.get_campaign_details(campaign_id).await?;
        Ok(details.map(|(c, _)| CampaignMetadata {
            id: c.id,
            name: c.name,
            system: c.system_id,
            description: c.description,
            created_at: c.created_at,
        }))
    }

    /// Lists all `ExportEntity` records for `campaign_id`.
    pub async fn list_entities_for_campaign_async(
        &self,
        campaign_id: Uuid,
    ) -> Result<Vec<ExportEntity>, String> {
        let rows = self.list_entities_for_campaign(campaign_id).await?;
        Ok(rows
            .into_iter()
            .map(|(_id, entity_type, _owner, data)| ExportEntity { entity_type, data })
            .collect())
    }

    /// Lists all `NoteRecord` entries for `campaign_id`.
    pub async fn list_notes_for_campaign_async(
        &self,
        campaign_id: Uuid,
    ) -> Result<Vec<NoteRecord>, String> {
        let items = self.list_campaign_notes(campaign_id).await?;
        Ok(items
            .into_iter()
            .map(|item| NoteRecord {
                id: item.id,
                title: item.title,
                folder: item.folder,
                author_id: item.author_id.unwrap_or_else(Uuid::nil),
                created_at: item.created_at,
                updated_at: item.updated_at,
                content_markdown: item.content_markdown,
            })
            .collect())
    }

    /// Upserts a campaign note by `(campaign_id, slug)` and returns the resulting `NoteRecord`.
    pub async fn upsert_campaign_note_async(
        &self,
        campaign_id: Uuid,
        slug: &str,
        title: &str,
        folder: Option<&str>,
        author_id: Uuid,
        content_markdown: &str,
    ) -> Result<NoteRecord, String> {
        let id = Uuid::new_v4();
        let item = CampaignNoteItem {
            campaign_id,
            slug: slug.to_string(),
            id,
            title: title.to_string(),
            content_markdown: content_markdown.to_string(),
            min_role: "PLAYER".to_string(),
            folder: folder.map(ToString::to_string),
            author_id: Some(author_id),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        };
        self.upsert_campaign_note(&item).await?;
        Ok(NoteRecord {
            id,
            title: title.to_string(),
            folder: folder.map(ToString::to_string),
            author_id,
            created_at: item.created_at,
            updated_at: item.updated_at,
            content_markdown: content_markdown.to_string(),
        })
    }

    /// Returns a reference to the underlying `PgPool`.
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Creates a new campaign and assigns the creator as `GM` in `campaign_members`.
    pub async fn create_campaign(
        &self,
        id: Uuid,
        name: &str,
        system_id: &str,
        gm_user_id: Uuid,
        description: Option<&str>,
    ) -> Result<CampaignRecord, String> {
        sqlx::query(
            "INSERT INTO campaigns (id, name, system_id, gm_user_id, description)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, system_id = EXCLUDED.system_id, updated_at = NOW()",
        )
        .bind(id)
        .bind(name)
        .bind(system_id)
        .bind(gm_user_id)
        .bind(description)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            "INSERT INTO campaign_members (campaign_id, user_id, role)
             VALUES ($1, $2, 'GM')
             ON CONFLICT (campaign_id, user_id) DO UPDATE SET role = 'GM'",
        )
        .bind(id)
        .bind(gm_user_id)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(CampaignRecord {
            id,
            name: name.to_string(),
            system_id: system_id.to_string(),
            gm_user_id,
            active_scene_id: None,
            description: description.map(ToString::to_string),
            created_at: "2026-01-01T00:00:00Z".to_string(),
        })
    }

    /// Adds or updates a member in `campaign_members`.
    pub async fn upsert_campaign_member(
        &self,
        campaign_id: Uuid,
        user_id: Uuid,
        role: &str,
    ) -> Result<(), String> {
        let normalized_role = match role.to_uppercase().as_str() {
            "GM" | "DM" => "GM",
            "ASSISTANT_GM" => "ASSISTANT_GM",
            "SPECTATOR" => "SPECTATOR",
            _ => "PLAYER",
        };
        sqlx::query(
            "INSERT INTO campaign_members (campaign_id, user_id, role)
             VALUES ($1, $2, $3)
             ON CONFLICT (campaign_id, user_id) DO UPDATE SET role = EXCLUDED.role",
        )
        .bind(campaign_id)
        .bind(user_id)
        .bind(normalized_role)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Lists all campaigns where `user_id` is a member.
    pub async fn list_campaigns_for_user(
        &self,
        user_id: Uuid,
    ) -> Result<Vec<CampaignRecord>, String> {
        let rows = sqlx::query(
            "SELECT c.id, c.name, c.system_id, c.gm_user_id, c.active_scene_id, c.description,
                    EXTRACT(EPOCH FROM c.created_at)::BIGINT AS created_epoch
             FROM campaigns c
             INNER JOIN campaign_members cm ON cm.campaign_id = c.id
             WHERE cm.user_id = $1
             ORDER BY c.created_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let mut list = Vec::with_capacity(rows.len());
        for row in rows {
            list.push(CampaignRecord {
                id: row.try_get("id").map_err(|e| e.to_string())?,
                name: row.try_get("name").map_err(|e| e.to_string())?,
                system_id: row.try_get("system_id").map_err(|e| e.to_string())?,
                gm_user_id: row.try_get("gm_user_id").map_err(|e| e.to_string())?,
                active_scene_id: row.try_get("active_scene_id").ok().flatten(),
                description: row.try_get("description").ok().flatten(),
                created_at: format!("{}", row.try_get::<i64, _>("created_epoch").unwrap_or(0)),
            });
        }
        Ok(list)
    }

    /// Gets a single campaign by ID along with its member list.
    pub async fn get_campaign_details(
        &self,
        campaign_id: Uuid,
    ) -> Result<Option<(CampaignRecord, Vec<CampaignMemberRecord>)>, String> {
        let row_opt = sqlx::query(
            "SELECT id, name, system_id, gm_user_id, active_scene_id, description,
                    EXTRACT(EPOCH FROM created_at)::BIGINT AS created_epoch
             FROM campaigns WHERE id = $1",
        )
        .bind(campaign_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let Some(row) = row_opt else {
            return Ok(None);
        };

        let campaign = CampaignRecord {
            id: row.try_get("id").map_err(|e| e.to_string())?,
            name: row.try_get("name").map_err(|e| e.to_string())?,
            system_id: row.try_get("system_id").map_err(|e| e.to_string())?,
            gm_user_id: row.try_get("gm_user_id").map_err(|e| e.to_string())?,
            active_scene_id: row.try_get("active_scene_id").ok().flatten(),
            description: row.try_get("description").ok().flatten(),
            created_at: format!("{}", row.try_get::<i64, _>("created_epoch").unwrap_or(0)),
        };

        let member_rows = sqlx::query(
            "SELECT campaign_id, user_id, role, EXTRACT(EPOCH FROM joined_at)::BIGINT AS joined_epoch
             FROM campaign_members WHERE campaign_id = $1",
        )
        .bind(campaign_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let mut members = Vec::with_capacity(member_rows.len());
        for m in member_rows {
            members.push(CampaignMemberRecord {
                campaign_id: m.try_get("campaign_id").map_err(|e| e.to_string())?,
                user_id: m.try_get("user_id").map_err(|e| e.to_string())?,
                character_id: None,
                role: m.try_get("role").map_err(|e| e.to_string())?,
                joined_at: m.try_get::<i64, _>("joined_epoch").unwrap_or(0).max(0) as u64,
            });
        }

        Ok(Some((campaign, members)))
    }

    /// Upserts an authoritative entity (`actor`, `scene`, or `item`) into `campaign_entities`.
    pub async fn upsert_entity(
        &self,
        campaign_id: Uuid,
        entity_id: Uuid,
        entity_type: &str,
        owner_user_id: Option<Uuid>,
        payload: &serde_json::Value,
    ) -> Result<(), String> {
        self.ensure_campaign_row(campaign_id).await?;
        sqlx::query(
            "INSERT INTO campaign_entities (id, campaign_id, entity_type, owner_user_id, payload, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (campaign_id, id) DO UPDATE SET
               entity_type = EXCLUDED.entity_type,
               owner_user_id = COALESCE(EXCLUDED.owner_user_id, campaign_entities.owner_user_id),
               payload = EXCLUDED.payload,
               updated_at = NOW()",
        )
        .bind(entity_id)
        .bind(campaign_id)
        .bind(entity_type)
        .bind(owner_user_id)
        .bind(payload)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Queries all entities for a campaign.
    pub async fn list_entities_for_campaign(
        &self,
        campaign_id: Uuid,
    ) -> Result<Vec<(Uuid, String, Option<Uuid>, serde_json::Value)>, String> {
        let rows = sqlx::query(
            "SELECT id, entity_type, owner_user_id, payload
             FROM campaign_entities
             WHERE campaign_id = $1
             ORDER BY created_at ASC",
        )
        .bind(campaign_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push((
                row.try_get("id").map_err(|e| e.to_string())?,
                row.try_get("entity_type").map_err(|e| e.to_string())?,
                row.try_get("owner_user_id").ok().flatten(),
                row.try_get("payload").map_err(|e| e.to_string())?,
            ));
        }
        Ok(out)
    }

    /// Upserts a campaign note by `(campaign_id, slug)`.
    pub async fn upsert_campaign_note(&self, note: &CampaignNoteItem) -> Result<(), String> {
        self.ensure_campaign_row(note.campaign_id).await?;
        sqlx::query(
            "INSERT INTO campaign_notes (campaign_id, slug, id, title, content_markdown, min_role, folder, author_id, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             ON CONFLICT (campaign_id, slug) DO UPDATE SET
               title = EXCLUDED.title,
               content_markdown = EXCLUDED.content_markdown,
               min_role = EXCLUDED.min_role,
               folder = EXCLUDED.folder,
               updated_at = NOW()",
        )
        .bind(note.campaign_id)
        .bind(&note.slug)
        .bind(note.id)
        .bind(&note.title)
        .bind(&note.content_markdown)
        .bind(&note.min_role)
        .bind(&note.folder)
        .bind(note.author_id)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Lists all campaign notes for `campaign_id`.
    pub async fn list_campaign_notes(
        &self,
        campaign_id: Uuid,
    ) -> Result<Vec<CampaignNoteItem>, String> {
        let rows = sqlx::query(
            "SELECT campaign_id, slug, id, title, content_markdown, min_role, folder, author_id
             FROM campaign_notes
             WHERE campaign_id = $1
             ORDER BY slug ASC",
        )
        .bind(campaign_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let mut notes = Vec::with_capacity(rows.len());
        for row in rows {
            notes.push(CampaignNoteItem {
                campaign_id: row.try_get("campaign_id").map_err(|e| e.to_string())?,
                slug: row.try_get("slug").map_err(|e| e.to_string())?,
                id: row.try_get("id").map_err(|e| e.to_string())?,
                title: row.try_get("title").map_err(|e| e.to_string())?,
                content_markdown: row.try_get("content_markdown").map_err(|e| e.to_string())?,
                min_role: row.try_get("min_role").map_err(|e| e.to_string())?,
                folder: row.try_get("folder").ok().flatten(),
                author_id: row.try_get("author_id").ok().flatten(),
                created_at: "2026-01-01T00:00:00Z".to_string(),
                updated_at: "2026-01-01T00:00:00Z".to_string(),
            });
        }
        Ok(notes)
    }

    /// Deletes a session by token hash (used by logout).
    pub async fn delete_session_by_token_hash(&self, token_hash: &str) -> Result<(), String> {
        sqlx::query("DELETE FROM auth_sessions WHERE token_hash = $1")
            .bind(token_hash)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Ensures a placeholder user & campaign row exist when foreign keys require them in WAL/asset calls.
    pub async fn ensure_campaign_row(&self, campaign_id: Uuid) -> Result<(), String> {
        Self::ensure_campaign_row_on_pool(&self.pool, campaign_id).await
    }

    async fn ensure_campaign_row_on_pool(pool: &PgPool, campaign_id: Uuid) -> Result<(), String> {
        let exists: Option<Uuid> = sqlx::query_scalar("SELECT id FROM campaigns WHERE id = $1")
            .bind(campaign_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;

        if exists.is_some() {
            return Ok(());
        }

        let sys_user_id = Uuid::from_u128(1);
        sqlx::query(
            "INSERT INTO users (id, email, display_name, is_ephemeral, role)
             VALUES ($1, 'system@trame.local', 'System GM', FALSE, 'GM')
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(sys_user_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            "INSERT INTO campaigns (id, name, system_id, gm_user_id)
             VALUES ($1, 'Campaign', 'dnd5e', $2)
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(campaign_id)
        .bind(sys_user_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(())
    }
}

impl WalStorage for SqlxPostgresStore {
    fn append_entry(&self, entry: WalEntry) -> Result<(), WalError> {
        let pool = self.pool.clone();
        run_pg_blocking(async move {
            Self::ensure_campaign_row_on_pool(&pool, entry.campaign_id)
                .await
                .map_err(WalError::Serialization)?;
            let payload_json = serde_json::to_value(&entry)
                .map_err(|e| WalError::Serialization(e.to_string()))?;

            let event_type = entry
                .events
                .first()
                .map(|e| match e {
                    trame_engine::commands::TrameEvent::SceneLoaded { .. } => "SceneLoaded",
                    _ => "TrameCommand",
                })
                .unwrap_or("TrameCommand");

            sqlx::query(
                "INSERT INTO wal_entries (campaign_id, sequence_num, event_type, payload)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (campaign_id, sequence_num) DO UPDATE SET
                   event_type = EXCLUDED.event_type,
                   payload = EXCLUDED.payload",
            )
            .bind(entry.campaign_id)
            .bind(entry.seq_id as i64)
            .bind(event_type)
            .bind(payload_json)
            .execute(&pool)
            .await
            .map_err(|e| WalError::Serialization(e.to_string()))?;
            Ok(())
        })
    }

    fn save_snapshot(&self, snapshot: TableStateSnapshot) -> Result<(), WalError> {
        let pool = self.pool.clone();
        run_pg_blocking(async move {
            Self::ensure_campaign_row_on_pool(&pool, snapshot.campaign_id)
                .await
                .map_err(WalError::Serialization)?;
            let bytes = rmp_serde::to_vec_named(&snapshot)
                .map_err(|e| WalError::Serialization(e.to_string()))?;

            sqlx::query(
                "INSERT INTO wal_snapshots (campaign_id, last_sequence_num, snapshot_data, created_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (campaign_id) DO UPDATE SET
                   last_sequence_num = EXCLUDED.last_sequence_num,
                   snapshot_data = EXCLUDED.snapshot_data,
                   created_at = NOW()",
            )
            .bind(snapshot.campaign_id)
            .bind(snapshot.snapshot_seq_id as i64)
            .bind(bytes)
            .execute(&pool)
            .await
            .map_err(|e| WalError::Serialization(e.to_string()))?;
            Ok(())
        })
    }

    fn load_latest_snapshot(
        &self,
        campaign_id: Uuid,
    ) -> Result<Option<TableStateSnapshot>, WalError> {
        let pool = self.pool.clone();
        run_pg_blocking(async move {
            let row_opt = sqlx::query(
                "SELECT snapshot_data FROM wal_snapshots WHERE campaign_id = $1",
            )
            .bind(campaign_id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| WalError::Serialization(e.to_string()))?;

            let Some(row) = row_opt else {
                return Ok(None);
            };
            let bytes: Vec<u8> = row
                .try_get("snapshot_data")
                .map_err(|e| WalError::Serialization(e.to_string()))?;
            let snap: TableStateSnapshot = rmp_serde::from_slice(&bytes)
                .map_err(|e| WalError::Serialization(e.to_string()))?;
            Ok(Some(snap))
        })
    }

    fn load_entries_after(
        &self,
        campaign_id: Uuid,
        after_seq_id: u64,
    ) -> Result<Vec<WalEntry>, WalError> {
        let pool = self.pool.clone();
        run_pg_blocking(async move {
            let rows = sqlx::query(
                "SELECT payload FROM wal_entries
                 WHERE campaign_id = $1 AND sequence_num > $2
                 ORDER BY sequence_num ASC",
            )
            .bind(campaign_id)
            .bind(after_seq_id as i64)
            .fetch_all(&pool)
            .await
            .map_err(|e| WalError::Serialization(e.to_string()))?;

            let mut out = Vec::with_capacity(rows.len());
            for row in rows {
                let payload: serde_json::Value = row
                    .try_get("payload")
                    .map_err(|e| WalError::Serialization(e.to_string()))?;
                let entry: WalEntry = serde_json::from_value(payload)
                    .map_err(|e| WalError::Serialization(e.to_string()))?;
                out.push(entry);
            }
            Ok(out)
        })
    }
}

impl SessionStore for SqlxPostgresStore {
    fn create_guest_user<'a>(
        &'a self,
        role: &'a str,
    ) -> BoxFuture<'a, Result<UserRecord, SessionError>> {
        Box::pin(async move {
            let user_id = Uuid::new_v4();
            let email = format!("ephemeral_{user_id}@trame.local");
            let username = format!("Guest {}", &user_id.to_string()[..4]);
            let now = now_epoch_seconds();

            sqlx::query(
                "INSERT INTO users (id, email, display_name, password_hash, is_ephemeral, role)
                 VALUES ($1, $2, $3, NULL, TRUE, $4)",
            )
            .bind(user_id)
            .bind(&email)
            .bind(&username)
            .bind(role)
            .execute(&self.pool)
            .await
            .map_err(|e| SessionError::Storage(e.to_string()))?;

            Ok(UserRecord {
                id: user_id,
                username,
                role: role.to_string(),
                is_guest: true,
                created_at: now,
                email: Some(email),
                password_hash: None,
                mfa_enabled: false,
                totp_secret: None,
                pending_totp_secret: None,
            })
        })
    }

    fn assign_campaign_member<'a>(
        &'a self,
        campaign_id: Uuid,
        user_id: Uuid,
        character_id: Option<Uuid>,
        role: &'a str,
    ) -> BoxFuture<'a, Result<CampaignMemberRecord, SessionError>> {
        Box::pin(async move {
            self.ensure_campaign_row(campaign_id)
                .await
                .map_err(SessionError::Storage)?;
            self.upsert_campaign_member(campaign_id, user_id, role)
                .await
                .map_err(SessionError::Storage)?;
            Ok(CampaignMemberRecord {
                campaign_id,
                user_id,
                character_id,
                role: role.to_string(),
                joined_at: now_epoch_seconds(),
            })
        })
    }

    fn create_session<'a>(
        &'a self,
        user_id: Uuid,
        token_hash: &'a str,
        ttl_seconds: u64,
    ) -> BoxFuture<'a, Result<SessionRecord, SessionError>> {
        Box::pin(async move {
            let now = now_epoch_seconds();
            let expires_at = now.saturating_add(ttl_seconds);
            sqlx::query(
                "INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
                 VALUES ($1, $2, to_timestamp($3::DOUBLE PRECISION), to_timestamp($4::DOUBLE PRECISION))
                 ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at",
            )
            .bind(token_hash)
            .bind(user_id)
            .bind(now as f64)
            .bind(expires_at as f64)
            .execute(&self.pool)
            .await
            .map_err(|e| SessionError::Storage(e.to_string()))?;

            Ok(SessionRecord {
                session_id: Uuid::new_v4(),
                user_id,
                token_hash: token_hash.to_string(),
                created_at: now,
                expires_at,
            })
        })
    }

    fn get_session_by_token_hash<'a>(
        &'a self,
        token_hash: &'a str,
    ) -> BoxFuture<'a, Result<Option<SessionRecord>, SessionError>> {
        Box::pin(async move {
            let row_opt = sqlx::query(
                "SELECT token_hash, user_id,
                        EXTRACT(EPOCH FROM created_at)::BIGINT AS created_epoch,
                        EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires_epoch
                 FROM auth_sessions
                 WHERE token_hash = $1",
            )
            .bind(token_hash)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| SessionError::Storage(e.to_string()))?;

            let Some(row) = row_opt else {
                return Ok(None);
            };

            let user_id: Uuid = row
                .try_get("user_id")
                .map_err(|e| SessionError::Storage(e.to_string()))?;
            let created_at = row.try_get::<i64, _>("created_epoch").unwrap_or(0).max(0) as u64;
            let expires_at = row.try_get::<i64, _>("expires_epoch").unwrap_or(0).max(0) as u64;

            Ok(Some(SessionRecord {
                session_id: user_id,
                user_id,
                token_hash: token_hash.to_string(),
                created_at,
                expires_at,
            }))
        })
    }

    fn is_invite_revoked(&self, jti: Uuid) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            let jti_str = jti.to_string();
            sqlx::query_scalar::<_, String>("SELECT jti FROM revoked_invites WHERE jti = $1")
                .bind(jti_str)
                .fetch_optional(&self.pool)
                .await
                .ok()
                .flatten()
                .is_some()
        })
    }

    fn revoke_invite(&self, jti: Uuid) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(async move {
            let jti_str = jti.to_string();
            sqlx::query(
                "INSERT INTO revoked_invites (jti, revoked_at)
                 VALUES ($1, NOW())
                 ON CONFLICT (jti) DO NOTHING",
            )
            .bind(jti_str)
            .execute(&self.pool)
            .await
            .map_err(|e| SessionError::Storage(e.to_string()))?;
            Ok(())
        })
    }

    fn get_campaign_member(
        &self,
        campaign_id: Uuid,
        user_id: Uuid,
    ) -> BoxFuture<'_, Result<Option<CampaignMemberRecord>, SessionError>> {
        Box::pin(async move {
            let row_opt = sqlx::query(
                "SELECT campaign_id, user_id, role,
                        EXTRACT(EPOCH FROM joined_at)::BIGINT AS joined_epoch
                 FROM campaign_members
                 WHERE campaign_id = $1 AND user_id = $2",
            )
            .bind(campaign_id)
            .bind(user_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| SessionError::Storage(e.to_string()))?;

            let Some(row) = row_opt else {
                return Ok(None);
            };

            Ok(Some(CampaignMemberRecord {
                campaign_id: row
                    .try_get("campaign_id")
                    .map_err(|e| SessionError::Storage(e.to_string()))?,
                user_id: row
                    .try_get("user_id")
                    .map_err(|e| SessionError::Storage(e.to_string()))?,
                character_id: None,
                role: row
                    .try_get("role")
                    .map_err(|e| SessionError::Storage(e.to_string()))?,
                joined_at: row.try_get::<i64, _>("joined_epoch").unwrap_or(0).max(0) as u64,
            }))
        })
    }

    fn get_campaign_members_for_user(
        &self,
        user_id: Uuid,
    ) -> BoxFuture<'_, Result<Vec<CampaignMemberRecord>, SessionError>> {
        Box::pin(async move {
            let rows = sqlx::query(
                "SELECT campaign_id, user_id, role,
                        EXTRACT(EPOCH FROM joined_at)::BIGINT AS joined_epoch
                 FROM campaign_members
                 WHERE user_id = $1",
            )
            .bind(user_id)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| SessionError::Storage(e.to_string()))?;

            let mut out = Vec::with_capacity(rows.len());
            for row in rows {
                out.push(CampaignMemberRecord {
                    campaign_id: row
                        .try_get("campaign_id")
                        .map_err(|e| SessionError::Storage(e.to_string()))?,
                    user_id,
                    character_id: None,
                    role: row
                        .try_get("role")
                        .map_err(|e| SessionError::Storage(e.to_string()))?,
                    joined_at: row.try_get::<i64, _>("joined_epoch").unwrap_or(0).max(0) as u64,
                });
            }
            Ok(out)
        })
    }
}

impl IdentityStore for SqlxPostgresStore {
    fn get_user_by_email<'a>(
        &'a self,
        email: &'a str,
    ) -> BoxFuture<'a, Result<Option<UserRecord>, SessionError>> {
        Box::pin(async move {
            let normalized = email.trim().to_lowercase();
            let row_opt = sqlx::query(
                "SELECT id, email, display_name, password_hash, is_ephemeral, role,
                        mfa_enabled, totp_secret, pending_totp_secret,
                        EXTRACT(EPOCH FROM created_at)::BIGINT AS created_epoch
                 FROM users
                 WHERE LOWER(email) = $1",
            )
            .bind(normalized)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| SessionError::Storage(e.to_string()))?;

            let Some(row) = row_opt else {
                return Ok(None);
            };

            Ok(Some(UserRecord {
                id: row
                    .try_get("id")
                    .map_err(|e| SessionError::Storage(e.to_string()))?,
                username: row
                    .try_get("display_name")
                    .map_err(|e| SessionError::Storage(e.to_string()))?,
                role: row
                    .try_get("role")
                    .unwrap_or_else(|_| "PLAYER".to_string()),
                is_guest: row.try_get("is_ephemeral").unwrap_or(false),
                created_at: row.try_get::<i64, _>("created_epoch").unwrap_or(0).max(0) as u64,
                email: row.try_get("email").ok(),
                password_hash: row.try_get("password_hash").ok().flatten(),
                mfa_enabled: row.try_get("mfa_enabled").unwrap_or(false),
                totp_secret: row.try_get("totp_secret").ok().flatten(),
                pending_totp_secret: row.try_get("pending_totp_secret").ok().flatten(),
            }))
        })
    }

    fn get_user_by_id(
        &self,
        user_id: Uuid,
    ) -> BoxFuture<'_, Result<Option<UserRecord>, SessionError>> {
        Box::pin(async move {
            let row_opt = sqlx::query(
                "SELECT id, email, display_name, password_hash, is_ephemeral, role,
                        mfa_enabled, totp_secret, pending_totp_secret,
                        EXTRACT(EPOCH FROM created_at)::BIGINT AS created_epoch
                 FROM users
                 WHERE id = $1",
            )
            .bind(user_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| SessionError::Storage(e.to_string()))?;

            let Some(row) = row_opt else {
                return Ok(None);
            };

            Ok(Some(UserRecord {
                id: row
                    .try_get("id")
                    .map_err(|e| SessionError::Storage(e.to_string()))?,
                username: row
                    .try_get("display_name")
                    .map_err(|e| SessionError::Storage(e.to_string()))?,
                role: row
                    .try_get("role")
                    .unwrap_or_else(|_| "PLAYER".to_string()),
                is_guest: row.try_get("is_ephemeral").unwrap_or(false),
                created_at: row.try_get::<i64, _>("created_epoch").unwrap_or(0).max(0) as u64,
                email: row.try_get("email").ok(),
                password_hash: row.try_get("password_hash").ok().flatten(),
                mfa_enabled: row.try_get("mfa_enabled").unwrap_or(false),
                totp_secret: row.try_get("totp_secret").ok().flatten(),
                pending_totp_secret: row.try_get("pending_totp_secret").ok().flatten(),
            }))
        })
    }

    fn bind_guest_credentials<'a>(
        &'a self,
        user_id: Uuid,
        email: &'a str,
        password_hash: &'a str,
    ) -> BoxFuture<'a, Result<UserRecord, SessionError>> {
        Box::pin(async move {
            sqlx::query(
                "UPDATE users
                 SET email = $2, password_hash = $3, is_ephemeral = FALSE, updated_at = NOW()
                 WHERE id = $1",
            )
            .bind(user_id)
            .bind(email)
            .bind(password_hash)
            .execute(&self.pool)
            .await
            .map_err(|e| SessionError::Storage(e.to_string()))?;

            self.get_user_by_id(user_id)
                .await?
                .ok_or_else(|| SessionError::Storage("user not found after bind".to_string()))
        })
    }

    fn save_user<'a>(&'a self, user: UserRecord) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            let email = user
                .email
                .clone()
                .unwrap_or_else(|| format!("ephemeral_{}@trame.local", user.id));
            sqlx::query(
                "INSERT INTO users (id, email, display_name, password_hash, is_ephemeral, role, mfa_enabled, totp_secret, pending_totp_secret)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (id) DO UPDATE SET
                   email = EXCLUDED.email,
                   display_name = EXCLUDED.display_name,
                   password_hash = EXCLUDED.password_hash,
                   is_ephemeral = EXCLUDED.is_ephemeral,
                   role = EXCLUDED.role,
                   mfa_enabled = EXCLUDED.mfa_enabled,
                   totp_secret = EXCLUDED.totp_secret,
                   pending_totp_secret = EXCLUDED.pending_totp_secret,
                   updated_at = NOW()",
            )
            .bind(user.id)
            .bind(email)
            .bind(&user.username)
            .bind(&user.password_hash)
            .bind(user.is_guest)
            .bind(&user.role)
            .bind(user.mfa_enabled)
            .bind(&user.totp_secret)
            .bind(&user.pending_totp_secret)
            .execute(&self.pool)
            .await
            .map_err(|e| SessionError::Storage(e.to_string()))?;
            Ok(())
        })
    }

    fn save_pending_totp_secret<'a>(
        &'a self,
        user_id: Uuid,
        encrypted_secret: &'a str,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            sqlx::query(
                "UPDATE users SET pending_totp_secret = $2, updated_at = NOW() WHERE id = $1",
            )
            .bind(user_id)
            .bind(encrypted_secret)
            .execute(&self.pool)
            .await
            .map_err(|e| SessionError::Storage(e.to_string()))?;
            Ok(())
        })
    }

    fn enable_totp_for_user<'a>(
        &'a self,
        user_id: Uuid,
        encrypted_secret: &'a str,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            sqlx::query(
                "UPDATE users
                 SET totp_secret = $2, pending_totp_secret = NULL, mfa_enabled = TRUE, updated_at = NOW()
                 WHERE id = $1",
            )
            .bind(user_id)
            .bind(encrypted_secret)
            .execute(&self.pool)
            .await
            .map_err(|e| SessionError::Storage(e.to_string()))?;
            Ok(())
        })
    }
}

impl PatStore for SqlxPostgresStore {
    fn save_pat<'a>(&'a self, record: PatRecord) -> BoxFuture<'a, Result<(), PatError>> {
        Box::pin(async move {
            let name = record.name.unwrap_or_else(|| "default".to_string());
            let expires_ts = record.expires_at.map(|v| v as f64);
            sqlx::query(
                "INSERT INTO personal_access_tokens (token_hash, id, user_id, campaign_id, name, scopes, created_at, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::DOUBLE PRECISION),
                         CASE WHEN $8::DOUBLE PRECISION IS NOT NULL THEN to_timestamp($8::DOUBLE PRECISION) ELSE NULL END)
                 ON CONFLICT (token_hash) DO NOTHING",
            )
            .bind(&record.token_hash)
            .bind(record.id)
            .bind(record.user_id)
            .bind(record.campaign_id)
            .bind(name)
            .bind(&record.scopes)
            .bind(record.created_at as f64)
            .bind(expires_ts)
            .execute(&self.pool)
            .await
            .map_err(|e| PatError::Storage(e.to_string()))?;
            Ok(())
        })
    }

    fn find_pat_by_hash<'a>(
        &'a self,
        token_hash: &'a str,
    ) -> BoxFuture<'a, Result<Option<PatRecord>, PatError>> {
        Box::pin(async move {
            let row_opt = sqlx::query(
                "SELECT token_hash, id, user_id, campaign_id, name, scopes,
                        EXTRACT(EPOCH FROM created_at)::BIGINT AS created_epoch,
                        EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires_epoch
                 FROM personal_access_tokens
                 WHERE token_hash = $1",
            )
            .bind(token_hash)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| PatError::Storage(e.to_string()))?;

            let Some(row) = row_opt else {
                return Ok(None);
            };

            Ok(Some(PatRecord {
                id: row.try_get("id").unwrap_or_else(|_| Uuid::new_v4()),
                user_id: row
                    .try_get("user_id")
                    .map_err(|e| PatError::Storage(e.to_string()))?,
                campaign_id: row.try_get("campaign_id").ok().flatten(),
                token_hash: row
                    .try_get("token_hash")
                    .map_err(|e| PatError::Storage(e.to_string()))?,
                scopes: row.try_get("scopes").unwrap_or_default(),
                name: row.try_get("name").ok(),
                created_at: row.try_get::<i64, _>("created_epoch").unwrap_or(0).max(0) as u64,
                expires_at: row
                    .try_get::<Option<i64>, _>("expires_epoch")
                    .ok()
                    .flatten()
                    .map(|v| v.max(0) as u64),
            }))
        })
    }

    fn list_pats_for_user<'a>(
        &'a self,
        user_id: Uuid,
    ) -> BoxFuture<'a, Result<Vec<PatRecord>, PatError>> {
        Box::pin(async move {
            let rows = sqlx::query(
                "SELECT token_hash, id, user_id, campaign_id, name, scopes,
                        EXTRACT(EPOCH FROM created_at)::BIGINT AS created_epoch,
                        EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires_epoch
                 FROM personal_access_tokens
                 WHERE user_id = $1
                 ORDER BY created_at DESC",
            )
            .bind(user_id)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| PatError::Storage(e.to_string()))?;

            let mut out = Vec::with_capacity(rows.len());
            for row in rows {
                out.push(PatRecord {
                    id: row.try_get("id").unwrap_or_else(|_| Uuid::new_v4()),
                    user_id,
                    campaign_id: row.try_get("campaign_id").ok().flatten(),
                    token_hash: row
                        .try_get("token_hash")
                        .map_err(|e| PatError::Storage(e.to_string()))?,
                    scopes: row.try_get("scopes").unwrap_or_default(),
                    name: row.try_get("name").ok(),
                    created_at: row.try_get::<i64, _>("created_epoch").unwrap_or(0).max(0) as u64,
                    expires_at: row
                        .try_get::<Option<i64>, _>("expires_epoch")
                        .ok()
                        .flatten()
                        .map(|v| v.max(0) as u64),
                });
            }
            Ok(out)
        })
    }

    fn revoke_pat<'a>(
        &'a self,
        pat_id: Uuid,
        user_id: Uuid,
    ) -> BoxFuture<'a, Result<bool, PatError>> {
        Box::pin(async move {
            let res = sqlx::query(
                "DELETE FROM personal_access_tokens WHERE id = $1 AND user_id = $2",
            )
            .bind(pat_id)
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map_err(|e| PatError::Storage(e.to_string()))?;
            Ok(res.rows_affected() > 0)
        })
    }
}

impl OAuthStore for SqlxPostgresStore {
    fn save_pending_oauth<'a>(
        &'a self,
        state: PendingOAuthState,
    ) -> BoxFuture<'a, Result<(), OAuthError>> {
        Box::pin(async move {
            let mut guard = self
                .pending_oauth
                .write()
                .map_err(|_| OAuthError::Storage("lock poisoned".to_string()))?;
            guard.insert(state.state.clone(), state);
            Ok(())
        })
    }

    fn consume_pending_oauth<'a>(
        &'a self,
        state: &'a str,
    ) -> BoxFuture<'a, Result<Option<PendingOAuthState>, OAuthError>> {
        Box::pin(async move {
            let mut guard = self
                .pending_oauth
                .write()
                .map_err(|_| OAuthError::Storage("lock poisoned".to_string()))?;
            Ok(guard.remove(state))
        })
    }

    fn find_user_by_oauth_identity<'a>(
        &'a self,
        provider: OAuthProvider,
        provider_user_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<UserRecord>, SessionError>> {
        Box::pin(async move {
            let synthetic_email = format!("{provider}_{provider_user_id}@oauth.trame.local");
            self.get_user_by_email(&synthetic_email).await
        })
    }

    fn bind_oauth_identity<'a>(
        &'a self,
        user_id: Uuid,
        provider: OAuthProvider,
        provider_user_id: &'a str,
        email: Option<&'a str>,
    ) -> BoxFuture<'a, Result<UserRecord, SessionError>> {
        Box::pin(async move {
            let resolved_email = email
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("{provider}_{provider_user_id}@oauth.trame.local"));
            sqlx::query(
                "UPDATE users SET email = $2, is_ephemeral = FALSE, updated_at = NOW() WHERE id = $1",
            )
            .bind(user_id)
            .bind(resolved_email)
            .execute(&self.pool)
            .await
            .map_err(|e| SessionError::Storage(e.to_string()))?;

            self.get_user_by_id(user_id)
                .await?
                .ok_or_else(|| SessionError::Storage("user not found".to_string()))
        })
    }
}

impl CampaignImportTarget for SqlxPostgresStore {
    async fn campaign_exists(&self, id: Uuid) -> Result<bool, ArchiveError> {
        let found: Option<Uuid> = sqlx::query_scalar("SELECT id FROM campaigns WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ArchiveError::Io(std::io::Error::other(e.to_string())))?;
        Ok(found.is_some())
    }

    async fn save_campaign(&self, campaign: &CampaignMetadata) -> Result<(), ArchiveError> {
        let gm_user_id = Uuid::from_u128(1);
        sqlx::query(
            "INSERT INTO users (id, email, display_name, is_ephemeral, role)
             VALUES ($1, 'system@trame.local', 'System GM', FALSE, 'GM')
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(gm_user_id)
        .execute(&self.pool)
        .await
        .map_err(|e| ArchiveError::Io(std::io::Error::other(e.to_string())))?;

        sqlx::query(
            "INSERT INTO campaigns (id, name, system_id, gm_user_id, description)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO UPDATE SET
               name = EXCLUDED.name,
               system_id = EXCLUDED.system_id,
               description = EXCLUDED.description,
               updated_at = NOW()",
        )
        .bind(campaign.id)
        .bind(&campaign.name)
        .bind(&campaign.system)
        .bind(gm_user_id)
        .bind(&campaign.description)
        .execute(&self.pool)
        .await
        .map_err(|e| ArchiveError::Io(std::io::Error::other(e.to_string())))?;
        Ok(())
    }

    async fn save_entities(&self, entities: &[ExportEntity]) -> Result<(), ArchiveError> {
        for entity in entities {
            let entity_id = entity
                .data
                .get("id")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
                .unwrap_or_else(Uuid::new_v4);
            let campaign_id = entity
                .data
                .get("campaign_id")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
                .unwrap_or_else(|| Uuid::from_u128(1));
            self.ensure_campaign_row(campaign_id)
                .await
                .map_err(|e| ArchiveError::Io(std::io::Error::other(e)))?;

            let valid_type = match entity.entity_type.as_str() {
                "actor" | "scene" | "item" => entity.entity_type.as_str(),
                _ => "item",
            };
            sqlx::query(
                "INSERT INTO campaign_entities (id, campaign_id, entity_type, payload)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (campaign_id, id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()",
            )
            .bind(entity_id)
            .bind(campaign_id)
            .bind(valid_type)
            .bind(&entity.data)
            .execute(&self.pool)
            .await
            .map_err(|e| ArchiveError::Io(std::io::Error::other(e.to_string())))?;
        }
        Ok(())
    }

    async fn save_notes(&self, notes: &[NoteRecord]) -> Result<(), ArchiveError> {
        let default_campaign_id = Uuid::from_u128(1);
        self.ensure_campaign_row(default_campaign_id)
            .await
            .map_err(|e| ArchiveError::Io(std::io::Error::other(e)))?;
        for note in notes {
            let slug = note
                .title
                .to_lowercase()
                .replace(|c: char| !c.is_ascii_alphanumeric(), "-");
            sqlx::query(
                "INSERT INTO campaign_notes (campaign_id, slug, id, title, content_markdown, min_role, folder, author_id)
                 VALUES ($1, $2, $3, $4, $5, 'PLAYER', $6, $7)
                 ON CONFLICT (campaign_id, slug) DO UPDATE SET
                   title = EXCLUDED.title,
                   content_markdown = EXCLUDED.content_markdown,
                   updated_at = NOW()",
            )
            .bind(default_campaign_id)
            .bind(slug)
            .bind(note.id)
            .bind(&note.title)
            .bind(&note.content_markdown)
            .bind(&note.folder)
            .bind(note.author_id)
            .execute(&self.pool)
            .await
            .map_err(|e| ArchiveError::Io(std::io::Error::other(e.to_string())))?;
        }
        Ok(())
    }
}

impl CampaignMembershipValidator for SqlxPostgresStore {
    fn is_member(&self, campaign_id: Uuid, user_id: Uuid) -> bool {
        let pool = self.pool.clone();
        run_pg_blocking(async move {
            sqlx::query_scalar::<_, String>(
                "SELECT role FROM campaign_members WHERE campaign_id = $1 AND user_id = $2",
            )
            .bind(campaign_id)
            .bind(user_id)
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten()
            .is_some()
        })
    }

    fn is_gm(&self, campaign_id: Uuid, user_id: Uuid) -> bool {
        let pool = self.pool.clone();
        run_pg_blocking(async move {
            sqlx::query_scalar::<_, String>(
                "SELECT role FROM campaign_members WHERE campaign_id = $1 AND user_id = $2",
            )
            .bind(campaign_id)
            .bind(user_id)
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten()
            .map(|r| r.eq_ignore_ascii_case("GM"))
            .unwrap_or(false)
        })
    }

    fn add_member(&self, campaign_id: Uuid, user_id: Uuid) {
        let store = self.clone();
        run_pg_blocking(async move {
            let _ = store.ensure_campaign_row(campaign_id).await;
            let _ = store.upsert_campaign_member(campaign_id, user_id, "GM").await;
        });
    }
}

impl PartyJournalStorage for SqlxPostgresStore {
    fn insert_entry(&self, entry: PartyJournalEntry) -> Result<(), NotesError> {
        let pool = self.pool.clone();
        run_pg_blocking(async move {
            let campaign_uuid = Uuid::parse_str(&entry.campaign_id)
                .unwrap_or_else(|_| Uuid::from_u128(1));
            Self::ensure_campaign_row_on_pool(&pool, campaign_uuid)
                .await
                .map_err(|_| NotesError::LockPoisoned)?;
            let author_id = Uuid::from_u128(1);
            let payload = serde_json::to_value(&entry).map_err(|_| NotesError::LockPoisoned)?;
            let row_id = Uuid::parse_str(&entry.handout_id).unwrap_or_else(|_| Uuid::new_v4());

            sqlx::query(
                "INSERT INTO party_journal_entries (id, campaign_id, session_num, author_user_id, title, body_markdown, payload)
                 VALUES ($1, $2, 1, $3, $4, $5, $6)
                 ON CONFLICT (id) DO UPDATE SET
                   title = EXCLUDED.title,
                   body_markdown = EXCLUDED.body_markdown,
                   payload = EXCLUDED.payload",
            )
            .bind(row_id)
            .bind(campaign_uuid)
            .bind(author_id)
            .bind(&entry.title)
            .bind(&entry.content)
            .bind(payload)
            .execute(&pool)
            .await
            .map_err(|_| NotesError::LockPoisoned)?;
            Ok(())
        })
    }

    fn list_entries(&self, campaign_id: &str) -> Result<Vec<PartyJournalEntry>, NotesError> {
        let pool = self.pool.clone();
        let cid_str = campaign_id.to_string();
        run_pg_blocking(async move {
            let campaign_uuid =
                Uuid::parse_str(&cid_str).unwrap_or_else(|_| Uuid::from_u128(1));
            let rows = sqlx::query(
                "SELECT payload FROM party_journal_entries
                 WHERE campaign_id = $1
                 ORDER BY created_at DESC",
            )
            .bind(campaign_uuid)
            .fetch_all(&pool)
            .await
            .map_err(|_| NotesError::LockPoisoned)?;

            let mut out = Vec::with_capacity(rows.len());
            for row in rows {
                if let Ok(payload) = row.try_get::<serde_json::Value, _>("payload")
                    && let Ok(entry) = serde_json::from_value::<PartyJournalEntry>(payload)
                {
                    out.push(entry);
                }
            }
            Ok(out)
        })
    }

    fn get_entry(&self, handout_id: &str) -> Result<Option<PartyJournalEntry>, NotesError> {
        let pool = self.pool.clone();
        let hid = handout_id.to_string();
        run_pg_blocking(async move {
            let rows = sqlx::query("SELECT payload FROM party_journal_entries")
                .fetch_all(&pool)
                .await
                .map_err(|_| NotesError::LockPoisoned)?;

            for row in rows {
                if let Ok(payload) = row.try_get::<serde_json::Value, _>("payload")
                    && let Ok(entry) = serde_json::from_value::<PartyJournalEntry>(payload)
                    && entry.handout_id == hid
                {
                    return Ok(Some(entry));
                }
            }
            Ok(None)
        })
    }
}

impl TimelineStorage for SqlxPostgresStore {
    fn append_event(
        &self,
        campaign_id: &str,
        session_num: u32,
        input: AppendEventInput,
    ) -> Result<SessionTimelineEvent, TimelineError> {
        let pool = self.pool.clone();
        let cid_str = campaign_id.to_string();
        run_pg_blocking(async move {
            let campaign_uuid =
                Uuid::parse_str(&cid_str).unwrap_or_else(|_| Uuid::from_u128(1));
            Self::ensure_campaign_row_on_pool(&pool, campaign_uuid)
                .await
                .map_err(|_| TimelineError::LockPoisoned)?;

            let max_seq: Option<i64> = sqlx::query_scalar(
                "SELECT MAX(sequence_num) FROM session_timeline_events
                 WHERE campaign_id = $1 AND session_num = $2",
            )
            .bind(campaign_uuid)
            .bind(session_num as i32)
            .fetch_one(&pool)
            .await
            .map_err(|_| TimelineError::LockPoisoned)?;

            let next_seq = (max_seq.unwrap_or(0) + 1).max(1) as u64;
            let timestamp = input
                .timestamp
                .unwrap_or_else(|| now_epoch_seconds().saturating_mul(1000));

            let ev = SessionTimelineEvent {
                seq_id: next_seq,
                timestamp,
                event_type: input.event_type.clone(),
                actor_id: input.actor_id.clone(),
                payload: input.payload.clone(),
            };
            let ev_json = serde_json::to_value(&ev).map_err(|_| TimelineError::LockPoisoned)?;

            sqlx::query(
                "INSERT INTO session_timeline_events (id, campaign_id, session_num, sequence_num, event_kind, description, payload)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(Uuid::new_v4())
            .bind(campaign_uuid)
            .bind(session_num as i32)
            .bind(next_seq as i64)
            .bind(&ev.event_type)
            .bind(&ev.event_type)
            .bind(ev_json)
            .execute(&pool)
            .await
            .map_err(|_| TimelineError::LockPoisoned)?;

            Ok(ev)
        })
    }

    fn get_timeline(
        &self,
        campaign_id: &str,
        session_num: u32,
        after_seq: u64,
        limit: usize,
    ) -> Result<SessionTimelineResponse, TimelineError> {
        let pool = self.pool.clone();
        let cid_str = campaign_id.to_string();
        let effective_limit = limit.clamp(1, 200);
        run_pg_blocking(async move {
            let campaign_uuid =
                Uuid::parse_str(&cid_str).unwrap_or_else(|_| Uuid::from_u128(1));
            let rows = sqlx::query(
                "SELECT payload FROM session_timeline_events
                 WHERE campaign_id = $1 AND session_num = $2 AND sequence_num > $3
                 ORDER BY sequence_num ASC
                 LIMIT $4",
            )
            .bind(campaign_uuid)
            .bind(session_num as i32)
            .bind(after_seq as i64)
            .bind((effective_limit + 1) as i64)
            .fetch_all(&pool)
            .await
            .map_err(|_| TimelineError::LockPoisoned)?;

            let mut events = Vec::with_capacity(rows.len());
            for row in rows {
                if let Ok(payload) = row.try_get::<serde_json::Value, _>("payload")
                    && let Ok(ev) = serde_json::from_value::<SessionTimelineEvent>(payload)
                {
                    events.push(ev);
                }
            }
            let has_more = events.len() > effective_limit;
            if has_more {
                events.truncate(effective_limit);
            }

            Ok(SessionTimelineResponse {
                campaign_id: cid_str.clone(),
                session_num,
                session_id: format!("{cid_str}:{session_num}"),
                events,
                has_more,
            })
        })
    }
}

impl AssetStore for SqlxPostgresStore {
    fn put_asset<'a>(
        &'a self,
        key: &'a str,
        data: Bytes,
        content_type: &'a str,
    ) -> crate::assets::store::BoxFuture<'a, Result<(), AssetStoreError>> {
        Box::pin(async move {
            let campaign_id = extract_campaign_id_from_asset_key(key)
                .unwrap_or_else(|| Uuid::from_u128(1));
            self.ensure_campaign_row(campaign_id)
                .await
                .map_err(AssetStoreError::Io)?;

            sqlx::query(
                "INSERT INTO campaign_assets (asset_key, campaign_id, content_type, byte_size, payload)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (asset_key) DO UPDATE SET
                   content_type = EXCLUDED.content_type,
                   byte_size = EXCLUDED.byte_size,
                   payload = EXCLUDED.payload",
            )
            .bind(key)
            .bind(campaign_id)
            .bind(content_type)
            .bind(data.len() as i64)
            .bind(data.as_ref())
            .execute(&self.pool)
            .await
            .map_err(|e| AssetStoreError::Io(e.to_string()))?;
            Ok(())
        })
    }

    fn get_asset<'a>(
        &'a self,
        key: &'a str,
    ) -> crate::assets::store::BoxFuture<'a, Result<Option<Bytes>, AssetStoreError>> {
        Box::pin(async move {
            let row_opt =
                sqlx::query("SELECT payload FROM campaign_assets WHERE asset_key = $1")
                    .bind(key)
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(|e| AssetStoreError::Io(e.to_string()))?;

            let Some(row) = row_opt else {
                return Ok(None);
            };
            let bytes: Vec<u8> = row
                .try_get("payload")
                .map_err(|e| AssetStoreError::Io(e.to_string()))?;
            Ok(Some(Bytes::from(bytes)))
        })
    }

    fn mint_presigned_get_url<'a>(
        &'a self,
        key: &'a str,
        ttl: Duration,
    ) -> crate::assets::store::BoxFuture<'a, Result<String, AssetStoreError>> {
        Box::pin(async move {
            let exists: Option<String> = sqlx::query_scalar(
                "SELECT asset_key FROM campaign_assets WHERE asset_key = $1",
            )
            .bind(key)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| AssetStoreError::Io(e.to_string()))?;

            if exists.is_none() {
                return Err(AssetStoreError::NotFound(key.to_string()));
            }

            let now = now_epoch_seconds();
            let exp = now.saturating_add(ttl.as_secs());
            let clean_key = key.trim_start_matches('/');
            let signing_input = format!("{clean_key}:{exp}");
            let sig = hmac_sha256(&self.signing_secret, signing_input.as_bytes());
            let mut sig_hex = String::with_capacity(64);
            for b in sig {
                use std::fmt::Write;
                let _ = write!(&mut sig_hex, "{:02x}", b);
            }
            Ok(format!(
                "{}/{}?exp={}&sig={}",
                self.base_url.trim_end_matches('/'),
                clean_key,
                exp,
                sig_hex
            ))
        })
    }
}

/// Extracts a `campaign_id` UUID from keys matching `campaigns/<uuid>/...` or `instances/<uuid>/campaigns/<uuid>/...`.
pub fn extract_campaign_id_from_asset_key(key: &str) -> Option<Uuid> {
    let parts: Vec<&str> = key.trim_start_matches('/').split('/').collect();
    for window in parts.windows(2) {
        if window[0] == "campaigns"
            && let Ok(cid) = Uuid::parse_str(window[1])
        {
            return Some(cid);
        }
    }
    None
}
