/**
 * ============================================================================
 * MONSTER STAT BLOCK VIEW (compendium/MonsterStatBlockView.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Renders a complete SRD 5.2.1 `MonsterStatBlock` (AC, HP, speeds, ability
 * scores, saves, skills, senses, affinities, CR, traits, actions, bonus
 * actions, reactions and legendary actions) so the GM reads the real monster
 * before spawning it instead of a name and a type tag (audit UA2).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Read-Only Projection`:
 *    - The view never edits the stat block; the server keeps its own copy
 *      on spawned tokens (`stat_block`), so nothing here can change a
 *      token's numbers.
 * 2. `Verbatim SRD Prose`:
 *    - Names, descriptions, alignment and languages are SRD English text and
 *      carry `lang="en"` inside a possibly French UI; labels are localized.
 * 3. `Plain Text Only`:
 *    - Descriptions render as text nodes (no HTML), so a homebrew stat block
 *      cannot inject markup.
 * 4. `Actions Feed The Resolution Flow`:
 *    - With `onAction` (a monster token on the table), every action with an
 *      attack roll or a saving throw gets a button that starts the same
 *      server-rolled resolution as a sheet attack; prose-only actions
 *      (Multiattack) stay text.
 * ============================================================================
 */
import type { AbilityId, MonsterAction, MonsterStatBlock } from '../../../game-systems/dnd5e/src/index.ts';
import { challengeRatingLabel } from '../../../game-systems/dnd5e/src/index.ts';
import { t, type MessageKey } from '../i18n/index.ts';

