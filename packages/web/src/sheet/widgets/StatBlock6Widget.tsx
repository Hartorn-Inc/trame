import { h, type VNode } from 'preact';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

const DEFAULT_ORDER = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

export function StatBlock6Widget(props: WidgetProps): VNode<any> {
  const displayOrder = (props.options?.displayOrder as string[]) ?? DEFAULT_ORDER;
  const rawAbilities = (props.boundValues?.abilities as Record<string, any>) ?? {};
  const isLocked = props.isLocked !== false;

  const handleAbilityClick = (abilityKey: string, mod: number) => {
    if (!isLocked) return;
    const sign = mod >= 0 ? `+ ${mod}` : `- ${Math.abs(mod)}`;
    const formula = `1d20 ${sign}`;
    const expression = mod >= 0 ? `1d20+${mod}` : `1d20${mod}`;
    props.dispatchCommand?.(
      TrameCommand.RollDice({
        formula,
        expression,
        ability: abilityKey,
        modifier: mod,
        visibility: 'PUBLIC',
        reason: `Ability check: ${abilityKey}`,
      }),
    );
  };

  const handleScoreChange = (abilityKey: string, currentScore: number, delta: number) => {
    const newScore = Math.max(1, Math.min(30, currentScore + delta));
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: `abilities.${abilityKey}.score`,
        score: newScore,
        value: newScore,
        ability: abilityKey,
      }),
    );
  };

  return h(
    'div',
    { class: 'ds-statblock-6', 'data-testid': 'statblock-6-widget', 'data-locked': String(isLocked) },
    h(
      'div',
      { class: 'ds-statblock-grid' },
      displayOrder.map((key) => {
        const raw = rawAbilities[key];
        let score = 10;
        let mod = 0;
        if (typeof raw === 'number') {
          score = raw;
          mod = Math.floor((score - 10) / 2);
        } else if (raw && typeof raw === 'object') {
          score = typeof raw.score === 'number' ? raw.score : 10;
          mod = typeof raw.modifier === 'number' ? raw.modifier : Math.floor((score - 10) / 2);
        }
        const modDisplay = mod >= 0 ? `+${mod}` : `${mod}`;

        return h(
          'div',
          {
            key,
            class: `ds-ability-card ${isLocked ? 'is-rollable' : 'is-editable'}`,
            'data-testid': `ability-card-${key}`,
            role: isLocked ? 'button' : undefined,
            tabIndex: isLocked ? 0 : undefined,
            'aria-label': isLocked ? `Roll ${key.toUpperCase()} check (${modDisplay}, score ${score})` : undefined,
            onClick: () => isLocked && handleAbilityClick(key, mod),
            onKeyDown: isLocked
              ? (e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleAbilityClick(key, mod);
                  }
                }
              : undefined,
          },
          h('span', { class: 'ds-ability-name' }, key.toUpperCase()),
          h('span', { class: 'ds-ability-mod', 'data-testid': `ability-mod-${key}` }, modDisplay),
          isLocked
            ? h('span', { class: 'ds-ability-score', 'data-testid': `ability-score-${key}` }, score)
            : h(
                'div',
                { class: 'ds-ability-stepper', 'data-testid': `ability-stepper-${key}` },
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'ds-stepper-btn ds-stepper-dec',
                    'data-testid': `ability-dec-${key}`,
                    'aria-label': `Decrease ${key.toUpperCase()} score`,
                    onClick: (e: Event) => {
                      e.stopPropagation();
                      handleScoreChange(key, score, -1);
                    },
                  },
                  '-',
                ),
                h('span', { class: 'ds-ability-score-val' }, score),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'ds-stepper-btn ds-stepper-inc',
                    'data-testid': `ability-inc-${key}`,
                    'aria-label': `Increase ${key.toUpperCase()} score`,
                    onClick: (e: Event) => {
                      e.stopPropagation();
                      handleScoreChange(key, score, 1);
                    },
                  },
                  '+',
                ),
              ),
        );
      }),
    ),
  );
}
