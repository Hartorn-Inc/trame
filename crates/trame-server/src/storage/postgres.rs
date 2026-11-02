//! ============================================================================
//! AUTHORITATIVE POSTGRESQL 18 STORAGE ENGINE (postgres.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Implements the authoritative PostgreSQL 18 (`sqlx::PgPool`) storage engine
//! (`SqlxPostgresStore`) satisfying all TRAME persistence contracts:
//! `WalStorage`, `SessionStore`, `IdentityStore`, `PatStore`, `OAuthStore`,
//! `CampaignImportTarget`, `CampaignMembershipValidator`, `PartyJournalStorage`,
//! `TimelineStorage`, and `AssetStore`, alongside persistent campaign map scene
//! storage (`scenes` + `campaign_entities`) and optimistic-concurrency actor
//! sheet persistence (`actors.version` / `expected_version` per ADR-0037).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Zero-Allocation Runtime Bridging (run_pg_blocking)`:
//!      - Synchronous trait methods (`WalStorage`, `CampaignMembershipValidator`,
//!        `PartyJournalStorage`, `TimelineStorage`) bridge to async `sqlx` queries
//!        via `tokio::task::block_in_place(|| handle.block_on(fut))` when called
//!        on a multi-threaded Tokio worker, falling back to a lightweight thread
//!        only when invoked from a `current_thread` test runtime or non-Tokio thread.
//!   2. `Optimistic Concurrency Control (ADR-0037)`:
//!      - Persistent actor mutations (`update_actor_optimistic`) verify
//!        `version = $expected_version` atomically in SQL (`UPDATE ... WHERE version = $4`)
//!        and increment `version = version + 1`, returning `ActorConcurrencyError::VersionConflict`
//!        (`409 Conflict`) on stale writes without clobbering concurrent sheet edits.
//!   3. `Parameterized SQL Queries & Ephemeral Identity Isolation`:
//!      - Every query uses parameterized binds (`$1`, `$2`, ...) to prevent SQL injection.
//!      - Ephemeral users created via Magic Link redemption use deterministic
//!        `ephemeral_<UUID>@trame.local` emails and `is_ephemeral = TRUE`.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `SqlxPostgresStore::connect_and_migrate(database_url, base_url)`
//!     ├── 1. Connect `PgPool` & execute embedded `./migrations` (`0001_initial_schema.sql`).
//!     ├── 2. Serve async auth/REST queries directly on `PgPool`.
//!     └── 3. Bridge synchronous WAL/room trait calls via `run_pg_blocking` (`block_in_place`).
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
use crate::campaigns::split_actor_entity;
use crate::http::CampaignMembershipValidator;
use crate::maps::{CampaignMapScene, SceneSaveError, restorable_scene};
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

/// Campaign summary record returned in lobby and campaign detail listings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignRecord {
    /// Unique campaign UUID.
    pub id: Uuid,
    /// Human-readable campaign title.
    pub name: String,
    /// Game system identifier (e.g. `"dnd5e"`).
    pub system_id: String,
    /// User UUID of the campaign's primary Game Master.
    pub gm_user_id: Uuid,
    /// Optional UUID of the currently active map scene on the live table.
    pub active_scene_id: Option<Uuid>,
    /// Optional campaign summary description.
    pub description: Option<String>,
    /// Creation timestamp formatted as epoch seconds or ISO-8601 string.
    pub created_at: String,
}

/// Campaign note record with role-based visibility boundaries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignNoteItem {
    /// Owning campaign UUID.
    pub campaign_id: Uuid,
    /// URL-safe note slug unique within the campaign.
    pub slug: String,
    /// Unique note UUID.
    pub id: Uuid,
    /// Human-readable note title.
    pub title: String,
    /// Raw CommonMark markdown body (including any `:::gm-only` or `:::handout` fences).
    pub content_markdown: String,
    /// Minimum role required to view the note (`"PLAYER"`, `"GM"`, etc.).
    pub min_role: String,
    /// Optional virtual folder path inside the campaign archive.
    pub folder: Option<String>,
    /// Optional author user UUID.
    pub author_id: Option<Uuid>,
    /// Creation timestamp string.
    pub created_at: String,
    /// Last modification timestamp string.
    pub updated_at: String,
}

