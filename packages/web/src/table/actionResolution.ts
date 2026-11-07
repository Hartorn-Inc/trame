/**
 * ============================================================================
 * SEMI-AUTOMATED ACTION RESOLUTION STATE (table/actionResolution.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Decision D6 on the client: a sheet attack or spell, or a monster's stat
 * block action, becomes a pending action; the user picks targets (or places
 * an area) on the board; the server rolls it against the targets' real AC
 * and save bonuses and stores a `PendingResolution` (ADR-0042) that an
 * explicit Apply turns into damage. This module holds the pending action
 * signals and the pure glue (contexts, roll modes, the `RESOLVE_ACTION`
 * request); `ActionResolutionCard` renders it.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Rules From The System Pack`:
 *    - Roll modes come from `resolveAttackRollMode` / `resolveSavingThrowMode`
 *      fed with conditions, rulings and both sides' feature roll rules
 *      (Reckless Attack, Danger Sense). Nothing is re-implemented here.
 * 2. `The Server Rolls`:
 *    - The client sends the issuer's own numbers (attack bonus, save DC,
 *      damage dice) and each target's advantage state; every d20, damage die,
 *      AC, save bonus, automatic critical hit and save-for-half is decided by
 *      the room. A player therefore never needs, nor receives, a monster's
 *      AC or save bonus (story 47).
 * 3. `3D Distance, Unknown Is Unknown`:
 *    - Attacker-target distance is the larger of the footprint gap and the
 *      elevation difference; without an attacker token it is `null`, so
 *      Prone adds no modifier and nothing becomes an automatic critical hit.
 * 4. `Explicit Cover`:
 *    - Cover is the level the user accepted in the cover panel for this
 *      attacker and target (`acceptedCoverSignal`), `NONE` otherwise.
 * 5. `Every Damage Type Is Rolled`:
 *    - A monster action with several damage types sends its first type as
 *      the primary part and up to `MAX_EXTRA_DAMAGE_PARTS` other types as
 *      `extra_damage`; the server rolls each part and the engine applies
 *      the target's affinity to each type. A spell's secondary save (Ice
 *      Knife) is described (`secondarySave`), never rolled here.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `startAction(pending)` (sheet dispatcher or monster stat block)
 * ├── attack / monster: targets <- `targetTokenIdSignal`, board clicks toggle more.
 * ├── area (spell, or monster save action with an area such as a breath weapon):
 * │           board click sets `areaOriginSignal`; `PROJECT_AOE` -> engine
 * │           `AOE_PROJECTED.affected_token_ids` become the targets.
 * ├── `buildActionRequest` -> `RESOLVE_ACTION` -> `ACTION_RESOLVED`.
 * └── review -> Apply -> `APPLY_RESOLUTION` (GM adjustments per target).
 * ============================================================================
 */
import { signal } from '@preact/signals';
import {
  CompendiumResolver,
  attackSourceOf,
  computeDnd5eSheetDerived,
  resolveAttackRollMode,
  resolveSavingThrowMode,
  type AbilityId,
  type AttackSource,
  type ConditionState,
  type CoverLevel,
  type DamageType,
  type DerivedAttack,
  type DerivedFeatureRollRule,
  type Dnd5eActorData,
  type Dnd5eDerivedStats,
  type MonsterAction,
  type MonsterStatBlock,
  type RollModeResolution,
} from '../../../game-systems/dnd5e/src/index.ts';
import type { AoeShapeDto, AoeTemplateDto } from '../engine/wasmBridge.ts';
import type { ProjectedTableState, Uuid, WireActionRequest, WirePoint2D, WireResolutionCheck, WireRollMode, WireTokenState } from '../api/wire.ts';
import { acceptedCoverSignal, targetTokenIdSignal } from './CoverSuggestionPanel.tsx';
import { boardMetrics } from './scene/tableScene.ts';
import type { TableToken } from './tableView.ts';

/**
 * Action waiting on the table: a sheet attack (or attack / save spell), an area spell, or a
 * monster action. A monster save action with an area (breath weapon) carries its `area`, so
 * it is placed like an area spell instead of ticking targets.
 */
export type PendingAction =
  | { kind: 'attack'; actorId: Uuid; attackId: string }
  | { kind: 'area'; actorId: Uuid; spellId: string }
  | { kind: 'monster'; tokenId: Uuid; actionId: string; area?: SpellArea };

