-- Optimistic concurrency counter for the campaign scene set (ADR-0037 shape):
-- `PUT /api/v1/campaigns/{id}/maps` must send `expected_version` equal to this
-- value; every accepted scene write increments it. Existing rows start at 0.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scenes_version BIGINT NOT NULL DEFAULT 0;
