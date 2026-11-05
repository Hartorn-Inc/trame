-- ============================================================================
-- QUARANTINED WAL ENTRIES (0010_quarantined_wal_entries.sql)
-- ============================================================================
--
-- PURPOSE:
-- --------
-- Stores `QuarantinedWalEntry` records (ADR-0040, D4): WAL entries that failed
-- to replay during room recovery, together with every later entry of the same
-- recovery. The room opens at the last good state instead of refusing to wake;
-- these rows keep what was set aside for inspection.
--
-- INVARIANTS & SAFETY BOUNDARIES:
-- -------------------------------
--   1. Never replayed: no code path reads these rows back into `wal_entries`.
--   2. Atomic move: rows are inserted and the matching `wal_entries` rows are
--      deleted in one transaction (`SqlxPostgresStore::quarantine_entries`).
--   3. A sequence number can be quarantined more than once across recoveries,
--      so the primary key is a surrogate `id`, not `(campaign_id, sequence_num)`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS quarantined_wal_entries (
    id BIGSERIAL PRIMARY KEY,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    sequence_num BIGINT NOT NULL,
    command_kind VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    error TEXT NOT NULL,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quarantined_wal_entries_campaign
    ON quarantined_wal_entries(campaign_id, sequence_num);