/** Action the resolution card is open for (`null` when none). */
export const pendingActionSignal = signal<PendingAction | null>(null);
/** Tokens targeted by a pending `attack` or `monster` action. */
export const actionTargetIdsSignal = signal<Uuid[]>([]);
/** Board point (`px`) where a pending `area` action is centred, once placed. */
export const areaOriginSignal = signal<WirePoint2D | null>(null);
/** Pending resolution the open card shows (the pending list skips it), `null` before the roll. */
export const activeResolutionIdSignal = signal<Uuid | null>(null);

/** UUID of the area template of the pending action (stable from placement to projection). */
export const areaTemplateIdSignal = signal<Uuid>(newUuid());
/** The pending area was sent with `PROJECT_AOE`; its placement is locked. */
export const areaProjectedSignal = signal<boolean>(false);

export function newUuid(): Uuid {
  return globalThis.crypto.randomUUID();
}

/** Area a pending action is placed with: the spell's compendium area or the monster action's own. */
export function pendingArea(pending: PendingAction | null): SpellArea | null {
  if (pending?.kind === 'monster') return pending.area ?? null;
  if (pending?.kind !== 'area') return null;
  return (CompendiumResolver.getDefault().get(pending.spellId)?.data.area as SpellArea | undefined) ?? null;
}

/** The pending action is placed as an area (area spell or monster area action). */
export function isAreaAction(pending: PendingAction | null): boolean {
  return pending?.kind === 'area' || (pending?.kind === 'monster' && pending.area !== undefined);
}

/** Pending action of a monster stat block action; save actions with an area are placed as areas. */
export function monsterPendingAction(tokenId: Uuid, action: MonsterAction): PendingAction {
  const area = !action.attack ? action.save?.area : undefined;
  return area ? { kind: 'monster', tokenId, actionId: action.id, area } : { kind: 'monster', tokenId, actionId: action.id };
}

/** Opens the resolution card; an attack starts on the cover panel's target. */
export function startAction(action: PendingAction): void {
  pendingActionSignal.value = action;
  const target = targetTokenIdSignal.value;
  actionTargetIdsSignal.value = !isAreaAction(action) && target ? [target] : [];
  areaOriginSignal.value = null;
  areaTemplateIdSignal.value = newUuid();
  areaProjectedSignal.value = false;
  activeResolutionIdSignal.value = null;
}

/** Closes the resolution card; an unapplied resolution stays in the pending list. */
export function cancelAction(): void {
  pendingActionSignal.value = null;
  actionTargetIdsSignal.value = [];
  areaOriginSignal.value = null;
  areaProjectedSignal.value = false;
  activeResolutionIdSignal.value = null;
}

/** Adds or removes a target of the pending attack. */
export function toggleActionTarget(tokenId: Uuid): void {
  const ids = actionTargetIdsSignal.value;
  actionTargetIdsSignal.value = ids.includes(tokenId) ? ids.filter((id) => id !== tokenId) : [...ids, tokenId];
}

/** Board clicks on tokens toggle targets instead of selecting (until the action is rolled). */
export function isPickingTargets(): boolean {
  const pending = pendingActionSignal.value;
  return pending !== null && !isAreaAction(pending) && activeResolutionIdSignal.value === null;
}

/** Board clicks place the pending area until it is projected. */
export function isPlacingArea(): boolean {
  return isAreaAction(pendingActionSignal.value) && !areaProjectedSignal.value;
}

/** First token on the table linked to `actorId` (the caster or attacker), `null` when none. */
export function casterTokenId(state: ProjectedTableState | null, actorId: Uuid): Uuid | null {
  const linked = (tokens: Record<Uuid, WireTokenState> | undefined) =>
    Object.values(tokens ?? {}).find((tok) => tok.actor_id === actorId)?.id ?? null;
  return linked(state?.tokens) ?? linked(state?.public_tokens as Record<Uuid, WireTokenState> | undefined);
}

