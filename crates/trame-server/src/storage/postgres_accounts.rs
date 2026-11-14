//! ============================================================================
//! POSTGRESQL ACCOUNT STORE: INSTANCE ROLES, BOOTSTRAP & INVITES (postgres_accounts.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Implements `AccountStore` on `SqlxPostgresStore` over the tables of
//! migration `0005_instance_roles_and_campaign_invites.sql`: `users.instance_role`,
//! `owner_bootstrap_tokens`, `instance_settings`, `campaign_invites`, and
//! `invite_redemptions`. Without it a production server (which always runs on
//! PostgreSQL, SEC12) would lose the instance id, the `Owner`, and every
//! invite limit on restart.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Row-Locked Critical Sections`:
//!      - `claim_owner` and `redeem_campaign_invite` run in one transaction
//!        that first locks the token row (`SELECT ... FOR UPDATE`), so two
//!        concurrent requests on the same token serialize: a bootstrap token
//!        is consumed once and `use_count` never exceeds `max_uses`.
//!   2. `Constraint Backstops`:
//!      - `users_single_owner` rejects a second `OWNER` even if two different
//!        bootstrap tokens were raced; `campaign_invites_one_unrevoked`
//!        rejects two unrevoked invites for one campaign.
//!   3. `All-or-Nothing Account Creation`:
//!      - A failed membership or redemption insert rolls back the account
//!        created in the same transaction (the transaction is dropped
//!        without commit).
//! ============================================================================

use super::postgres::SqlxPostgresStore;
use crate::auth::accounts::{
    AccountStore, BootstrapTokenStatus, CampaignInviteRecord, INVITE_MEMBER_ROLE, InstanceRole,
    InviteRedeemError, InviteRedeemer, InviteRedemptionOutcome, InviteRedemptionRecord,
    InviteStatus, OwnerClaim, OwnerClaimError,
};
use crate::auth::password::IdentityStore;
use crate::auth::session::{BoxFuture, CampaignMemberRecord, SessionError, UserRecord};
use sqlx::postgres::PgRow;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

/// WAL placeholder account created by `ensure_campaign_row`; never listed as a user.
const SYSTEM_USER_ID: Uuid = Uuid::from_u128(1);

/// Column list read by `invite_from_row` (a macro so `concat!` keeps queries `&'static str`).
macro_rules! invite_columns {
    () => {
        "id, campaign_id, token_hash, created_by,
         EXTRACT(EPOCH FROM created_at)::BIGINT AS created_epoch,
         EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires_epoch,
         max_uses, use_count,
         EXTRACT(EPOCH FROM revoked_at)::BIGINT AS revoked_epoch"
    };
}

/// Reads `users.instance_role`; unknown or missing values fall back to `Member`.
pub(crate) fn instance_role_column(row: &PgRow) -> InstanceRole {
    row.try_get::<String, _>("instance_role")
        .ok()
        .and_then(|v| InstanceRole::parse(&v))
        .unwrap_or_default()
}

fn storage(err: impl std::fmt::Display) -> SessionError {
    SessionError::Storage(err.to_string())
}

fn epoch(row: &PgRow, column: &str) -> u64 {
    row.try_get::<i64, _>(column).unwrap_or(0).max(0) as u64
}

fn invite_from_row(row: &PgRow) -> Result<CampaignInviteRecord, SessionError> {
    Ok(CampaignInviteRecord {
        id: row.try_get("id").map_err(storage)?,
        campaign_id: row.try_get("campaign_id").map_err(storage)?,
        token_hash: row.try_get("token_hash").map_err(storage)?,
        created_by: row.try_get("created_by").map_err(storage)?,
        created_at: epoch(row, "created_epoch"),
        expires_at: epoch(row, "expires_epoch"),
        max_uses: row.try_get::<i32, _>("max_uses").map_err(storage)?.max(0) as u32,
        use_count: row.try_get::<i32, _>("use_count").map_err(storage)?.max(0) as u32,
        revoked_at: row
            .try_get::<Option<i64>, _>("revoked_epoch")
            .ok()
            .flatten()
            .map(|v| v.max(0) as u64),
    })
}

