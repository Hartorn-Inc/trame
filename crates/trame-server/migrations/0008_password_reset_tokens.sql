-- ============================================================================
-- ONE-TIME PASSWORD-RESET LINKS (0008)
-- ============================================================================
--
-- PURPOSE:
-- --------
-- Storage for account recovery (`auth/recovery.rs`, spec story 15): the
-- `Owner` (or the `owner-reset-link` CLI for the `Owner` itself) mints a
-- one-time link that lets an account holder set a new password.
--
-- INVARIANTS:
-- -----------
--   1. Only the SHA-256 digest of a token is stored (`token_hash`).
--   2. A link lives at most 24 hours: `expires_at <= created_at + 24 hours`.
--   3. `used_at` is set by the first successful redemption; a used link is dead.
--   4. `created_by` is NULL for CLI-minted links and survives the minting
--      account's deletion (`ON DELETE SET NULL`); the link dies with its target
--      account (`ON DELETE CASCADE`).
-- ============================================================================

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash VARCHAR(64) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ NULL,
    CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