/** What the card resolves: a sheet attack, spell or monster action reduced to the numbers the server needs. */
export interface ResolvableAction {
  id: string;
  name: string;
  /** Attack roll bonus; `null` when targets save instead. */
  attackBonus: number | null;
  /** Saving throw targets make (`null` for attack rolls). */
  save: { ability: AbilityId; dc: number } | null;
  /** A successful save halves the damage (otherwise it negates it). */
  halfDamageOnSave: boolean;
  /** Damage dice (`""` when the action deals no damage); flat terms are moved to the modifier. */
  damageDice: string;
  /** Flat damage added once. */
  damageModifier: number;
  damageType: DamageType | null;
  /** Natural d20 from which an attack crits (weapon Champion `19` / `18`, else `20`). */
  criticalRange: number;
  /** Source matched against feature roll rules. */
  source: AttackSource;
  /** Spell area (`{ shape: "cone", sizeFt: 15 }`), `null` for single targets. */
  area: { shape: string; sizeFt: number } | null;
  /** The spell requires concentration. */
  concentration: boolean;
  /** Save after the attack's damage (Ice Knife), described to the table, not rolled (invariant 5). */
  secondarySave?: { ability: AbilityId; dc: number } | null;
  /** Damage parts of other types, rolled and mitigated one by one (invariant 5). */
  extraDamage?: ExtraDamagePart[];
}

/** One extra damage part of an action: its dice, flat modifier and type. */
export interface ExtraDamagePart {
  /** Dice terms only (`"2d6"`), `""` for flat damage. */
  dice: string;
  /** Flat damage added once. */
  modifier: number;
  type: DamageType;
}

/** Most extra damage parts the server accepts besides the primary part (`MAX_EXTRA_DAMAGE_COMPONENTS`). */
export const MAX_EXTRA_DAMAGE_PARTS = 3;

/** Derived statistics of a stored sheet, `null` when it cannot be derived. */
export function deriveSheet(data: unknown): Dnd5eDerivedStats | null {
  if (!data || typeof data !== 'object') return null;
  try {
    return computeDnd5eSheetDerived(data as Dnd5eActorData) as Dnd5eDerivedStats;
  } catch {
    return null;
  }
}

/** `ResolvableAction` of a derived attack; weapon crit range falls back to the feature rules. */
export function resolvableFromAttack(attack: DerivedAttack, featureCriticalRange = 20): ResolvableAction {
  const data = attack.source === 'spell' ? CompendiumResolver.getDefault().get(attack.id)?.data : undefined;
  const area = data?.area as { shape: string; sizeFt: number } | undefined;
  return {
    id: attack.id,
    name: attack.name,
    attackBonus: attack.attackBonus,
    save: attack.save ?? null,
    halfDamageOnSave: data?.halfDamageOnSave === true,
    damageDice: attack.damageDice,
    damageModifier: attack.damageModifier,
    damageType: attack.damageType,
    criticalRange: attack.source === 'weapon' ? (attack.criticalRange ?? featureCriticalRange) : 20,
    source: attackSourceOf(attack),
    area: area ?? null,
    concentration: data?.concentration === true,
    secondarySave: attack.secondarySave ?? null,
  };
}

/** The action a pending sheet action resolves for the attacker's derived sheet, `null` when it is gone. */
export function resolvableFor(pending: PendingAction, derived: Dnd5eDerivedStats): ResolvableAction | null {
  if (pending.kind === 'monster') return null;
  const id = pending.kind === 'attack' ? pending.attackId : pending.spellId;
  const attack = (derived.attacks ?? []).find((a) => a.id === id);
  if (attack) return resolvableFromAttack(attack, derived.featureRules?.criticalRange);
  if (pending.kind !== 'area') return null;
  const entry = CompendiumResolver.getDefault().get(id);
  if (!entry) return null;
  const data = entry.data;
  const ability = data.saveAbility as AbilityId | undefined;
  return {
    id,
    name: entry.name,
    attackBonus: null,
    save: ability ? { ability, dc: derived.spellSaveDc } : null,
    halfDamageOnSave: data.halfDamageOnSave === true,
    damageDice: typeof data.damageDice === 'string' ? data.damageDice : '',
    damageModifier: 0,
    damageType: typeof data.damageType === 'string' ? (data.damageType as DamageType) : null,
    criticalRange: 20,
    source: 'spell',
    area: (data.area as { shape: string; sizeFt: number } | undefined) ?? null,
    concentration: data.concentration === true,
  };
}