const ABILITIES: readonly AbilityId[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

/** `+3`, `+0`, `-1`. */
export function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

/** `true` when `value` has the shape of a `MonsterStatBlock` (name, abilities, actions). */
export function isMonsterStatBlock(value: unknown): value is MonsterStatBlock {
  if (typeof value !== 'object' || value === null) return false;
  const block = value as Partial<MonsterStatBlock>;
  return typeof block.name === 'string' && typeof block.abilities === 'object' && Array.isArray(block.actions);
}

/** Printed speed line: `30 ft., Fly 60 ft. (hover), Swim 30 ft.`. */
function speedLine(speed: MonsterStatBlock['speed']): string {
  const modes = (['fly', 'swim', 'climb', 'burrow'] as const)
    .filter((mode) => (speed[mode] ?? 0) > 0)
    .map((mode) => {
      const hover = mode === 'fly' && speed.hover ? ` ${t('statBlock.hover')}` : '';
      return `${t(`statBlock.speed.${mode}` as MessageKey)} ${speed[mode]} ft.${hover}`;
    });
  return [`${speed.walk} ft.`, ...modes].join(', ');
}

/** Printed senses line, ending with Passive Perception. */
function sensesLine(senses: MonsterStatBlock['senses']): string {
  const ranges = (['blindsight', 'darkvision', 'tremorsense', 'truesight'] as const)
    .filter((sense) => (senses[sense] ?? 0) > 0)
    .map((sense) => `${t(`statBlock.sense.${sense}` as MessageKey)} ${senses[sense]} ft.`);
  return [...ranges, t('statBlock.passivePerception', { value: senses.passivePerception })].join(', ');
}

/** Usage suffix as printed by the SRD: `(Recharge 5-6)`, `(3/Day)`. */
function usageSuffix(action: MonsterAction): string {
  const usage = action.usage;
  if (!usage) return '';
  if (usage.kind === 'recharge') return usage.minRoll === 6 ? ' (Recharge 6)' : ` (Recharge ${usage.minRoll}-6)`;
  if (usage.kind === 'per_day') return ` (${usage.uses}/Day)`;
  return ' (Recharge after a Short or Long Rest)';
}

interface ActionListProps {
  titleKey: MessageKey;
  actions: MonsterAction[];
  intro?: string;
  onAction?: (action: MonsterAction) => void;
  testId?: string;
}

function ActionList({ titleKey, actions, intro, onAction, testId }: ActionListProps) {
  if (actions.length === 0) return null;
  return (
    <section class="ds-stack-sm">
      <h5 class="ds-meta">{t(titleKey)}</h5>
      {intro ? <p class="ds-hint">{intro}</p> : null}
      {actions.map((action) => (
        <div key={action.id} class="ds-stack-sm">
          <p lang="en">
            <strong>
              {action.name}
              {usageSuffix(action)}
              {action.legendaryCost && action.legendaryCost > 1 ? ` (Costs ${action.legendaryCost} Actions)` : ''}.
            </strong>{' '}
            {action.description}
          </p>
          {onAction && (action.attack || action.save) ? (
            <button
              type="button"
              class="ds-btn ds-btn-secondary ds-btn-sm"
              data-testid={testId ? `${testId}-action-${action.id}` : undefined}
              onClick={() => onAction(action)}
            >
              {t(action.attack ? 'statBlock.attackWith' : 'statBlock.useAction', { name: action.name })}
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function Entry({ label, value, valueLang }: { label: string; value: string; valueLang?: string }) {
  if (!value) return null;
  return (
    <div class="ds-row">
      <dt class="ds-meta">{label}</dt>
      <dd lang={valueLang}>{value}</dd>
    </div>
  );
}

export interface MonsterStatBlockViewProps {
  statBlock: MonsterStatBlock;
  /** DOM id of the root section, referenced by the toggle's `aria-controls`. */
  id?: string;
  /** `data-testid` of the root section. */
  testId?: string;
  /** Starts the resolution of an attack or save action (invariant 4); omitted in the compendium. */
  onAction?: (action: MonsterAction) => void;
}

export function MonsterStatBlockView({ statBlock: sb, id, testId, onAction }: MonsterStatBlockViewProps) {
  const listProps = { onAction, testId };
  const mod = (ability: AbilityId) => Math.floor((sb.abilities[ability] - 10) / 2);
  const saves = ABILITIES.filter((ab) => sb.savingThrows[ab] !== undefined)
    .map((ab) => `${t(`statBlock.ability.${ab}` as MessageKey)} ${signed(sb.savingThrows[ab] as number)}`)
    .join(', ');
  const skills = Object.entries(sb.skills)
    .map(([skill, total]) => `${t(`skill.${skill}` as MessageKey)} ${signed(total as number)}`)
    .join(', ');
  const damageList = (types: string[]) => types.map((type) => t(`damage.type.${type}` as MessageKey)).join(', ');

  return (
    <section id={id} class="ds-panel ds-stack-sm" aria-label={t('statBlock.label', { name: sb.name })} data-testid={testId}>
      <h4 class="ds-panel-title" lang="en">{sb.name}</h4>
      <p class="ds-meta" lang="en">
        {`${sb.size} ${sb.creatureType}, ${sb.alignment}`}
      </p>
      <dl class="ds-stack-sm">
        <Entry label={t('statBlock.armorClass')} value={String(sb.armorClass.value)} />
        <Entry label={t('statBlock.hitPoints')} value={`${sb.hitPoints.average} (${sb.hitPoints.formula})`} />
        <Entry label={t('statBlock.speed')} value={speedLine(sb.speed)} />
        <Entry label={t('statBlock.initiative')} value={signed(sb.initiativeBonus)} />
      </dl>
      <dl class="ds-grid-3" aria-label={t('statBlock.abilities')}>
        {ABILITIES.map((ab) => (
          <div key={ab} data-testid={testId ? `${testId}-${ab}` : undefined}>
            <dt class="ds-meta">{t(`statBlock.ability.${ab}` as MessageKey)}</dt>
            <dd>{`${sb.abilities[ab]} (${signed(mod(ab))})`}</dd>
          </div>
        ))}
      </dl>
      <dl class="ds-stack-sm">
        <Entry label={t('statBlock.savingThrows')} value={saves} />
        <Entry label={t('statBlock.skills')} value={skills} />
        <Entry label={t('statBlock.vulnerabilities')} value={damageList(sb.damageVulnerabilities)} />
        <Entry label={t('statBlock.resistances')} value={damageList(sb.damageResistances)} />
        <Entry label={t('statBlock.immunities')} value={damageList(sb.damageImmunities)} />
        <Entry label={t('statBlock.conditionImmunities')} value={sb.conditionImmunities.join(', ')} valueLang="en" />
        <Entry label={t('statBlock.senses')} value={sensesLine(sb.senses)} />
        <Entry label={t('statBlock.languages')} value={sb.languages} valueLang="en" />
        <Entry
          label={t('statBlock.challenge')}
          value={t('statBlock.challengeValue', { cr: challengeRatingLabel(sb.challengeRating), xp: sb.xp, pb: signed(sb.proficiencyBonus) })}
        />
        {sb.legendaryResistance ? (
          <Entry label={t('statBlock.legendaryResistance')} value={t('statBlock.perDay', { uses: sb.legendaryResistance.uses })} />
        ) : null}
      </dl>
      {sb.traits.length > 0 ? (
        <section class="ds-stack-sm">
          <h5 class="ds-meta">{t('statBlock.traits')}</h5>
          {sb.traits.map((trait) => (
            <p key={trait.id} lang="en">
              <strong>{trait.name}.</strong> {trait.description}
            </p>
          ))}
        </section>
      ) : null}
      <ActionList titleKey="statBlock.actions" actions={sb.actions} {...listProps} />
      <ActionList titleKey="statBlock.bonusActions" actions={sb.bonusActions} {...listProps} />
      <ActionList titleKey="statBlock.reactions" actions={sb.reactions} {...listProps} />
      {sb.legendaryActions ? (
        <ActionList
          titleKey="statBlock.legendaryActions"
          actions={sb.legendaryActions.options}
          intro={t('statBlock.legendaryUses', { uses: sb.legendaryActions.uses })}
          {...listProps}
        />
      ) : null}
    </section>
  );
}
