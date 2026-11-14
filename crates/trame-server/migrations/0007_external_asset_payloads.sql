-- ============================================================================
-- EXTERNAL ASSET PAYLOADS (0007_external_asset_payloads.sql)
-- ============================================================================
--
-- PURPOSE:
-- --------
-- Lets `campaign_assets` describe an asset whose bytes live in the S3-compatible
-- object store (`S3Store`, ADR-0041) instead of the `payload` column. The row
-- keeps the key, campaign, content type and size, so membership checks, signed
-- download URLs and the per-campaign storage quota keep reading PostgreSQL.
--
-- INVARIANTS & SAFETY BOUNDARIES:
-- -------------------------------
--   1. `payload IS NULL` means "stored in the object store". It is set only
--      after the object was written and read back with a matching SHA-256.
--   2. `byte_size` stays authoritative for both kinds of row (quota, SEC14).
-- ============================================================================

ALTER TABLE campaign_assets ALTER COLUMN payload DROP NOT NULL;
