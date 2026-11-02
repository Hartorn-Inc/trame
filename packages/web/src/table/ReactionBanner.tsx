/**
 * ============================================================================
 * REACTION PROMPT BANNER (table/ReactionBanner.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Surfaces the engine's open reaction prompts (e.g. an opportunity attack
 * when a token leaves a reactor's reach in line of sight) to whoever must
 * decide them, with `[ Use reaction ]` / `[ Pass ]`, then `[ Resolve ]` once
 * a triggered reaction has been played out.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Projection-Driven`:
 *    - Prompts are read from `active_reaction_prompts` in every snapshot, so a
 *      prompt that `UNDO_LAST_ACTION` re-opens reappears and one it withdraws
 *      disappears without client bookkeeping.
 * 2. `No Timers (G2)`:
 *    - Prompts stay until decided, resolved, or closed by the engine.
 * 3. `Undo Is Announced`:
 *    - A `REACTION_PROMPT_CLOSED` with reason `UNDONE` is announced in a
 *      polite live region so the decider knows why the prompt vanished.
 * ============================================================================
 */
import type { ApiClient } from '../api/client.ts';
import { t } from '../i18n/index.ts';
import { decideReaction, resolveReaction } from './commands.ts';
import { listTableTokens, promptsForUser } from './tableView.ts';

export interface ReactionBannerProps {
  client: ApiClient;
  isGm: boolean;
}

export function ReactionBanner({ client, isGm }: ReactionBannerProps) {
  const table = client.state.table.value;
  const prompts = promptsForUser(table, client.state.user.value?.id ?? null, isGm);
  const names = new Map(listTableTokens(table).map((tok) => [tok.id, tok.name]));
  const closed = client.state.lastClosedPrompt.value;
  const undone = closed?.reason === 'UNDONE' && !prompts.some((p) => p.prompt_id === closed.promptId);

  return (
    <div class="ds-stack-sm" data-testid="reaction-banner">
      <p role="status" class="ds-meta" data-testid="reaction-undone">
        {undone ? t('reaction.undone') : ''}
      </p>
      {prompts.map((prompt) => {
        const reactor = names.get(prompt.reactor_actor_id) ?? '';
        const trigger = names.get(prompt.trigger_token_id) ?? '';
        return (
          <section
            key={prompt.prompt_id}
            class="ds-panel ds-reaction-prompt ds-stack-sm"
            role="alertdialog"
            aria-label={t('reaction.title')}
            data-testid={`reaction-${prompt.prompt_id}`}
          >
            <p class="ds-value">{t('reaction.opportunity', { reactor, trigger })}</p>
            {prompt.awaiting_resolution ? (
              <button
                type="button"
                class="ds-btn ds-btn-primary"
                data-testid={`reaction-resolve-${prompt.prompt_id}`}
                onClick={() => client.submitCommand(resolveReaction(prompt.prompt_id))}
              >
                {t('reaction.resolve')}
              </button>
            ) : (
              <div class="ds-cluster">
                <button
                  type="button"
                  class="ds-btn ds-btn-primary"
                  data-testid={`reaction-trigger-${prompt.prompt_id}`}
                  onClick={() => client.submitCommand(decideReaction(prompt.prompt_id, prompt.reactor_actor_id, true))}
                >
                  {t('reaction.trigger')}
                </button>
                <button
                  type="button"
                  class="ds-btn ds-btn-secondary"
                  data-testid={`reaction-pass-${prompt.prompt_id}`}
                  onClick={() => client.submitCommand(decideReaction(prompt.prompt_id, prompt.reactor_actor_id, false))}
                >
                  {t('reaction.pass')}
                </button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
