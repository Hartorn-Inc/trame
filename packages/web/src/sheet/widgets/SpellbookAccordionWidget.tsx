/**
 * ============================================================================
 * SPELLBOOK & SPELL SLOTS WIDGET (sheet/widgets/SpellbookAccordionWidget.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Lists the actor's spells by level with their slots (`derived.spells`, the
 * `DerivedSpellcasting` summary: class cantrips, prepared spells, feat spells,
 * slots per level and Warlock Pact Magic) and casts them. Without the slot
 * spend on cast, a level-1 Wizard or Warlock could cast forever.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `One Slot Per Leveled Cast`:
 *    - `pickCastSlot` spends the slot picked in the spell's slot level
 *      selector (shown when more than one slot can cast it), else the lowest
 *      one left: the spell's own level, then the next level up or a Pact
 *      Magic slot at or above it. The cast carries the slot's level so the
 *      table scales the damage (upcasting). With no slot left the cast
 *      button is disabled and its label says why. Cantrips never spend a
 *      slot.
 * 2. `Whole Tier Written`:
 *    - Slot changes write the full `{ current, max }` tier at
 *      `spellSlots.<key>`, so a sheet that never tracked a tier stores a valid
 *      one instead of a lone `current`.
 * 3. `Table Flows Need The Table`:
 *    - `CAST_SPELL` carries `onTable`; the sheet dispatcher opens the attack,
 *      save or area resolution only then. An area spell cast away from the
 *      table spends nothing and shows a notice instead.
 * ============================================================================
 */
import { h, type VNode } from 'preact';
import { CompendiumResolver } from '../../../../game-systems/dnd5e/src/index.ts';
import { t } from '../../i18n/index.ts';
import { useSafeState } from '../safeHooks.ts';
import { TrameCommand, type SpentSlot } from '../types.ts';
import type { WidgetProps } from '../WidgetRegistry.ts';
import { CompendiumDragDropManager } from '../../compendium/CompendiumDragDropManager.ts';

/** Slot tier as shown on the sheet. */
export interface SlotTierView {
  current: number;
  max: number;
  /** Casting level of Pact Magic slots. */
  slotLevel?: number;
}

/** Spell row of the widget. */
interface SpellView {
  id: string;
  name: string;
  level: number;
  isAoE: boolean;
}

function slotsBasePath(bindingPath: string | undefined): string {
  if (!bindingPath) return 'spellSlots';
  return bindingPath.startsWith('sheet.') ? bindingPath.slice(6) : bindingPath;
}

