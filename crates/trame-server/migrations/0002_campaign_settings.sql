-- Per-campaign settings object (e.g. `mcp_staging_mode`), read and written by
-- `GET/PUT /api/v1/campaigns/{id}/settings` and consulted by the MCP endpoint.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