fn user_from_row(row: &PgRow) -> Result<UserRecord, SessionError> {
    Ok(UserRecord {
        id: row.try_get("id").map_err(storage)?,
        username: row.try_get("display_name").map_err(storage)?,
        role: row.try_get("role").unwrap_or_else(|_| "PLAYER".to_string()),
        is_guest: row.try_get("is_ephemeral").unwrap_or(false),
        created_at: epoch(row, "created_epoch"),
        email: row.try_get("email").ok(),
        password_hash: row.try_get("password_hash").ok().flatten(),
        mfa_enabled: row.try_get("mfa_enabled").unwrap_or(false),
        totp_secret: row.try_get("totp_secret").ok().flatten(),
        pending_totp_secret: row.try_get("pending_totp_secret").ok().flatten(),
        instance_role: instance_role_column(row),
    })
}

/// Inserts a fresh account inside `tx`; `Ok(false)` when the email is already registered.
async fn insert_account(
    tx: &mut Transaction<'_, Postgres>,
    user: &UserRecord,
    role: InstanceRole,
) -> Result<bool, sqlx::Error> {
    let email = user.email.clone().unwrap_or_default().to_lowercase();
    let taken: Option<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE LOWER(email) = $1")
        .bind(&email)
        .fetch_optional(&mut **tx)
        .await?;
    if taken.is_some() {
        return Ok(false);
    }
    sqlx::query(
        "INSERT INTO users (id, email, display_name, password_hash, is_ephemeral, role, instance_role)
         VALUES ($1, $2, $3, $4, FALSE, $5, $6)",
    )
    .bind(user.id)
    .bind(&email)
    .bind(&user.username)
    .bind(&user.password_hash)
    .bind(&user.role)
    .bind(role.as_str())
    .execute(&mut **tx)
    .await?;
    Ok(true)
}

fn is_unique_violation(err: &sqlx::Error) -> bool {
    err.as_database_error()
        .and_then(|e| e.code())
        .is_some_and(|code| code == "23505")
}

