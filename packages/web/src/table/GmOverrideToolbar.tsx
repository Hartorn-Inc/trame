/**
 * ============================================================================
 * GM OVERRIDE TOOLBAR & MCP STAGING REVIEW (table/GmOverrideToolbar.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * GM-only table controls: ambient lighting preset, undo of the last table
 * action, and review of staged MCP batches. An MCP agent in staging mode
 * cannot change the table until the GM presses `[ Commit All ]` (applies the
 * batch atomically as one undoable step) or `[ Reject ]` (discards it).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `GM Only`:
 *    - Renders nothing for players and spectators; the engine rejects these
 *      commands from non-GMs anyway, and non-GM projections never carry
 *      staging proposals.
 * 2. `Proposal Transparency`:
 *    - Each proposal shows its summary and the command tags it would apply,
 *      so the GM commits a known batch, never a blind one.
 * 3. `Undo Re-Opens Prompts`:
 *    - Undo can withdraw reaction prompts (`UNDONE`) or restore earlier ones;
 *      the reaction banner reflects both from the next snapshot.
 * ============================================================================
 */
import type { ApiClient } from '../api/client.ts';
import { t, type MessageKey } from '../i18n/index.ts';
import {
  AMBIENT_LIGHTING_PRESETS,
  commitMcpStaging,
  rejectMcpStaging,
  setAmbientLighting,
  undoLastAction,
  type AmbientLightingPreset,
} from './commands.ts';

export interface GmOverrideToolbarProps {
  client: ApiClient;
  isGm: boolean;
}

export function GmOverrideToolbar({ client, isGm }: GmOverrideToolbarProps) {
  if (!isGm) return null;
  const table = client.state.table.value;
  const proposals = Object.values(client.state.mcpProposals.value);

  return (
    <div class="ds-gm-toolbar" role="toolbar" aria-label={t('gm.toolbar')} data-testid="gm-toolbar">
      <div class="ds-cluster">
        <label class="ds-field-label" for="gm-lighting">{t('gm.lighting')}</label>
        <select
          id="gm-lighting"
          class="ds-input"
          data-testid="gm-lighting"
          value={table?.ambient_lighting ?? 'DAYLIGHT'}
          onChange={(e) => client.submitCommand(setAmbientLighting((e.target as HTMLSelectElement).value as AmbientLightingPreset))}
        >
          {AMBIENT_LIGHTING_PRESETS.map((preset) => (
            <option key={preset} value={preset}>{t(`gm.lighting.${preset}` as MessageKey)}</option>
          ))}
        </select>
        <button type="button" class="ds-btn ds-btn-secondary" data-testid="gm-undo" onClick={() => client.submitCommand(undoLastAction())}>
          {t('gm.undo')}
        </button>
      </div>
      {proposals.length > 0 ? (
        <section class="ds-stack-sm" aria-label={t('gm.mcp.title')} data-testid="gm-mcp-proposals">
          <h3 class="ds-section-title">{t('gm.mcp.title')}</h3>
          <ul class="ds-list-plain ds-stack-sm">
            {proposals.map((proposal) => (
              <li key={proposal.proposal_id} class="ds-panel ds-stack-sm" data-testid={`mcp-proposal-${proposal.proposal_id}`}>
                <p class="ds-value">{proposal.summary}</p>
                <p class="ds-meta">
                  {t('gm.mcp.commands', {
                    count: proposal.commands.length,
                    list: proposal.commands.map((cmd) => String(cmd.cmd ?? '?')).join(', '),
                  })}
                </p>
                <div class="ds-cluster">
                  <button
                    type="button"
                    class="ds-btn ds-btn-primary"
                    data-testid={`mcp-commit-${proposal.proposal_id}`}
                    onClick={() => client.submitCommand(commitMcpStaging(proposal.proposal_id))}
                  >
                    {t('gm.mcp.commitAll')}
                  </button>
                  <button
                    type="button"
                    class="ds-btn ds-btn-danger"
                    data-testid={`mcp-reject-${proposal.proposal_id}`}
                    onClick={() => client.submitCommand(rejectMcpStaging(proposal.proposal_id))}
                  >
                    {t('gm.mcp.reject')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
