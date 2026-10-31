import { h, type VNode } from 'preact';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

export function SkillCheckListWidget(props: WidgetProps): VNode<any> {
  const rawSkills = (props.boundValues?.skills as Record<string, any>) ?? {};
  const isLocked = props.isLocked !== false;

  const sortedSkills = Object.entries(rawSkills).sort(([a], [b]) => a.localeCompare(b));

  const handleSkillClick = (key: string, mod: number) => {
    if (!isLocked) return;
    const sign = mod >= 0 ? `+ ${mod}` : `- ${Math.abs(mod)}`;
    const formula = `1d20 ${sign}`;
    const expression = mod >= 0 ? `1d20+${mod}` : `1d20${mod}`;
    props.dispatchCommand?.(
      TrameCommand.RollDice({
        formula,
        expression,
        skill: key,
        modifier: mod,
        visibility: 'PUBLIC',
        reason: `Skill check: ${key}`,
      }),
    );
  };

  const handleKeyDown = (e: KeyboardEvent, key: string, mod: number) => {
    if (isLocked && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      handleSkillClick(key, mod);
    }
  };

  const handleCycleRank = (key: string, currentRank: number) => {
    const nextRank = (currentRank + 1) % 3;
    const rankLabels = ['none', 'proficient', 'expertise'];
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: `skills.${key}.proficiencyRank`,
        skill: key,
        rank: nextRank,
        proficiencyLevel: rankLabels[nextRank],
        value: nextRank,
      }),
    );
  };

  return h(
    'div',
    { class: 'ds-skills-widget', 'data-testid': 'skill-check-list-widget', 'data-locked': String(isLocked) },
    h('h4', { class: 'ds-widget-title' }, 'Skills'),
    h(
      'ul',
      { class: 'ds-skills-list' },
      sortedSkills.map(([key, val]) => {
        let mod = 0;
        let rank = 0;
        let passive = 10;
        if (typeof val === 'number') {
          mod = val;
          passive = 10 + mod;
        } else if (val && typeof val === 'object') {
          mod = typeof val.modifier === 'number' ? val.modifier : Number(val.mod ?? 0);
          if (typeof val.proficiencyRank === 'number') rank = val.proficiencyRank;
          else if (val.proficiencyLevel === 'proficient' || val.rank === 1) rank = 1;
          else if (val.proficiencyLevel === 'expertise' || val.rank === 2) rank = 2;
          passive = typeof val.passive === 'number' ? val.passive : 10 + mod;
        }
        const modDisplay = mod >= 0 ? `+${mod}` : `${mod}`;

        return h(
          'li',
          {
            key,
            class: `ds-skill-row ${isLocked ? 'is-rollable' : 'is-editable'}`,
            'data-testid': `skill-row-${key}`,
            role: isLocked ? 'button' : undefined,
            tabIndex: isLocked ? 0 : undefined,
            'aria-label': isLocked ? `Roll ${key} check` : undefined,
            onClick: () => isLocked && handleSkillClick(key, mod),
            onKeyDown: (e: KeyboardEvent) => handleKeyDown(e, key, mod),
          },
          h('button', {
            type: 'button',
            class: `ds-prof-pip rank-${rank}`,
            'data-testid': `skill-prof-cycle-${key}`,
            'data-rank': rank,
            'aria-label': `Cycle proficiency rank for ${key} (currently ${['unproficient', 'proficient', 'expertise'][rank]})`,
            disabled: isLocked,
            onClick: (e: Event) => {
              e.stopPropagation();
              if (!isLocked) handleCycleRank(key, rank);
            },
          }),
          h('span', { class: 'ds-skill-name' }, key),
          h('span', { class: 'ds-skill-passive atlas-tabular-nums', 'data-testid': `skill-passive-${key}` }, `(${passive})`),
          h('span', { class: 'ds-skill-mod atlas-tabular-nums', 'data-testid': `skill-mod-${key}` }, modDisplay),
        );
      }),
    ),
  );
}