/** Splits `"1d10 + 8"` / `"2d6+1d8-1"` into dice terms (`"1d10"`) and the summed flat modifier (`8`). */
export function splitDamage(expression: string): { dice: string; modifier: number } {
  const dice: string[] = [];
  let modifier = 0;
  for (const [, sign, term] of expression.replace(/\s+/g, '').matchAll(/([+-]?)([^+-]+)/g)) {
    if (/^\d*d\d+$/i.test(term)) dice.push(term.toLowerCase().startsWith('d') ? `1${term}` : term);
    else if (/^\d+$/.test(term)) modifier += sign === '-' ? -Number(term) : Number(term);
  }
  return { dice: dice.join('+'), modifier };
}

/** Every action of a stat block, with legendary options, by id. */
export function monsterActions(block: MonsterStatBlock): MonsterAction[] {
  return [...block.actions, ...block.bonusActions, ...block.reactions, ...(block.legendaryActions?.options ?? [])];
}

/** `ResolvableAction` of a monster's attack or save action; `null` for prose-only actions (Multiattack). */
export function resolvableFromMonsterAction(action: MonsterAction): ResolvableAction | null {
  if (!action.attack && !action.save) return null;
  const parts = action.damage ?? [];
  const ofType = (type: DamageType) => {
    const own = parts.filter((p) => p.type === type).map((p) => splitDamage(p.dice));
    return { dice: own.map((p) => p.dice).filter(Boolean).join('+'), modifier: own.reduce((sum, p) => sum + p.modifier, 0) };
  };
  const [type = null, ...otherTypes] = [...new Set(parts.map((p) => p.type))];
  const primary = type ? ofType(type) : { dice: '', modifier: 0 };
  return {
    id: action.id,
    name: action.name,
    attackBonus: action.attack ? action.attack.toHit : null,
    save: !action.attack && action.save ? { ability: action.save.ability, dc: action.save.dc } : null,
    halfDamageOnSave: action.save?.onSuccess === 'half',
    damageDice: primary.dice,
    damageModifier: primary.modifier,
    damageType: type,
    criticalRange: 20,
    source: action.attack?.kind === 'ranged' ? 'weapon_dex' : 'weapon_str',
    area: (!action.attack ? action.save?.area : undefined) ?? null,
    concentration: false,
    secondarySave: action.attack && action.save ? { ability: action.save.ability, dc: action.save.dc } : null,
    extraDamage: otherTypes.slice(0, MAX_EXTRA_DAMAGE_PARTS).map((other) => ({ ...ofType(other), type: other })),
  };
}

/** Attacker side of an action. */
export interface AttackerContext {
  /** Token on the table, `null` when the actor has none. */
  tokenId: Uuid | null;
  conditions: ConditionState;
  /** `derived.featureRules.rolls` of the attacker's sheet (none for stat blocks). */
  featureRolls: readonly DerivedFeatureRollRule[];
}

/** Target side of an action, as far as the viewer knows it. */
export interface TargetContext {
  tokenId: Uuid;
  name: string;
  conditions: ConditionState;
  /** Target's own feature roll rules (Danger Sense, Reckless Attack), from a sheet the viewer has. */
  featureRolls: readonly DerivedFeatureRollRule[];
  /** 3D distance to the attacker in feet (`ft`), `null` when unknown (invariant 3). */
  distanceFt: number | null;
  cover: CoverLevel;
}

/**
 * Feet between two tokens (invariant 3): horizontally the empty cells between the
 * footprints plus one, vertically the elevation difference; the larger of the two.
 */
export function footprintDistanceFt(a: TableToken, b: TableToken, cellPx: number, feetPerCell: number): number {
  const span = (start: number, cells: number) => [start / cellPx, start / cellPx + cells] as const;
  const [ax0, ax1] = span(a.topLeft.x, a.gridW);
  const [bx0, bx1] = span(b.topLeft.x, b.gridW);
  const [ay0, ay1] = span(a.topLeft.y, a.gridH);
  const [by0, by1] = span(b.topLeft.y, b.gridH);
  const gap = Math.max(0, bx0 - ax1, ax0 - bx1, by0 - ay1, ay0 - by1);
  return Math.max(Math.round(gap + 1) * feetPerCell, Math.abs(a.elevationFt - b.elevationFt));
}

/** Inputs to build contexts from the session. */
export interface ContextSources {
  state: ProjectedTableState | null;
  tokens: readonly TableToken[];
  /** Stored sheets the viewer received (`client.state.actors`). */
  sheets: Readonly<Record<Uuid, { data: unknown } | undefined>>;
}