impl AccountStore for SqlxPostgresStore {
    fn owner_exists(&self) -> BoxFuture<'_, Result<bool, SessionError>> {
        Box::pin(async move {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (SELECT 1 FROM users WHERE instance_role = 'OWNER')",
            )
            .fetch_one(self.pool())
            .await
            .map_err(storage)
        })
    }

    fn list_users(&self) -> BoxFuture<'_, Result<Vec<UserRecord>, SessionError>> {
        Box::pin(async move {
            let rows = sqlx::query(
                "SELECT id, email, display_name, password_hash, is_ephemeral, role,
                        mfa_enabled, totp_secret, pending_totp_secret, instance_role,
                        EXTRACT(EPOCH FROM created_at)::BIGINT AS created_epoch
                 FROM users
                 WHERE id <> $1
                 ORDER BY created_at, id",
            )
            .bind(SYSTEM_USER_ID)
            .fetch_all(self.pool())
            .await
            .map_err(storage)?;
            rows.iter().map(user_from_row).collect()
        })
    }

    fn set_instance_role(
        &self,
        user_id: Uuid,
        role: InstanceRole,
    ) -> BoxFuture<'_, Result<Option<UserRecord>, SessionError>> {
        Box::pin(async move {
            let updated = sqlx::query(
                "UPDATE users SET instance_role = $2, updated_at = NOW() WHERE id = $1 AND id <> $3",
            )
            .bind(user_id)
            .bind(role.as_str())
            .bind(SYSTEM_USER_ID)
            .execute(self.pool())
            .await
            .map_err(storage)?;
            if updated.rows_affected() == 0 {
                return Ok(None);
            }
            self.get_user_by_id(user_id).await
        })
    }

    fn replace_owner_bootstrap_token<'a>(
        &'a self,
        token_hash: &'a str,
        expires_at: u64,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            let mut tx = self.pool().begin().await.map_err(storage)?;
            sqlx::query("DELETE FROM owner_bootstrap_tokens")
                .execute(&mut *tx)
                .await
                .map_err(storage)?;
            sqlx::query(
                "INSERT INTO owner_bootstrap_tokens (token_hash, expires_at)
                 VALUES ($1, to_timestamp($2::DOUBLE PRECISION))",
            )
            .bind(token_hash)
            .bind(expires_at as f64)
            .execute(&mut *tx)
            .await
            .map_err(storage)?;
            tx.commit().await.map_err(storage)
        })
    }

    fn owner_bootstrap_token_status<'a>(
        &'a self,
        token_hash: &'a str,
        now: u64,
    ) -> BoxFuture<'a, Result<BootstrapTokenStatus, SessionError>> {
        Box::pin(async move {
            let row = sqlx::query(
                "SELECT EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires_epoch,
                        used_at IS NOT NULL AS used
                 FROM owner_bootstrap_tokens WHERE token_hash = $1",
            )
            .bind(token_hash)
            .fetch_optional(self.pool())
            .await
            .map_err(storage)?;
            Ok(match row {
                Some(row) if row.try_get::<bool, _>("used").unwrap_or(true) => {
                    BootstrapTokenStatus::Invalid
                }
                Some(row) if now >= epoch(&row, "expires_epoch") => BootstrapTokenStatus::Expired,
                Some(_) => BootstrapTokenStatus::Valid,
                None => BootstrapTokenStatus::Invalid,
            })
        })
    }

    fn claim_owner<'a>(
        &'a self,
        token_hash: &'a str,
        claim: OwnerClaim,
        now: u64,
    ) -> BoxFuture<'a, Result<UserRecord, OwnerClaimError>> {
        let fail = |e: sqlx::Error| OwnerClaimError::Storage(e.to_string());
        Box::pin(async move {
            let mut tx = self.pool().begin().await.map_err(fail)?;
            let token = sqlx::query(
                "SELECT EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires_epoch,
                        used_at IS NOT NULL AS used
                 FROM owner_bootstrap_tokens WHERE token_hash = $1 FOR UPDATE",
            )
            .bind(token_hash)
            .fetch_optional(&mut *tx)
            .await
            .map_err(fail)?;
            match token {
                Some(row)
                    if !row.try_get::<bool, _>("used").unwrap_or(true)
                        && now < epoch(&row, "expires_epoch") => {}
                _ => return Err(OwnerClaimError::InvalidToken),
            }
            let owner_exists: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM users WHERE instance_role = 'OWNER')",
            )
            .fetch_one(&mut *tx)
            .await
            .map_err(fail)?;
            if owner_exists {
                return Err(OwnerClaimError::OwnerExists);
            }
            let owner_id = match &claim {
                OwnerClaim::NewAccount(user) => {
                    match insert_account(&mut tx, user, InstanceRole::Owner).await {
                        Ok(true) => user.id,
                        Ok(false) => return Err(OwnerClaimError::EmailTaken),
                        Err(e) if is_unique_violation(&e) => {
                            return Err(OwnerClaimError::OwnerExists);
                        }
                        Err(e) => return Err(fail(e)),
                    }
                }
                OwnerClaim::ExistingUser(user_id) => {
                    sqlx::query(
                        "UPDATE users SET instance_role = 'OWNER', updated_at = NOW() WHERE id = $1",
                    )
                    .bind(user_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| {
                        if is_unique_violation(&e) {
                            OwnerClaimError::OwnerExists
                        } else {
                            fail(e)
                        }
                    })?;
                    *user_id
                }
            };
            sqlx::query("UPDATE owner_bootstrap_tokens SET used_at = NOW() WHERE token_hash = $1")
                .bind(token_hash)
                .execute(&mut *tx)
                .await
                .map_err(fail)?;
            tx.commit().await.map_err(fail)?;
            self.get_user_by_id(owner_id)
                .await
                .map_err(|e| OwnerClaimError::Storage(e.to_string()))?
                .ok_or_else(|| OwnerClaimError::Storage("owner not found after claim".to_string()))
        })
    }

    fn load_or_init_instance_id(
        &self,
        candidate: Uuid,
    ) -> BoxFuture<'_, Result<Uuid, SessionError>> {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO instance_settings (singleton, instance_id) VALUES (TRUE, $1)
                 ON CONFLICT (singleton) DO NOTHING",
            )
            .bind(candidate)
            .execute(self.pool())
            .await
            .map_err(storage)?;
            sqlx::query_scalar("SELECT instance_id FROM instance_settings WHERE singleton")
                .fetch_one(self.pool())
                .await
                .map_err(storage)
        })
    }

    fn create_campaign_invite(
        &self,
        invite: CampaignInviteRecord,
    ) -> BoxFuture<'_, Result<CampaignInviteRecord, SessionError>> {
        Box::pin(async move {
            let mut tx = self.pool().begin().await.map_err(storage)?;
            sqlx::query(
                "UPDATE campaign_invites SET revoked_at = to_timestamp($2::DOUBLE PRECISION)
                 WHERE campaign_id = $1 AND revoked_at IS NULL",
            )
            .bind(invite.campaign_id)
            .bind(invite.created_at as f64)
            .execute(&mut *tx)
            .await
            .map_err(storage)?;
            sqlx::query(
                "INSERT INTO campaign_invites
                   (id, campaign_id, token_hash, created_by, created_at, expires_at, max_uses, use_count)
                 VALUES ($1, $2, $3, $4, to_timestamp($5::DOUBLE PRECISION),
                         to_timestamp($6::DOUBLE PRECISION), $7, 0)",
            )
            .bind(invite.id)
            .bind(invite.campaign_id)
            .bind(&invite.token_hash)
            .bind(invite.created_by)
            .bind(invite.created_at as f64)
            .bind(invite.expires_at as f64)
            .bind(invite.max_uses as i32)
            .execute(&mut *tx)
            .await
            .map_err(storage)?;
            tx.commit().await.map_err(storage)?;
            Ok(invite)
        })
    }

    fn unrevoked_campaign_invite(
        &self,
        campaign_id: Uuid,
    ) -> BoxFuture<'_, Result<Option<CampaignInviteRecord>, SessionError>> {
        Box::pin(async move {
            let row = sqlx::query(concat!(
                "SELECT ",
                invite_columns!(),
                " FROM campaign_invites WHERE campaign_id = $1 AND revoked_at IS NULL"
            ))
            .bind(campaign_id)
            .fetch_optional(self.pool())
            .await
            .map_err(storage)?;
            row.as_ref().map(invite_from_row).transpose()
        })
    }

    fn revoke_campaign_invite(
        &self,
        campaign_id: Uuid,
        now: u64,
    ) -> BoxFuture<'_, Result<Option<CampaignInviteRecord>, SessionError>> {
        Box::pin(async move {
            let row = sqlx::query(concat!(
                "UPDATE campaign_invites SET revoked_at = to_timestamp($2::DOUBLE PRECISION)
                 WHERE campaign_id = $1 AND revoked_at IS NULL RETURNING ",
                invite_columns!()
            ))
            .bind(campaign_id)
            .bind(now as f64)
            .fetch_optional(self.pool())
            .await
            .map_err(storage)?;
            row.as_ref().map(invite_from_row).transpose()
        })
    }

    fn find_campaign_invite<'a>(
        &'a self,
        token_hash: &'a str,
    ) -> BoxFuture<'a, Result<Option<CampaignInviteRecord>, SessionError>> {
        Box::pin(async move {
            let row = sqlx::query(concat!(
                "SELECT ",
                invite_columns!(),
                " FROM campaign_invites WHERE token_hash = $1"
            ))
            .bind(token_hash)
            .fetch_optional(self.pool())
            .await
            .map_err(storage)?;
            row.as_ref().map(invite_from_row).transpose()
        })
    }

    fn redeem_campaign_invite<'a>(
        &'a self,
        token_hash: &'a str,
        redeemer: InviteRedeemer,
        now: u64,
    ) -> BoxFuture<'a, Result<InviteRedemptionOutcome, InviteRedeemError>> {
        let fail = |e: sqlx::Error| InviteRedeemError::Storage(e.to_string());
        Box::pin(async move {
            let mut tx = self.pool().begin().await.map_err(fail)?;
            let row = sqlx::query(concat!(
                "SELECT ",
                invite_columns!(),
                " FROM campaign_invites WHERE token_hash = $1 FOR UPDATE"
            ))
            .bind(token_hash)
            .fetch_optional(&mut *tx)
            .await
            .map_err(fail)?
            .ok_or(InviteRedeemError::NotFound)?;
            let mut invite =
                invite_from_row(&row).map_err(|e| InviteRedeemError::Storage(e.to_string()))?;

            if let InviteRedeemer::ExistingUser(user_id) = &redeemer {
                let existing = sqlx::query(
                    "SELECT role, EXTRACT(EPOCH FROM joined_at)::BIGINT AS joined_epoch
                     FROM campaign_members WHERE campaign_id = $1 AND user_id = $2",
                )
                .bind(invite.campaign_id)
                .bind(user_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(fail)?;
                if let Some(member) = existing {
                    return Ok(InviteRedemptionOutcome {
                        member: CampaignMemberRecord {
                            campaign_id: invite.campaign_id,
                            user_id: *user_id,
                            character_id: None,
                            role: member.try_get("role").map_err(fail)?,
                            joined_at: epoch(&member, "joined_epoch"),
                        },
                        invite,
                        user_id: *user_id,
                        already_member: true,
                    });
                }
                let redeemed_before = sqlx::query(
                    "SELECT 1 FROM invite_redemptions WHERE invite_id = $1 AND user_id = $2",
                )
                .bind(invite.id)
                .bind(user_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(fail)?;
                if redeemed_before.is_some() {
                    return Err(InviteRedeemError::MemberRemoved);
                }
            }
            let status = invite.status(now);
            if status != InviteStatus::Active {
                return Err(status.into());
            }

            let user_id = match &redeemer {
                InviteRedeemer::ExistingUser(user_id) => *user_id,
                InviteRedeemer::NewAccount(user) => {
                    match insert_account(&mut tx, user, InstanceRole::Member).await {
                        Ok(true) => user.id,
                        Ok(false) => return Err(InviteRedeemError::EmailTaken),
                        Err(e) if is_unique_violation(&e) => {
                            return Err(InviteRedeemError::EmailTaken);
                        }
                        Err(e) => return Err(fail(e)),
                    }
                }
            };
            sqlx::query(
                "INSERT INTO campaign_members (campaign_id, user_id, role, joined_at)
                 VALUES ($1, $2, $3, to_timestamp($4::DOUBLE PRECISION))
                 ON CONFLICT (campaign_id, user_id) DO NOTHING",
            )
            .bind(invite.campaign_id)
            .bind(user_id)
            .bind(INVITE_MEMBER_ROLE)
            .bind(now as f64)
            .execute(&mut *tx)
            .await
            .map_err(fail)?;
            sqlx::query(
                "INSERT INTO invite_redemptions (invite_id, user_id, redeemed_at)
                 VALUES ($1, $2, to_timestamp($3::DOUBLE PRECISION))
                 ON CONFLICT (invite_id, user_id) DO UPDATE SET redeemed_at = EXCLUDED.redeemed_at",
            )
            .bind(invite.id)
            .bind(user_id)
            .bind(now as f64)
            .execute(&mut *tx)
            .await
            .map_err(fail)?;
            sqlx::query("UPDATE campaign_invites SET use_count = use_count + 1 WHERE id = $1")
                .bind(invite.id)
                .execute(&mut *tx)
                .await
                .map_err(fail)?;
            tx.commit().await.map_err(fail)?;
            invite.use_count += 1;
            Ok(InviteRedemptionOutcome {
                member: CampaignMemberRecord {
                    campaign_id: invite.campaign_id,
                    user_id,
                    character_id: None,
                    role: INVITE_MEMBER_ROLE.to_string(),
                    joined_at: now,
                },
                invite,
                user_id,
                already_member: false,
            })
        })
    }

    fn list_invite_redemptions(
        &self,
        campaign_id: Uuid,
    ) -> BoxFuture<'_, Result<Vec<InviteRedemptionRecord>, SessionError>> {
        Box::pin(async move {
            let rows = sqlx::query(
                "SELECT r.invite_id, r.user_id, u.display_name,
                        EXTRACT(EPOCH FROM r.redeemed_at)::BIGINT AS redeemed_epoch
                 FROM invite_redemptions r
                 INNER JOIN campaign_invites i ON i.id = r.invite_id
                 INNER JOIN users u ON u.id = r.user_id
                 WHERE i.campaign_id = $1
                 ORDER BY r.redeemed_at DESC, r.user_id",
            )
            .bind(campaign_id)
            .fetch_all(self.pool())
            .await
            .map_err(storage)?;
            rows.iter()
                .map(|row| {
                    Ok(InviteRedemptionRecord {
                        invite_id: row.try_get("invite_id").map_err(storage)?,
                        campaign_id,
                        user_id: row.try_get("user_id").map_err(storage)?,
                        display_name: row.try_get("display_name").map_err(storage)?,
                        redeemed_at: epoch(row, "redeemed_epoch"),
                    })
                })
                .collect()
        })
    }

    fn remove_campaign_member(
        &self,
        campaign_id: Uuid,
        user_id: Uuid,
    ) -> BoxFuture<'_, Result<bool, SessionError>> {
        Box::pin(async move {
            let deleted =
                sqlx::query("DELETE FROM campaign_members WHERE campaign_id = $1 AND user_id = $2")
                    .bind(campaign_id)
                    .bind(user_id)
                    .execute(self.pool())
                    .await
                    .map_err(storage)?;
            Ok(deleted.rows_affected() > 0)
        })
    }
}
