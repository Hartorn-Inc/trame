import { h, type VNode } from 'preact';
import { t, type MessageKey } from '../../i18n/index.ts';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';

const RANK_LABEL_KEYS: readonly MessageKey[] = [
  'sheet.proficiency.none',
  'sheet.proficiency.proficient',
  'sheet.proficiency.expertise',
];

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
    h('h4', { class: 'ds-widget-title' }, t('sheet.skills.title')),
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
        const rankText = t(RANK_LABEL_KEYS[rank] ?? 'sheet.proficiency.none');
        const rankGlyph = rank === 2 ? '[E]' : rank === 1 ? '[P]' : '[ ]';
        const details = [
          h('span', { class: 'ds-skill-name' }, key),
          h('span', { class: 'ds-skill-passive atlas-tabular-nums', 'data-testid': `skill-passive-${key}` }, `(${passive})`),
          h('span', { class: 'ds-skill-mod atlas-tabular-nums', 'data-testid': `skill-mod-${key}` }, modDisplay),
        ];

        return h(
          'li',
          { key, class: `ds-skill-row ${isLocked ? 'is-rollable' : 'is-editable'}`, 'data-testid': `skill-row-${key}` },
          isLocked
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'ds-skill-roll',
                  'data-testid': `skill-roll-${key}`,
                  'aria-label': t('sheet.skills.rollAria', { skill: key, modifier: modDisplay, rank: rankText, passive }),
                  onClick: () => handleSkillClick(key, mod),
                },
                h('span', { class: `ds-prof-pip rank-${rank}`, 'aria-hidden': 'true' }, rankGlyph),
                ...details,
              )
            : [
                h(
                  'button',
                  {
                    type: 'button',
                    class: `ds-prof-pip rank-${rank}`,
                    'data-testid': `skill-prof-cycle-${key}`,
                    'data-rank': rank,
                    'aria-label': t('sheet.skills.cycleAria', { skill: key, rank: rankText }),
                    onClick: () => handleCycleRank(key, rank),
                  },
                  rankGlyph,
                ),
                ...details,
              ],
        );
      }),
    ),
  );
}