function sheetRolls(sources: ContextSources, actorId: Uuid | null): readonly DerivedFeatureRollRule[] {
  const data = actorId ? sources.sheets[actorId]?.data : undefined;
  return data ? (deriveSheet(data)?.featureRules?.rolls ?? []) : [];
}

function contextOf(token: TableToken | undefined, featureRolls: readonly DerivedFeatureRollRule[]): AttackerContext {
  return {
    tokenId: token?.id ?? null,
    conditions: { conditions: token?.conditions ?? [], overrides: token?.conditionOverrides ?? [] },
    featureRolls,
  };
}

/** Attacker context of the pending action: the actor's first linked token, or the monster token. */
export function attackerContext(sources: ContextSources, pending: PendingAction): AttackerContext {
  if (pending.kind === 'monster') return contextOf(sources.tokens.find((tok) => tok.id === pending.tokenId), []);
  const { actorId } = pending;
  const token = sources.tokens.find((tok) => tok.actorId === actorId && tok.controlled) ?? sources.tokens.find((tok) => tok.actorId === actorId);
  return contextOf(token, sheetRolls(sources, actorId));
}

/** Target context of `target` seen from `attackerTokenId` (invariants 3 and 4). */
export function targetContext(sources: ContextSources, target: TableToken, attackerTokenId: Uuid | null): TargetContext {
  const attacker = attackerTokenId ? sources.tokens.find((tok) => tok.id === attackerTokenId) : undefined;
  const { cellPx } = boardMetrics(sources.state);
  const accepted = acceptedCoverSignal.value;
  const cover = accepted && accepted.attackerId === attackerTokenId && accepted.targetId === target.id ? accepted.cover : 'NONE';
  return {
    tokenId: target.id,
    name: target.name,
    conditions: { conditions: target.conditions, overrides: target.conditionOverrides },
    featureRolls: sheetRolls(sources, target.actorId),
    distanceFt: attacker ? footprintDistanceFt(attacker, target, cellPx, sources.state?.feet_per_cell || 5) : null,
    cover,
  };
}

/** The action and attacker of a pending action, `null` when its sheet or stat block action is gone. */
export function pendingResolvable(sources: ContextSources, pending: PendingAction): ResolvableAction | null {
  if (pending.kind === 'monster') {
    const block = sources.state?.tokens[pending.tokenId]?.stat_block as MonsterStatBlock | undefined;
    const action = block && Array.isArray(block.actions) ? monsterActions(block).find((a) => a.id === pending.actionId) : undefined;
    return action ? resolvableFromMonsterAction(action) : null;
  }
  const derived = deriveSheet(sources.sheets[pending.actorId]?.data);
  return derived ? resolvableFor(pending, derived) : null;
}

/**
 * Advantage state of one target (invariant 1): the attack roll mode for attacks, the
 * target's saving throw mode for saves (the server keeps its own for targets the issuer
 * does not control), normal for automatic hits.
 */
export function targetRollMode(action: ResolvableAction, attacker: AttackerContext, target: TargetContext): RollModeResolution {
  if (action.attackBonus !== null) {
    return resolveAttackRollMode({
      attacker: attacker.conditions,
      target: target.conditions,
      distanceFt: target.distanceFt,
      source: action.source,
      attackerFeatures: attacker.featureRolls,
      targetFeatures: target.featureRolls,
    });
  }
  if (action.save) return resolveSavingThrowMode(target.conditions, action.save.ability, undefined, target.featureRolls);
  return { mode: 'normal', advantageSources: [], disadvantageSources: [] };
}

const WIRE_ROLL_MODE = { normal: 'NORMAL', advantage: 'ADVANTAGE', disadvantage: 'DISADVANTAGE' } as const satisfies Record<string, WireRollMode>;

