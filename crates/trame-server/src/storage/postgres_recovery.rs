//! ============================================================================
//! POSTGRESQL RECOVERY STORE: PASSWORD-RESET LINKS (postgres_recovery.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Implements `RecoveryStore` on `SqlxPostgresStore` over
//! `password_reset_tokens` (migration `0008`), `users.password_hash`, and
//! `auth_sessions`, so reset links survive restarts and a reset or password
//! change revokes sessions on every replica.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Row-Locked Redemption`:
//!      - `redeem_password_reset` locks the token row (`SELECT ... FOR UPDATE`)
//!        and marks it used, writes the password and deletes the sessions in
//!        one transaction, so two concurrent redemptions consume a link once.
//!   2. `One Unused Link Per Account`:
//!      - `create_password_reset` deletes the account's unused links before
//!        inserting the new one, in the same transaction.
//! ============================================================================

use super::postgres::SqlxPostgresStore;
use crate::auth::password::IdentityStore;
use crate::auth::recovery::{
    PasswordResetError, PasswordResetLookup, PasswordResetRecord, RecoveryStore,
};
use crate::auth::session::{BoxFuture, SessionError};
use sqlx::Row;
use uuid::Uuid;

fn storage(err: impl std::fmt::Display) -> SessionError {
    SessionError::Storage(err.to_string())
}

impl RecoveryStore for SqlxPostgresStore {
    fn create_password_reset(
        &self,
        record: PasswordResetRecord,
    ) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(async move {
            let mut tx = self.pool().begin().await.map_err(storage)?;
            sqlx::query("DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL")
                .bind(record.user_id)
                .execute(&mut *tx)
                .await
                .map_err(storage)?;
            sqlx::query(
                "INSERT INTO password_reset_tokens (token_hash, user_id, created_by, created_at, expires_at)
                 VALUES ($1, $2, $3, to_timestamp($4::DOUBLE PRECISION), to_timestamp($5::DOUBLE PRECISION))",
            )
            .bind(&record.token_hash)
            .bind(record.user_id)
            .bind(record.created_by)
            .bind(record.created_at as f64)
            .bind(record.expires_at as f64)
            .execute(&mut *tx)
            .await
            .map_err(storage)?;
            tx.commit().await.map_err(storage)
        })
    }

    fn password_reset_lookup<'a>(
        &'a self,
        token_hash: &'a str,
        now: u64,
    ) -> BoxFuture<'a, Result<PasswordResetLookup, SessionError>> {
        Box::pin(async move {
            let row = sqlx::query(
                "SELECT user_id, EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires_epoch
                 FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL",
            )
            .bind(token_hash)
            .fetch_optional(self.pool())
            .await
            .map_err(storage)?;
            let Some(row) = row else {
                return Ok(PasswordResetLookup::Invalid);
            };
            let expires_at = row.try_get::<i64, _>("expires_epoch").unwrap_or(0).max(0) as u64;
            if now >= expires_at {
                return Ok(PasswordResetLookup::Expired);
            }
            let user_id: Uuid = row.try_get("user_id").map_err(storage)?;
            Ok(match self.get_user_by_id(user_id).await? {
                Some(user) => PasswordResetLookup::Valid(user),
                None => PasswordResetLookup::Invalid,
            })
        })
    }

    fn redeem_password_reset<'a>(
        &'a self,
        token_hash: &'a str,
        password_hash: &'a str,
        now: u64,
    ) -> BoxFuture<'a, Result<Uuid, PasswordResetError>> {
        let fail = |e: sqlx::Error| PasswordResetError::Storage(e.to_string());
        Box::pin(async move {
            let mut tx = self.pool().begin().await.map_err(fail)?;
            let row = sqlx::query(
                "SELECT user_id, EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires_epoch
                 FROM password_reset_tokens
                 WHERE token_hash = $1 AND used_at IS NULL
                 FOR UPDATE",
            )
            .bind(token_hash)
            .fetch_optional(&mut *tx)
            .await
            .map_err(fail)?
            .ok_or(PasswordResetError::Invalid)?;
            let expires_at = row.try_get::<i64, _>("expires_epoch").unwrap_or(0).max(0) as u64;
            if now >= expires_at {
                return Err(PasswordResetError::Expired);
            }
            let user_id: Uuid = row.try_get("user_id").map_err(fail)?;
            sqlx::query(
                "UPDATE password_reset_tokens SET used_at = to_timestamp($2::DOUBLE PRECISION)
                 WHERE token_hash = $1",
            )
            .bind(token_hash)
            .bind(now as f64)
            .execute(&mut *tx)
            .await
            .map_err(fail)?;
            sqlx::query("UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1")
                .bind(user_id)
                .bind(password_hash)
                .execute(&mut *tx)
                .await
                .map_err(fail)?;
            sqlx::query("DELETE FROM auth_sessions WHERE user_id = $1")
                .bind(user_id)
                .execute(&mut *tx)
                .await
                .map_err(fail)?;
            tx.commit().await.map_err(fail)?;
            Ok(user_id)
        })
    }

    fn change_password<'a>(
        &'a self,
        user_id: Uuid,
        password_hash: &'a str,
        keep_session: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            let mut tx = self.pool().begin().await.map_err(storage)?;
            let updated = sqlx::query(
                "UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1",
            )
            .bind(user_id)
            .bind(password_hash)
            .execute(&mut *tx)
            .await
            .map_err(storage)?;
            if updated.rows_affected() == 0 {
                return Err(SessionError::NotFound);
            }
            sqlx::query(
                "DELETE FROM auth_sessions WHERE user_id = $1 AND token_hash IS DISTINCT FROM $2",
            )
            .bind(user_id)
            .bind(keep_session)
            .execute(&mut *tx)
            .await
            .map_err(storage)?;
            tx.commit().await.map_err(storage)
        })
    }
}