/// Persistent actor sheet record stored in PostgreSQL with optimistic concurrency control (ADR-0037).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActorRecord {
    /// Unique actor UUID.
    pub id: Uuid,
    /// Owning campaign UUID.
    pub campaign_id: Uuid,
    /// Optional player user UUID who owns this character sheet.
    pub owner_user_id: Option<Uuid>,
    /// Display name of the actor.
    pub name: String,
    /// Monotonically increasing optimistic concurrency version (`>= 1`).
    pub version: i64,
    /// Full JSON sheet payload (`baseAttributes`, `resources`, `inventory`, `spells`, etc.).
    pub payload: serde_json::Value,
}

/// Error returned when creating or updating a persistent actor sheet with optimistic concurrency.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ActorConcurrencyError {
    /// Target actor does not exist in the specified campaign.
    #[error("actor {actor_id} not found in campaign {campaign_id}")]
    NotFound {
        /// Campaign UUID.
        campaign_id: Uuid,
        /// Actor UUID.
        actor_id: Uuid,
    },
    /// Supplied `expected_version` did not match the current database row version (`409 Conflict`).
    #[error(
        "optimistic concurrency conflict for actor {actor_id}: expected version {expected_version}, actual version {actual_version}"
    )]
    VersionConflict {
        /// Actor UUID that experienced the write conflict.
        actor_id: Uuid,
        /// Version supplied by the caller.
        expected_version: i64,
        /// Current authoritative version stored in PostgreSQL.
        actual_version: i64,
    },
    /// Underlying database execution error.
    #[error("database error: {0}")]
    Database(String),
}

fn storage_err(e: sqlx::Error) -> SceneSaveError {
    SceneSaveError::Storage(e.to_string())
}