function record(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

/** A slot a leveled spell can be cast with: its `spellSlots` key and the level it casts at. */
export interface CastSlotOption {
  /** `"level1"`..`"level9"` or `"pact"`. */
  key: string;
  /** Level the spell is cast at with this slot (1..9). */
  castLevel: number;
}

/**
 * Slots with uses left that can cast a level-`level` spell (invariant 1),
 * lowest cast level first; at equal level a regular slot comes before Pact
 * Magic.
 */
export function castSlotOptions(
  level: number,
  slots: Readonly<Record<string, SlotTierView>>,
  pact: SlotTierView | null,
): CastSlotOption[] {
  const options: CastSlotOption[] = [];
  for (let castLevel = level; castLevel <= 9; castLevel++) {
    if ((slots[`level${castLevel}`]?.current ?? 0) > 0) options.push({ key: `level${castLevel}`, castLevel });
  }
  const pactLevel = pact?.slotLevel ?? 1;
  if (pact && pact.current > 0 && pactLevel >= level) options.push({ key: 'pact', castLevel: pactLevel });
  return options.sort((a, b) => a.castLevel - b.castLevel);
}

/**
 * Slot a cast of a level-`level` spell spends (invariant 1): `preferredKey`
 * when it still has a use, else the lowest available option (the spell's own
 * level, then the next level up or Pact Magic); `null` when none is left.
 */
export function pickCastSlot(
  level: number,
  slots: Readonly<Record<string, SlotTierView>>,
  pact: SlotTierView | null,
  preferredKey?: string,
): SpentSlot | null {
  const options = castSlotOptions(level, slots, pact);
  const option = options.find((o) => o.key === preferredKey) ?? options[0];
  if (!option) return null;
  if (option.key === 'pact' && pact) {
    return { key: 'pact', tier: { current: pact.current - 1, max: pact.max, slotLevel: option.castLevel }, castLevel: option.castLevel };
  }
  const tier = slots[option.key];
  return { key: option.key, tier: { current: tier.current - 1, max: tier.max }, castLevel: option.castLevel };
}

/** Slots and spells from `derived.spells` (`DerivedSpellcasting`) or the legacy list binding. */
function readSpellbook(boundValues: Record<string, unknown>) {
  const casting = record(boundValues.spells);
  const stored = record(boundValues.slots) ?? record(boundValues.spellSlots) ?? {};
  const slots: Record<string, SlotTierView> = {};
  let pact: SlotTierView | null = null;
  let rawSpells: any[] = Array.isArray(boundValues.spells) ? (boundValues.spells as any[]) : [];
  if (casting) {
    for (const slot of (casting.slots ?? []) as Array<{ level: number; max: number; current: number }>) {
      slots[`level${slot.level}`] = { current: slot.current, max: slot.max };
    }
    const pm = record(casting.pactMagic);
    if (pm && Number(pm.slots) > 0) pact = { current: Number(pm.current), max: Number(pm.slots), slotLevel: Number(pm.slotLevel ?? 1) };
    const feat = ((casting.featSpells ?? []) as Array<{ spells: any[] }>).flatMap((f) => f.spells ?? []);
    rawSpells = [...(casting.cantrips ?? []), ...(casting.prepared ?? []), ...feat];
  } else {
    for (const [key, tier] of Object.entries(stored)) {
      const rec = record(tier);
      if (!rec || !/^level\d$/.test(key)) continue;
      const max = Number(rec.max ?? 0);
      slots[key] = { max, current: Number(rec.current ?? max) };
    }
    const pm = record(boundValues.pactMagic) ?? record(stored.pact);
    const max = Number(pm?.max ?? 0);
    if (pm && max > 0) pact = { max, current: Number(pm.current ?? max), slotLevel: Number(pm.slotLevel ?? pm.level ?? 1) };
  }
  const resolver = CompendiumResolver.getDefault();
  const seen = new Set<string>();
  const spells: SpellView[] = [];
  for (const s of rawSpells) {
    const id = String(s?.id ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry = resolver.get(id);
    spells.push({
      id,
      name: String(s.name ?? entry?.name ?? id),
      level: Number(s.level ?? entry?.data.level ?? 0),
      isAoE: Boolean(s.requiresAoE || s.isAoE || s.aoeTemplate || entry?.data.area),
    });
  }
  return { slots, pact, spells };
}

export function SpellbookAccordionWidget(props: WidgetProps): VNode<any> {
  const boundValues = props.boundValues ?? {};
  const { slots, pact, spells } = readSpellbook(boundValues);
  const autoDeductSlots = props.options?.autoDeductSlots !== false;
  const basePath = slotsBasePath(props.bindings?.slots);
  const onTable = props.isTableCanvasMounted === true;

  const writeTier = (key: string, tier: SlotTierView) => {
    props.dispatchCommand?.(TrameCommand.UpdateActorSheet({ path: `${basePath}.${key}`, value: tier }));
  };

  const [slotChoice, setSlotChoice] = useSafeState<Record<string, string>>({});
  const castSlot = (spell: SpellView) =>
    spell.level > 0 && autoDeductSlots ? pickCastSlot(spell.level, slots, pact, slotChoice[spell.id]) : null;

  const handleCast = (spell: SpellView) => {
    if (spell.isAoE && !onTable) {
      props.dispatchCommand?.({ cmd: 'NOTIFICATION', type: 'warning', message: t('sheet.spells.canvasNotMounted') });
      return;
    }
    const slot = castSlot(spell);
    if (spell.level > 0 && autoDeductSlots && !slot) return;
    props.dispatchCommand?.(TrameCommand.CastSpell({ spellId: spell.id, slot, onTable }));
    if (onTable) props.onCloseDrawer?.();
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

  /** Clicking an available pip expends it; clicking an expended pip restores up to it. */
  const pipValue = (current: number, idx: number) => (idx < current ? idx : idx + 1);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    const payload = dragManager.parseDragEvent(e);
    if (!payload) return;
    const entryType = String(payload.entryType ?? payload.type ?? '').toLowerCase();
    if (entryType === 'spell' || entryType === 'spells') {
      dragManager.handleDrop(payload, null, props.actorId);
    }
  };

  const rawSpellSaveDc = boundValues.spellSaveDc ?? (boundValues.attributes as any)?.spellSaveDc;
  const rawSpellAttackBonus = boundValues.spellAttackBonus ?? (boundValues.attributes as any)?.spellAttackBonus;
  const spellSaveDc = Number(rawSpellSaveDc ?? 10);
  const spellAttackBonus = Number(rawSpellAttackBonus ?? 0);
  const formattedSpellAttack = spellAttackBonus >= 0 ? `+${spellAttackBonus}` : `${spellAttackBonus}`;

  const levels = Array.from({ length: 10 }, (_, lvl) => lvl).filter(
    (lvl) => lvl === 0 || spells.some((s) => s.level === lvl) || (slots[`level${lvl}`]?.max ?? 0) > 0,
  );

  const pip = (testId: string, filled: boolean, label: string, onClick: () => void) =>
    h(
      'button',
      {
        key: testId,
        type: 'button',
        class: `ds-slot-pip atlas-tabular-nums ${filled ? 'is-filled' : 'is-expended'}`,
        'data-testid': testId,
        'aria-label': label,
        'aria-pressed': filled ? 'true' : 'false',
        onClick: (e: Event) => {
          e.stopPropagation();
          onClick();
        },
      },
      filled ? '[*]' : '[ ]',
    );

  const slotPicker = (spell: SpellView, slot: SpentSlot | null) => {
    const options = spell.level > 0 && autoDeductSlots ? castSlotOptions(spell.level, slots, pact) : [];
    if (options.length < 2 || !slot) return null;
    const id = `spell-slot-${spell.id}`;
    return h(
      'span',
      { class: 'ds-field' },
      h('label', { for: id, class: 'ds-field-label' }, t('sheet.spells.slotLevel')),
      h(
        'select',
        {
          id,
          class: 'ds-input ds-input-compact atlas-tabular-nums',
          'data-testid': id,
          value: slot.key,
          onChange: (e: Event) => setSlotChoice((prev) => ({ ...prev, [spell.id]: (e.target as HTMLSelectElement).value })),
        },
        options.map((o) =>
          h(
            'option',
            { key: o.key, value: o.key },
            t(o.key === 'pact' ? 'sheet.spells.slotOptionPact' : 'sheet.spells.slotOption', { level: o.castLevel }),
          ),
        ),
      ),
    );
  };

  const castButton = (spell: SpellView, slot: SpentSlot | null) => {
    const noSlot = spell.level > 0 && autoDeductSlots && !slot;
    const castAria = t(spell.isAoE ? 'sheet.spells.castAoeAria' : 'sheet.spells.castAria', { name: spell.name });
    const upcast = slot && slot.castLevel > spell.level ? t('sheet.spells.castAtLevelAria', { aria: castAria, level: slot.castLevel }) : castAria;
    return h(
      'button',
      {
        type: 'button',
        class: 'ds-btn ds-btn-secondary ds-btn-sm ds-btn-cast-spell',
        'data-testid': `btn-cast-spell-${spell.id}`,
        'aria-label': noSlot ? t('sheet.spells.noSlotAria', { name: spell.name, level: spell.level }) : upcast,
        disabled: noSlot,
        onClick: () => handleCast(spell),
      },
      noSlot ? t('sheet.spells.noSlot') : t(spell.isAoE ? 'sheet.spells.castAoe' : 'sheet.spells.cast'),
    );
  };

  return h(
    'div',
    {
      class: 'ds-spellbook-widget',
      'data-testid': 'spellbook-accordion-widget',
      onDragOver: (e: DragEvent) => e.preventDefault(),
      onDrop: handleDrop,
    },
    h('h4', { class: 'ds-widget-title' }, t('sheet.spells.title')),
    h(
      'div',
      { class: 'ds-spellcasting-metrics atlas-tabular-nums', 'data-testid': 'spellcasting-metrics' },
      h('span', { class: 'ds-spell-save-dc atlas-tabular-nums', 'data-testid': 'spell-save-dc-badge' }, t('sheet.spells.saveDc', { value: spellSaveDc })),
      h(
        'span',
        { class: 'ds-spell-attack-bonus atlas-tabular-nums', 'data-testid': 'spell-attack-bonus-badge' },
        t('sheet.spells.attackBonus', { value: formattedSpellAttack }),
      ),
    ),
    pact
      ? h(
          'div',
          { class: 'ds-pact-magic-section', 'data-testid': 'pact-magic-section' },
          h(
            'span',
            { class: 'ds-pact-magic-label atlas-tabular-nums', 'data-testid': 'pact-magic-label' },
            t('sheet.spells.pactMagic', { level: pact.slotLevel ?? 1, current: pact.current, max: pact.max }),
          ),
          h(
            'div',
            { class: 'ds-slot-pips-container atlas-tabular-nums', 'data-testid': 'slot-pips-pact' },
            Array.from({ length: pact.max }, (_, idx) =>
              pip(
                `slot-pip-pact-${idx}`,
                idx < pact.current,
                t('sheet.spells.pactPipAria', { index: idx + 1, state: t(idx < pact.current ? 'sheet.slot.available' : 'sheet.slot.expended') }),
                () => writeTier('pact', { current: pipValue(pact.current, idx), max: pact.max, slotLevel: pact.slotLevel ?? 1 }),
              ),
            ),
          ),
        )
      : null,
    h(
      'div',
      { class: 'ds-spell-levels-accordion' },
      levels.map((lvl) => {
        const levelSpells = spells.filter((s) => s.level === lvl);
        const isExpanded = expandedLevels.includes(lvl);
        const slotKey = `level${lvl}`;
        const tier = slots[slotKey];
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
              h('span', { class: 'ds-level-title' }, lvl === 0 ? t('sheet.spells.cantrips') : t('sheet.spells.level', { level: lvl })),
            ),
            lvl > 0 && tier && tier.max > 0
              ? h(
                  'div',
                  { class: 'ds-slot-pips-container atlas-tabular-nums', 'data-testid': `slot-pips-lvl-${lvl}` },
                  h('span', { class: 'ds-meta', 'data-testid': `slot-count-${lvl}` }, t('sheet.spells.slotCount', { current: tier.current, max: tier.max })),
                  Array.from({ length: tier.max }, (_, idx) =>
                    pip(
                      `slot-pip-${lvl}-${idx}`,
                      idx < tier.current,
                      t('sheet.spells.slotPipAria', { level: lvl, index: idx + 1, state: t(idx < tier.current ? 'sheet.slot.available' : 'sheet.slot.expended') }),
                      () => writeTier(slotKey, { current: pipValue(tier.current, idx), max: tier.max }),
                    ),
                  ),
                )
              : null,
          ),
          isExpanded
            ? h(
                'div',
                { id: `spell-level-body-${lvl}`, class: 'ds-spell-level-body' },
                levelSpells.length === 0
                  ? h('span', { class: 'ds-no-spells' }, t('sheet.spells.none'))
                  : levelSpells.map((spell) => {
                      const slot = castSlot(spell);
                      return h(
                        'div',
                        { key: spell.id, class: 'ds-spell-item', 'data-testid': `spell-item-${spell.id}` },
                        h('span', { class: 'ds-spell-title atlas-tabular-nums' }, t('sheet.spells.itemTitle', { name: spell.name, level: spell.level })),
                        slotPicker(spell, slot),
                        castButton(spell, slot),
                      );
                    }),
              )
            : null,
        );
      }),
    ),
  );
}
