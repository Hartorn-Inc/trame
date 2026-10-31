import { h, type VNode } from 'preact';
import { useSafeState } from '../safeHooks.ts';
import { TrameCommand } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';
import { CompendiumDragDropManager } from '../../compendium/CompendiumDragDropManager.ts';

function resolveSlotsBasePath(bindingPath: string | undefined): string {
  if (!bindingPath || typeof bindingPath !== 'string') {
    return 'spellSlots';
  }
  return bindingPath.startsWith('sheet.') ? bindingPath.slice(6) : bindingPath;
}

export function SpellbookAccordionWidget(props: WidgetProps): VNode<any> {
  const rawSlots = (props.boundValues?.slots as Record<string, any>) ?? (props.boundValues?.spellSlots as Record<string, any>) ?? {};
  const rawPactMagic = (props.boundValues?.pactMagic as Record<string, any>) ?? rawSlots.pact ?? rawSlots.pactMagic ?? {};
  const rawSpells = Array.isArray(props.boundValues?.spells) ? props.boundValues.spells : [];
  const autoDeductSlots = props.options?.autoDeductSlots !== false;
  const slotsBasePath = resolveSlotsBasePath(props.bindings?.slots);
  const pactBasePath = resolveSlotsBasePath(props.bindings?.pactMagic ?? 'pactMagic');

  const spells = rawSpells.map((s: any) => ({
    id: String(s.id ?? ''),
    name: String(s.name ?? 'Spell'),
    level: Number(s.level ?? 0),
    isPact: Boolean(s.isPact || s.pactMagic),
    isAoE: Boolean(s.requiresAoE || s.isAoE || s.aoeTemplate),
    aoeTemplate: s.aoeTemplate ?? (s.requiresAoE ? { shape: 'circle', radiusFeet: 20 } : undefined),
  }));

  const handleCast = (spell: (typeof spells)[0]) => {
    if (spell.isAoE) {
      if (!props.isTableCanvasMounted) {
        props.dispatchCommand?.({
          cmd: 'NOTIFICATION',
          type: 'warning',
          message: 'TableCanvas is not mounted; unable to project AoE template.',
        });
        return;
      }
      props.dispatchCommand?.(
        TrameCommand.ProjectAoE({
          spellId: spell.id,
          name: spell.name,
          level: spell.level,
          aoeShape: spell.aoeTemplate,
          template: spell.aoeTemplate,
        }),
      );
      props.onCloseDrawer?.();
    } else {
      props.dispatchCommand?.(
        TrameCommand.RollDice({
          formula: '1d20',
          expression: '1d20',
          spellId: spell.id,
          name: spell.name,
          visibility: 'PUBLIC',
          reason: `Cast spell: ${spell.name}`,
        }),
      );
    }

    if (autoDeductSlots && spell.level > 0) {
      const slotKey = `level${spell.level}`;
      const currentSlot = rawSlots[slotKey]?.current ?? 1;
      const nextVal = Math.max(0, currentSlot - 1);
      props.dispatchCommand?.(
        TrameCommand.UpdateActorSheet({
          path: `${slotsBasePath}.${slotKey}.current`,
          slotLevel: spell.level,
          current: nextVal,
          value: nextVal,
          delta: -1,
        }),
      );
    }
  };

  const [expandedLevels, setExpandedLevels] = useSafeState<number[]>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const dragManager = new CompendiumDragDropManager({
    systemId: 'dnd5e',
    dispatchCommand: props.dispatchCommand,
    actorId: props.actorId,
  });

  const toggleLevel = (lvl: number) => {
    setExpandedLevels((prev) => (prev.includes(lvl) ? prev.filter((l) => l !== lvl) : [...prev, lvl]));
  };

  const handleToggleSlotPip = (slotKey: string, lvl: number, currentVal: number, idx: number) => {
    const isFilled = idx < currentVal;
    const nextVal = isFilled ? idx : idx + 1;
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: `${slotsBasePath}.${slotKey}.current`,
        slotLevel: lvl,
        current: nextVal,
        value: nextVal,
      }),
    );
  };

  const handleTogglePactPip = (currentVal: number, idx: number) => {
    const isFilled = idx < currentVal;
    const nextVal = isFilled ? idx : idx + 1;
    props.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: `${pactBasePath}.current`,
        slotType: 'pactMagic',
        current: nextVal,
        value: nextVal,
      }),
    );
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    const payload = dragManager.parseDragEvent(e);
    if (!payload) return;
    const entryType = String(payload.entryType ?? payload.type ?? '').toLowerCase();
    if (entryType === 'spell' || entryType === 'spells') {
      dragManager.handleDrop(payload, null, props.actorId);
    }
  };

  const spellsByLevel = new Map<number, typeof spells>();
  for (let lvl = 0; lvl <= 9; lvl++) {
    spellsByLevel.set(lvl, []);
  }
  for (const spell of spells) {
    const list = spellsByLevel.get(spell.level) ?? [];
    list.push(spell);
    spellsByLevel.set(spell.level, list);
  }

  const pactMax = Number(rawPactMagic?.max ?? 0);
  const pactCurrent = Number(rawPactMagic?.current ?? pactMax);
  const pactLevel = Number(rawPactMagic?.slotLevel ?? rawPactMagic?.level ?? 1);
  const rawSpellSaveDc = props.boundValues?.spellSaveDc ?? (props.boundValues?.attributes as any)?.spellSaveDc;
  const rawSpellAttackBonus = props.boundValues?.spellAttackBonus ?? (props.boundValues?.attributes as any)?.spellAttackBonus;
  const spellSaveDc = typeof rawSpellSaveDc === 'number' ? rawSpellSaveDc : Number(rawSpellSaveDc ?? 10);
  const spellAttackBonus = typeof rawSpellAttackBonus === 'number' ? rawSpellAttackBonus : Number(rawSpellAttackBonus ?? 0);
  const formattedSpellAttack = spellAttackBonus >= 0 ? `+${spellAttackBonus}` : `${spellAttackBonus}`;

  return h(
    'div',
    {
      class: 'ds-spellbook-widget',
      'data-testid': 'spellbook-accordion-widget',
      onDragOver: (e: DragEvent) => e.preventDefault(),
      onDrop: handleDrop,
    },
    h('h4', { class: 'ds-widget-title' }, 'Spellbook & Spell Slots'),
    h(
      'div',
      { class: 'ds-spellcasting-metrics atlas-tabular-nums', 'data-testid': 'spellcasting-metrics' },
      h(
        'span',
        { class: 'ds-spell-save-dc atlas-tabular-nums', 'data-testid': 'spell-save-dc-badge' },
        `Spell Save DC: ${spellSaveDc}`,
      ),
      h(
        'span',
        { class: 'ds-spell-attack-bonus atlas-tabular-nums', 'data-testid': 'spell-attack-bonus-badge' },
        ` | Spell Attack Bonus: ${formattedSpellAttack}`,
      ),
    ),
    h(
      'div',
      { class: 'ds-pact-magic-section', 'data-testid': 'pact-magic-section' },
      h(
        'span',
        { class: 'ds-pact-magic-label atlas-tabular-nums' },
        `Pact Magic (Slot Lvl ${pactLevel}): ${pactCurrent}/${pactMax}`,
      ),
      pactMax > 0
        ? h(
            'div',
            { class: 'ds-slot-pips-container atlas-tabular-nums', 'data-testid': 'slot-pips-pact' },
            Array.from({ length: pactMax }, (_, idx) => {
              const isFilled = idx < pactCurrent;
              return h(
                'button',
                {
                  key: `pact-pip-${idx}`,
                  type: 'button',
                  class: `ds-slot-pip atlas-tabular-nums ${isFilled ? 'is-filled' : 'is-expended'}`,
                  'data-testid': `slot-pip-pact-${idx}`,
                  'aria-label': `Toggle Pact Magic spell slot ${idx + 1}, currently ${isFilled ? 'available' : 'expended'}`,
                  'aria-pressed': isFilled ? 'true' : 'false',
                  onClick: (e: Event) => {
                    e.stopPropagation();
                    handleTogglePactPip(pactCurrent, idx);
                  },
                },
                isFilled ? '[*]' : '[ ]',
              );
            }),
          )
        : null,
    ),
    h(
      'div',
      { class: 'ds-spell-levels-accordion' },
      Array.from({ length: 10 }, (_, lvl) => {
        const levelSpells = spellsByLevel.get(lvl) ?? [];
        const isExpanded = expandedLevels.includes(lvl);
        const slotKey = `level${lvl}`;
        const slotData = rawSlots[slotKey] ?? rawSlots[`slot_${lvl}`];
        const maxSlots = Number(slotData?.max ?? 0);
        const currentSlots = Number(slotData?.current ?? maxSlots);

        return h(
          'div',
          { key: `lvl-${lvl}`, class: 'ds-spell-level-group', 'data-testid': `spell-level-group-${lvl}` },
          h(
            'div',
            { class: 'ds-spell-level-header-row' },
            h(
              'button',
              {
                type: 'button',
                class: 'ds-spell-level-header',
                'data-testid': `spell-level-header-${lvl}`,
                'aria-expanded': isExpanded ? 'true' : 'false',
                'aria-controls': `spell-level-body-${lvl}`,
                onClick: () => toggleLevel(lvl),
              },
              h('span', { class: 'ds-level-title' }, lvl === 0 ? 'Cantrips' : `Level ${lvl}`),
            ),
            lvl > 0 && maxSlots > 0
              ? h(
                  'div',
                  { class: 'ds-slot-pips-container atlas-tabular-nums', 'data-testid': `slot-pips-lvl-${lvl}` },
                  Array.from({ length: maxSlots }, (_, idx) => {
                    const isFilled = idx < currentSlots;
                    return h(
                      'button',
                      {
                        key: `pip-${idx}`,
                        type: 'button',
                        class: `ds-slot-pip atlas-tabular-nums ${isFilled ? 'is-filled' : 'is-expended'}`,
                        'data-testid': `slot-pip-${lvl}-${idx}`,
                        'aria-label': `Toggle level ${lvl} spell slot ${idx + 1}, currently ${isFilled ? 'available' : 'expended'}`,
                        'aria-pressed': isFilled ? 'true' : 'false',
                        onClick: (e: Event) => {
                          e.stopPropagation();
                          handleToggleSlotPip(slotKey, lvl, currentSlots, idx);
                        },
                      },
                      isFilled ? '[*]' : '[ ]',
                    );
                  }),
                )
              : null,
          ),
          isExpanded
            ? h(
                'div',
                { id: `spell-level-body-${lvl}`, class: 'ds-spell-level-body' },
                levelSpells.length === 0
                  ? h('span', { class: 'ds-no-spells' }, 'No spells learned')
                  : levelSpells.map((spell) =>
                      h(
                        'div',
                        { key: spell.id, class: 'ds-spell-item', 'data-testid': `spell-item-${spell.id}` },
                        h('span', { class: 'ds-spell-title atlas-tabular-nums' }, `${spell.name} (Lvl ${spell.level})`),
                        h(
                          'button',
                          {
                            type: 'button',
                            class: 'ds-btn-cast-spell',
                            'data-testid': `btn-cast-spell-${spell.id}`,
                            'aria-label': spell.isAoE ? `Cast ${spell.name} and project AoE` : `Cast ${spell.name}`,
                            onClick: () => handleCast(spell),
                          },
                          spell.isAoE ? 'Cast / Project AoE' : 'Cast',
                        ),
                      ),
                    ),
              )
            : null,
        );
      }),
    ),
  );
}