/// Executes an async database future from a synchronous trait method without
/// spawning a new OS thread on every call when running inside a multi-threaded
/// Tokio runtime (`tokio::task::block_in_place`).
///
/// Falls back to a scoped thread with a lightweight `current_thread` runtime
/// only when invoked from a `#[tokio::test]` single-threaded runtime or outside Tokio.
fn run_pg_blocking<F, T>(fut: F) -> T
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread {
            return tokio::task::block_in_place(|| handle.block_on(fut));
        }
    }
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

    /// Connects to PostgreSQL using `database_url` and runs embedded SQL migrations (`./migrations`).
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

    /// Replaces the presigned-URL HMAC key with the validated `ServerSecrets::asset_signing_secret`.
    pub fn with_signing_secret(mut self, signing_secret: Vec<u8>) -> Self {
        self.signing_secret = signing_secret;
        self
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

    /// Records `user_id` as the campaign's owning GM (`campaigns.gm_user_id`). Archive import
    /// writes the campaign before the caller is known, so the import route calls this after.
    pub async fn set_campaign_gm(&self, campaign_id: Uuid, user_id: Uuid) -> Result<(), String> {
        sqlx::query("UPDATE campaigns SET gm_user_id = $2, updated_at = NOW() WHERE id = $1")
            .bind(campaign_id)
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
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
            "INSERT INTO campaign_entities (id, campaign_id, entity_type, owner_user_id, version, payload, updated_at)
             VALUES ($1, $2, $3, $4, 1, $5, NOW())
             ON CONFLICT (campaign_id, id) DO UPDATE SET
               entity_type = EXCLUDED.entity_type,
               owner_user_id = COALESCE(EXCLUDED.owner_user_id, campaign_entities.owner_user_id),
               version = campaign_entities.version + 1,
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

    /// Creates or initializes a persistent actor sheet in `actors` (and mirrors to `campaign_entities`)
    /// with initial version `1` (ADR-0037).
    pub async fn create_actor(
        &self,
        campaign_id: Uuid,
        actor_id: Uuid,
        owner_user_id: Option<Uuid>,
        name: &str,
        mut payload: serde_json::Value,
    ) -> Result<ActorRecord, ActorConcurrencyError> {
        self.ensure_campaign_row(campaign_id)
            .await
            .map_err(ActorConcurrencyError::Database)?;

        if !payload.is_object() {
            payload = serde_json::json!({});
        }
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("id".to_string(), serde_json::json!(actor_id));
            obj.insert("campaign_id".to_string(), serde_json::json!(campaign_id));
            obj.insert("version".to_string(), serde_json::json!(1));
            obj.insert("name".to_string(), serde_json::json!(name));
        }

        let row = sqlx::query(
            "INSERT INTO actors (id, campaign_id, owner_user_id, name, version, payload, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 1, $5, NOW(), NOW())
             ON CONFLICT (campaign_id, id) DO UPDATE SET
               owner_user_id = COALESCE(EXCLUDED.owner_user_id, actors.owner_user_id),
               name = EXCLUDED.name,
               version = actors.version + 1,
               payload = EXCLUDED.payload,
               updated_at = NOW()
             RETURNING version, payload",
        )
        .bind(actor_id)
        .bind(campaign_id)
        .bind(owner_user_id)
        .bind(name)
        .bind(&payload)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| ActorConcurrencyError::Database(e.to_string()))?;

        let version: i64 = row.try_get("version").unwrap_or(1);
        let stored_payload: serde_json::Value = row.try_get("payload").unwrap_or(payload);

        self.upsert_entity(
            campaign_id,
            actor_id,
            "actor",
            owner_user_id,
            &stored_payload,
        )
        .await
        .map_err(ActorConcurrencyError::Database)?;

        Ok(ActorRecord {
            id: actor_id,
            campaign_id,
            owner_user_id,
            name: name.to_string(),
            version,
            payload: stored_payload,
        })
    }

    /// Updates a persistent actor sheet using optimistic concurrency control (`expected_version`)
    /// per ADR-0037.
    ///
    /// Returns `Err(ActorConcurrencyError::VersionConflict)` when the stored `actors.version`
    /// does not match `expected_version`.
    pub async fn update_actor_optimistic(
        &self,
        campaign_id: Uuid,
        actor_id: Uuid,
        expected_version: i64,
        name: Option<&str>,
        mut payload: serde_json::Value,
    ) -> Result<ActorRecord, ActorConcurrencyError> {
        let next_version = expected_version.saturating_add(1);
        if !payload.is_object() {
            payload = serde_json::json!({});
        }
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("id".to_string(), serde_json::json!(actor_id));
            obj.insert("campaign_id".to_string(), serde_json::json!(campaign_id));
            obj.insert("version".to_string(), serde_json::json!(next_version));
        }

        let updated_row = sqlx::query(
            "UPDATE actors
             SET name = COALESCE($4, name),
                 version = version + 1,
                 payload = jsonb_set($5, '{name}', to_jsonb(COALESCE($4, name))),
                 updated_at = NOW()
             WHERE campaign_id = $1 AND id = $2 AND version = $3
             RETURNING owner_user_id, name, version, payload",
        )
        .bind(campaign_id)
        .bind(actor_id)
        .bind(expected_version)
        .bind(name)
        .bind(&payload)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ActorConcurrencyError::Database(e.to_string()))?;

        if let Some(row) = updated_row {
            let owner_user_id: Option<Uuid> = row.try_get("owner_user_id").ok().flatten();
            let resolved_name: String = row
                .try_get("name")
                .unwrap_or_else(|_| name.unwrap_or("Actor").to_string());
            let version: i64 = row.try_get("version").unwrap_or(next_version);
            let stored_payload: serde_json::Value = row.try_get("payload").unwrap_or(payload);

            self.upsert_entity(
                campaign_id,
                actor_id,
                "actor",
                owner_user_id,
                &stored_payload,
            )
            .await
            .map_err(ActorConcurrencyError::Database)?;

            return Ok(ActorRecord {
                id: actor_id,
                campaign_id,
                owner_user_id,
                name: resolved_name,
                version,
                payload: stored_payload,
            });
        }

        // Determine whether the row is missing or has a conflicting version.
        let existing_version: Option<i64> =
            sqlx::query_scalar("SELECT version FROM actors WHERE campaign_id = $1 AND id = $2")
                .bind(campaign_id)
                .bind(actor_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ActorConcurrencyError::Database(e.to_string()))?;

        match existing_version {
            Some(actual_version) => Err(ActorConcurrencyError::VersionConflict {
                actor_id,
                expected_version,
                actual_version,
            }),
            None => Err(ActorConcurrencyError::NotFound {
                campaign_id,
                actor_id,
            }),
        }
    }

    /// Lists all persistent `ActorRecord` rows for a campaign.
    pub async fn list_actors_for_campaign(
        &self,
        campaign_id: Uuid,
    ) -> Result<Vec<ActorRecord>, String> {
        let rows = sqlx::query(
            "SELECT id, campaign_id, owner_user_id, name, version, payload
             FROM actors
             WHERE campaign_id = $1
             ORDER BY created_at ASC",
        )
        .bind(campaign_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let mut actors = Vec::with_capacity(rows.len());
        for row in rows {
            actors.push(ActorRecord {
                id: row.try_get("id").map_err(|e| e.to_string())?,
                campaign_id: row.try_get("campaign_id").map_err(|e| e.to_string())?,
                owner_user_id: row.try_get("owner_user_id").ok().flatten(),
                name: row.try_get("name").map_err(|e| e.to_string())?,
                version: row.try_get("version").unwrap_or(1),
                payload: row.try_get("payload").map_err(|e| e.to_string())?,
            });
        }
        Ok(actors)
    }

    /// Retrieves a single persistent `ActorRecord` by `(campaign_id, actor_id)`.
    pub async fn get_actor(
        &self,
        campaign_id: Uuid,
        actor_id: Uuid,
    ) -> Result<Option<ActorRecord>, String> {
        let row_opt = sqlx::query(
            "SELECT id, campaign_id, owner_user_id, name, version, payload
             FROM actors
             WHERE campaign_id = $1 AND id = $2",
        )
        .bind(campaign_id)
        .bind(actor_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let Some(row) = row_opt else {
            return Ok(None);
        };

        Ok(Some(ActorRecord {
            id: row.try_get("id").map_err(|e| e.to_string())?,
            campaign_id: row.try_get("campaign_id").map_err(|e| e.to_string())?,
            owner_user_id: row.try_get("owner_user_id").ok().flatten(),
            name: row.try_get("name").map_err(|e| e.to_string())?,
            version: row.try_get("version").unwrap_or(1),
            payload: row.try_get("payload").map_err(|e| e.to_string())?,
        }))
    }

    /// Deletes a persistent actor sheet from `actors` and `campaign_entities`, returning `true` if deleted.
    pub async fn delete_actor(&self, campaign_id: Uuid, actor_id: Uuid) -> Result<bool, String> {
        let res = sqlx::query("DELETE FROM actors WHERE campaign_id = $1 AND id = $2")
            .bind(campaign_id)
            .bind(actor_id)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;

        sqlx::query(
            "DELETE FROM campaign_entities WHERE campaign_id = $1 AND id = $2 AND entity_type = 'actor'",
        )
        .bind(campaign_id)
        .bind(actor_id)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(res.rows_affected() > 0)
    }

    /// Replaces the full ordered list of `CampaignMapScene` records for a campaign in `scenes`
    /// and synchronizes `campaign_entities` (`entity_type = 'scene'`), provided
    /// `campaigns.scenes_version` still equals `expected_version`.
    ///
    /// The compare-and-increment `UPDATE` runs first inside the transaction, so its row lock
    /// serializes concurrent saves: the loser re-evaluates against the bumped version and gets
    /// `SceneSaveError::VersionConflict` instead of overwriting. Returns the new version.
    pub async fn save_campaign_scenes_async(
        &self,
        campaign_id: Uuid,
        scenes: &[CampaignMapScene],
        expected_version: i64,
    ) -> Result<i64, SceneSaveError> {
        self.ensure_campaign_row(campaign_id)
            .await
            .map_err(SceneSaveError::Storage)?;

        let mut tx = self.pool.begin().await.map_err(storage_err)?;
        let new_version: Option<i64> = sqlx::query_scalar(
            "UPDATE campaigns SET scenes_version = scenes_version + 1
             WHERE id = $1 AND scenes_version = $2 RETURNING scenes_version",
        )
        .bind(campaign_id)
        .bind(expected_version)
        .fetch_optional(&mut *tx)
        .await
        .map_err(storage_err)?;
        let Some(new_version) = new_version else {
            let current_version: i64 =
                sqlx::query_scalar("SELECT scenes_version FROM campaigns WHERE id = $1")
                    .bind(campaign_id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(storage_err)?;
            return Err(SceneSaveError::VersionConflict { current_version });
        };
        Self::replace_scene_rows(&mut tx, campaign_id, scenes)
            .await
            .map_err(SceneSaveError::Storage)?;
        tx.commit().await.map_err(storage_err)?;
        Ok(new_version)
    }

    async fn replace_scene_rows(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        campaign_id: Uuid,
        scenes: &[CampaignMapScene],
    ) -> Result<(), String> {
        sqlx::query("DELETE FROM scenes WHERE campaign_id = $1")
            .bind(campaign_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;

        sqlx::query(
            "DELETE FROM campaign_entities WHERE campaign_id = $1 AND entity_type = 'scene'",
        )
        .bind(campaign_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

        for (idx, scene) in scenes.iter().enumerate() {
            let payload = serde_json::to_value(scene).map_err(|e| e.to_string())?;
            sqlx::query(
                "INSERT INTO scenes (id, campaign_id, name, sort_order, revealed_to_players, payload, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())",
            )
            .bind(scene.id)
            .bind(campaign_id)
            .bind(&scene.name)
            .bind(idx as i32)
            .bind(scene.revealed_to_players)
            .bind(&payload)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;

            sqlx::query(
                "INSERT INTO campaign_entities (id, campaign_id, entity_type, version, payload, updated_at)
                 VALUES ($1, $2, 'scene', 1, $3, NOW())",
            )
            .bind(scene.id)
            .bind(campaign_id)
            .bind(&payload)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Loads the scenes of `campaign_id` (ordered by `sort_order`) together with
    /// `campaigns.scenes_version`; `(vec![], 0)` when the campaign row is absent.
    ///
    /// One `LEFT JOIN` statement reads both under a single MVCC snapshot, so a save committing
    /// mid-read can never pair new scenes with the old version (or the reverse).
    pub async fn load_campaign_scene_set_async(
        &self,
        campaign_id: Uuid,
    ) -> Result<(Vec<CampaignMapScene>, i64), String> {
        let rows = sqlx::query(
            "SELECT c.scenes_version, s.payload
             FROM campaigns c LEFT JOIN scenes s ON s.campaign_id = c.id
             WHERE c.id = $1
             ORDER BY s.sort_order ASC, s.created_at ASC",
        )
        .bind(campaign_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let mut version = 0;
        let mut scenes = Vec::with_capacity(rows.len());
        for row in rows {
            version = row.try_get("scenes_version").map_err(|e| e.to_string())?;
            let payload: Option<serde_json::Value> =
                row.try_get("payload").map_err(|e| e.to_string())?;
            if let Some(payload) = payload {
                scenes.push(serde_json::from_value(payload).map_err(|e| e.to_string())?);
            }
        }
        Ok((scenes, version))
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

    /// Reads the campaign `settings` JSON object (`{}` when the campaign row is missing).
    pub async fn get_campaign_settings(
        &self,
        campaign_id: Uuid,
    ) -> Result<serde_json::Value, String> {
        let value: Option<serde_json::Value> =
            sqlx::query_scalar("SELECT settings FROM campaigns WHERE id = $1")
                .bind(campaign_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
        Ok(value.unwrap_or_else(|| serde_json::json!({})))
    }

    /// Replaces the campaign `settings` JSON object.
    pub async fn set_campaign_settings(
        &self,
        campaign_id: Uuid,
        settings: &serde_json::Value,
    ) -> Result<(), String> {
        self.ensure_campaign_row(campaign_id).await?;
        sqlx::query("UPDATE campaigns SET settings = $2, updated_at = NOW() WHERE id = $1")
            .bind(campaign_id)
            .bind(settings)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
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
            let payload_json =
                serde_json::to_value(&entry).map_err(|e| WalError::Serialization(e.to_string()))?;

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
            let row_opt =
                sqlx::query("SELECT snapshot_data FROM wal_snapshots WHERE campaign_id = $1")
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

    fn list_campaign_members(
        &self,
        campaign_id: Uuid,
    ) -> BoxFuture<'_, Result<Vec<CampaignMemberRecord>, SessionError>> {
        Box::pin(async move {
            self.get_campaign_details(campaign_id)
                .await
                .map(|d| d.map(|(_, members)| members).unwrap_or_default())
                .map_err(SessionError::Storage)
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
                role: row.try_get("role").unwrap_or_else(|_| "PLAYER".to_string()),
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
                role: row.try_get("role").unwrap_or_else(|_| "PLAYER".to_string()),
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
            let res =
                sqlx::query("DELETE FROM personal_access_tokens WHERE id = $1 AND user_id = $2")
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
        // The archive carries no owner: the system GM satisfies the FK until the import
        // route replaces it with the caller through `set_campaign_gm`.
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

    async fn save_entities(
        &self,
        campaign_id: Uuid,
        entities: &[ExportEntity],
    ) -> Result<(), ArchiveError> {
        self.ensure_campaign_row(campaign_id)
            .await
            .map_err(|e| ArchiveError::Io(std::io::Error::other(e)))?;
        let map_scenes: Vec<CampaignMapScene> = entities
            .iter()
            .filter_map(|e| restorable_scene(campaign_id, e))
            .collect();
        if !map_scenes.is_empty() {
            let io = |e: String| ArchiveError::Io(std::io::Error::other(e));
            let mut tx = self.pool.begin().await.map_err(|e| io(e.to_string()))?;
            Self::replace_scene_rows(&mut tx, campaign_id, &map_scenes)
                .await
                .map_err(io)?;
            tx.commit().await.map_err(|e| io(e.to_string()))?;
        }
        for entity in entities {
            if restorable_scene(campaign_id, entity).is_some() {
                continue;
            }
            if let Some((actor_id, name, owner, data)) = split_actor_entity(entity) {
                let io = |e: String| ArchiveError::Io(std::io::Error::other(e));
                // `actors.owner_user_id` references `users`: drop owners unknown here.
                let owner = match owner {
                    Some(uid) => {
                        sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE id = $1")
                            .bind(uid)
                            .fetch_optional(&self.pool)
                            .await
                            .map_err(|e| io(e.to_string()))?
                    }
                    None => None,
                };
                self.create_actor(campaign_id, actor_id, owner, &name, data)
                    .await
                    .map_err(|e| io(e.to_string()))?;
                continue;
            }
            let entity_id = entity
                .data
                .get("id")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
                .unwrap_or_else(Uuid::new_v4);

            let valid_type = match entity.entity_type.as_str() {
                "scene" | "item" => entity.entity_type.as_str(),
                _ => "item",
            };
            sqlx::query(
                "INSERT INTO campaign_entities (id, campaign_id, entity_type, version, payload)
                 VALUES ($1, $2, $3, 1, $4)
                 ON CONFLICT (campaign_id, id) DO UPDATE SET
                   version = campaign_entities.version + 1,
                   payload = EXCLUDED.payload,
                   updated_at = NOW()",
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

    async fn save_notes(
        &self,
        campaign_id: Uuid,
        notes: &[NoteRecord],
    ) -> Result<(), ArchiveError> {
        self.ensure_campaign_row(campaign_id)
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
            .bind(campaign_id)
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
            let _ = store
                .upsert_campaign_member(campaign_id, user_id, "GM")
                .await;
        });
    }
}

/// UUIDv5 namespace for party journal row ids (`{campaign_id}:{handout_id}`).
const JOURNAL_ROW_NAMESPACE: Uuid = Uuid::from_u128(0x6f1c_2a7e_93d4_4b58_a0e2_5c71_d8b9_4e36);

/// Deterministic journal row id, so revealing the same handout again updates one row even
/// when the handout id is a free-form slug such as `ancient-map`.
pub fn journal_row_id(campaign_id: Uuid, handout_id: &str) -> Uuid {
    Uuid::new_v5(
        &JOURNAL_ROW_NAMESPACE,
        format!("{campaign_id}:{handout_id}").as_bytes(),
    )
}

/// Logs a party journal storage failure with ids only and wraps the cause.
fn journal_error(op: &'static str, campaign_id: &str, err: impl std::fmt::Display) -> NotesError {
    tracing::error!(op, campaign_id, error = %err, "party journal storage failure");
    NotesError::Storage(err.to_string())
}

/// Logs a session timeline storage failure with ids only and wraps the cause.
fn timeline_error(
    op: &'static str,
    campaign_id: &str,
    session_num: u32,
    err: impl std::fmt::Display,
) -> TimelineError {
    tracing::error!(op, campaign_id, session_num, error = %err, "session timeline storage failure");
    TimelineError::Storage(err.to_string())
}

impl PartyJournalStorage for SqlxPostgresStore {
    /// Upserts the entry with the revealing user (`entry.revealed_by`) as author. Repeat
    /// reveals of the same `(campaign_id, handout_id)` replace the row and refresh `created_at`.
    fn insert_entry(&self, entry: PartyJournalEntry) -> Result<(), NotesError> {
        let pool = self.pool.clone();
        run_pg_blocking(async move {
            let cid = entry.campaign_id.as_str();
            let fail = |err: &dyn std::fmt::Display| journal_error("insert_entry", cid, err);
            let campaign_uuid = Uuid::parse_str(cid).map_err(|e| fail(&e))?;
            let author_id = Uuid::parse_str(&entry.revealed_by).map_err(|e| fail(&e))?;
            Self::ensure_campaign_row_on_pool(&pool, campaign_uuid)
                .await
                .map_err(|e| fail(&e))?;
            let payload = serde_json::to_value(&entry).map_err(|e| fail(&e))?;

            sqlx::query(
                "INSERT INTO party_journal_entries (id, campaign_id, session_num, author_user_id, title, body_markdown, payload)
                 VALUES ($1, $2, $7, $3, $4, $5, $6)
                 ON CONFLICT (id) DO UPDATE SET
                   session_num = EXCLUDED.session_num,
                   author_user_id = EXCLUDED.author_user_id,
                   title = EXCLUDED.title,
                   body_markdown = EXCLUDED.body_markdown,
                   payload = EXCLUDED.payload,
                   created_at = NOW()",
            )
            .bind(journal_row_id(campaign_uuid, &entry.handout_id))
            .bind(campaign_uuid)
            .bind(author_id)
            .bind(&entry.title)
            .bind(&entry.content)
            .bind(&payload)
            .bind(entry.session_num as i32)
            .execute(&pool)
            .await
            .map_err(|e| fail(&e))?;
            Ok(())
        })
    }

    fn list_entries(&self, campaign_id: &str) -> Result<Vec<PartyJournalEntry>, NotesError> {
        let pool = self.pool.clone();
        let cid_str = campaign_id.to_string();
        run_pg_blocking(async move {
            let fail = |err: &dyn std::fmt::Display| journal_error("list_entries", &cid_str, err);
            let campaign_uuid = Uuid::parse_str(&cid_str).map_err(|e| fail(&e))?;
            let rows = sqlx::query(
                "SELECT payload FROM party_journal_entries
                 WHERE campaign_id = $1
                 ORDER BY created_at DESC",
            )
            .bind(campaign_uuid)
            .fetch_all(&pool)
            .await
            .map_err(|e| fail(&e))?;

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
                .map_err(|e| journal_error("get_entry", "*", e))?;

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
            let fail = |err: &dyn std::fmt::Display| {
                timeline_error("append_event", &cid_str, session_num, err)
            };
            let campaign_uuid = Uuid::parse_str(&cid_str).map_err(|e| fail(&e))?;
            Self::ensure_campaign_row_on_pool(&pool, campaign_uuid)
                .await
                .map_err(|e| fail(&e))?;

            let max_seq: Option<i64> = sqlx::query_scalar(
                "SELECT MAX(sequence_num) FROM session_timeline_events
                 WHERE campaign_id = $1 AND session_num = $2",
            )
            .bind(campaign_uuid)
            .bind(session_num as i32)
            .fetch_one(&pool)
            .await
            .map_err(|e| fail(&e))?;

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
            let ev_json = serde_json::to_value(&ev).map_err(|e| fail(&e))?;

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
            .map_err(|e| fail(&e))?;

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
            let fail = |err: &dyn std::fmt::Display| {
                timeline_error("get_timeline", &cid_str, session_num, err)
            };
            let campaign_uuid = Uuid::parse_str(&cid_str).map_err(|e| fail(&e))?;
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
            .map_err(|e| fail(&e))?;

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
            let campaign_id =
                extract_campaign_id_from_asset_key(key).unwrap_or_else(|| Uuid::from_u128(1));
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
            let row_opt = sqlx::query("SELECT payload FROM campaign_assets WHERE asset_key = $1")
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
            let exists: Option<String> =
                sqlx::query_scalar("SELECT asset_key FROM campaign_assets WHERE asset_key = $1")
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

    fn verify_presigned_get(&self, key: &str, exp: u64, sig_hex: &str) -> bool {
        crate::assets::store::verify_asset_signature(&self.signing_secret, key, exp, sig_hex)
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