/** `RESOLVE_ACTION` request of `action` against `targets` (invariant 2). */
export function buildActionRequest(
  action: ResolvableAction,
  attacker: AttackerContext,
  targets: readonly TargetContext[],
  resolutionId: Uuid,
): WireActionRequest {
  const check: WireResolutionCheck =
    action.attackBonus !== null
      ? { kind: 'ATTACK', attack_bonus: Math.trunc(action.attackBonus), critical_range: action.criticalRange }
      : action.save
        ? { kind: 'SAVE', ability: action.save.ability, dc: action.save.dc, half_on_success: action.halfDamageOnSave }
        : { kind: 'AUTOMATIC' };
  const damage = splitDamage(action.damageDice);
  return {
    resolution_id: resolutionId,
    attacker_token_id: attacker.tokenId,
    action_name: action.name.slice(0, 120),
    check,
    damage_dice: damage.dice,
    damage_modifier: Math.trunc(action.damageModifier + damage.modifier),
    damage_type: action.damageType,
    extra_damage: (action.extraDamage ?? []).map((part) => ({
      dice: part.dice,
      modifier: Math.trunc(part.modifier),
      damage_type: part.type,
    })),
    targets: targets.map((target) => ({
      token_id: target.tokenId,
      roll_mode: WIRE_ROLL_MODE[targetRollMode(action, attacker, target).mode],
      cover: target.cover,
    })),
  };
}

/** SRD cone: its width at any point equals its distance from the origin (`2 * atan(1/2)`). */
export const SRD_CONE_ANGLE_DEG = (2 * Math.atan(0.5) * 180) / Math.PI;

/** Spell area as stored in the compendium (`AreaOfEffect`). */
export interface SpellArea {
  shape: string;
  sizeFt: number;
  widthFt?: number;
  heightFt?: number;
}

/**
 * Engine template of a spell area. Spheres, cylinders and cubes are centred
 * on the placed point; cones and lines start at the caster and aim at it
 * (from the point, aimed along +X, without a caster token); an emanation is
 * a sphere around the caster that reaches `sizeFt` past its footprint.
 */
export function areaTemplate(
  area: SpellArea,
  point: WirePoint2D,
  caster: { center: WirePoint2D; radiusFt: number } | null,
  id: Uuid,
  concentrationCasterId: Uuid | null,
): AoeTemplateDto {
  const aimed = area.shape === 'cone' || area.shape === 'line';
  const origin = caster && (aimed || area.shape === 'emanation') ? caster.center : point;
  const direction = caster && aimed ? (Math.atan2(point.y - origin.y, point.x - origin.x) * 180) / Math.PI : 0;
  const shape: AoeShapeDto = (() => {
    switch (area.shape) {
      case 'cone':
        return { shape: 'CONE', length_ft: area.sizeFt, angle_deg: SRD_CONE_ANGLE_DEG, direction_deg: direction };
      case 'line':
        return { shape: 'LINE', length_ft: area.sizeFt, width_ft: area.widthFt ?? 5, direction_deg: direction };
      case 'cube':
        return { shape: 'CUBE', side_ft: area.sizeFt, rotation_deg: 0 };
      case 'cylinder':
        return { shape: 'CYLINDER', radius_ft: area.sizeFt, height_ft: area.heightFt ?? area.sizeFt };
      case 'emanation':
        return { shape: 'SPHERE', radius_ft: area.sizeFt + (caster?.radiusFt ?? 0) };
      default:
        return { shape: 'SPHERE', radius_ft: area.sizeFt };
    }
  })();
  return {
    id,
    origin: { x: origin.x, y: origin.y },
    origin_elevation_ft: 0,
    shape,
    stops_at_walls: true,
    discretization: 'CENTER_POINT',
    concentration_caster_id: concentrationCasterId,
  };
}

/** Template of the pending area once placed (shared by the card and the board preview). */
export function pendingAreaTemplate(state: ProjectedTableState | null): AoeTemplateDto | null {
  const pending = pendingActionSignal.value;
  const point = areaOriginSignal.value;
  const area = pendingArea(pending);
  if (!pending || pending.kind === 'attack' || !point || !area) return null;
  const concentration = pending.kind === 'area' && CompendiumResolver.getDefault().get(pending.spellId)?.data.concentration === true;
  const casterId = pending.kind === 'monster' ? pending.tokenId : casterTokenId(state, pending.actorId);
  const token = casterId ? (state?.tokens[casterId] ?? state?.public_tokens?.[casterId]) : undefined;
  const { cellPx } = boardMetrics(state);
  const feetPerCell = state?.feet_per_cell || 5;
  const caster = token?.top_left
    ? {
        center: { x: token.top_left.x + ((token.grid_w ?? 1) * cellPx) / 2, y: token.top_left.y + ((token.grid_h ?? 1) * cellPx) / 2 },
        radiusFt: ((token.grid_w ?? 1) * feetPerCell) / 2,
      }
    : null;
  return areaTemplate(area, point, caster, areaTemplateIdSignal.value, concentration ? casterId : null);
}
