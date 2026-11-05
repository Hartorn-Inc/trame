-- ============================================================================
-- INSTANCE ROLES, OWNER BOOTSTRAP, INSTANCE SETTINGS & CAMPAIGN INVITES (0005)
-- ============================================================================
--
-- PURPOSE:
-- --------
-- Storage for ADR-0039 (invite-only registration and `InstanceRole`):
--   - `users.instance_role` (`OWNER`, `HOST`, `MEMBER`; SEC10, D1).
--   - `owner_bootstrap_tokens`: hashed single-use setup tokens (D15).
--   - `instance_settings`: the single row holding the persisted instance id (SEC11).
--   - `campaign_invites` + `invite_redemptions`: bounded invite links (SEC7, D3).
--
-- EXISTING ACCOUNTS (migration choice):
-- -------------------------------------
--   - Nobody becomes `OWNER` here. Picking the oldest account would hand the
--     instance to whoever registered first on an open server; instead the
--     server boots without an `OWNER` and logs a one-time setup URL, so the
--     operator claims the instance explicitly (with an existing email or a
--     new account).
--   - Every non-ephemeral account that is `GM` of a campaign (membership row
--     or `campaigns.gm_user_id`) becomes `HOST`, so current Game Masters can
--     keep creating campaigns. The WAL placeholder user
--     `00000000-0000-0000-0000-000000000001` is excluded.
--   - Everyone else becomes `MEMBER` (the column default).
--
-- INVARIANTS:
-- -----------
--   1. At most one `OWNER`: partial unique index `users_single_owner`.
--   2. At most one unrevoked invite per campaign: `campaign_invites_one_unrevoked`.
--   3. `expires_at <= created_at + 7 days`, `1 <= max_uses <= 100`,
--      `0 <= use_count <= max_uses` are enforced by `CHECK` constraints.
--   4. One redemption per (invite, user).
--   5. `instance_settings` holds at most one row (`singleton` is always TRUE).
-- ============================================================================

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS instance_role VARCHAR(10) NOT NULL DEFAULT 'MEMBER'
    CHECK (instance_role IN ('OWNER', 'HOST', 'MEMBER'));

CREATE UNIQUE INDEX IF NOT EXISTS users_single_owner
    ON users (instance_role) WHERE instance_role = 'OWNER';

UPDATE users u
SET instance_role = 'HOST'
WHERE u.is_ephemeral = FALSE
  AND u.instance_role = 'MEMBER'
  AND u.id <> '00000000-0000-0000-0000-000000000001'::UUID
  AND (
    EXISTS (SELECT 1 FROM campaign_members cm WHERE cm.user_id = u.id AND cm.role = 'GM')
    OR EXISTS (SELECT 1 FROM campaigns c WHERE c.gm_user_id = u.id)
  );

CREATE TABLE IF NOT EXISTS owner_bootstrap_tokens (
    token_hash VARCHAR(64) PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS instance_settings (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    instance_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_invites (
    id UUID PRIMARY KEY,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
    use_count INTEGER NOT NULL DEFAULT 0,
    revoked_at TIMESTAMPTZ NULL,
    CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '7 days'),
    CHECK (use_count >= 0 AND use_count <= max_uses)
);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_invites_one_unrevoked
    ON campaign_invites (campaign_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS invite_redemptions (
    invite_id UUID NOT NULL REFERENCES campaign_invites(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redeemed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (invite_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_invite_redemptions_user ON invite_redemptions(user_id);
