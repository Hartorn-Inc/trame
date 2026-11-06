/**
 * ============================================================================
 * SEMI-AUTOMATED ACTION RESOLUTION STATE (table/actionResolution.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Decision D6 on the client: a sheet attack or spell becomes a pending
 * action, the user picks targets (or places an area) on the board, TRAME
 * rolls the attack or the targets' saving throws on the server, and the user
 * reviews the numbers before an explicit Apply sends typed damage through the
 * room. This module holds the pending action signals and the pure rules glue
 * (contexts, roll plans, outcomes); `ActionResolutionCard` renders it.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Rules From The System Pack`:
 *    - Roll modes come from `resolveAttackRollMode` / `resolveSavingThrowMode`
 *      fed with conditions, rulings and both sides' feature roll rules
 *      (Reckless Attack, Danger Sense); outcomes, critical dice and
 *      save-for-half from `resolution.ts`. Nothing is re-implemented here.
 * 2. `Server Dice`:
 *    - Every d20 and damage roll goes through the injected `DiceRoller`
 *      (REST `POST .../dice/roll`), so rolls are logged for the whole table.
 * 3. `Hidden Numbers Stay Hidden`:
 *    - A target's AC is only read from tokens the viewer controls (the GM
 *      controls every token); save bonuses only from sheets the viewer
 *      received or stat blocks on controlled tokens. Otherwise the outcome is
 *      `unknown` and the user rules it; nothing is guessed.
 * 4. `Explicit Cover`:
 *    - Cover is the level the user accepted in the cover panel for this
 *      attacker and target (`acceptedCoverSignal`), `NONE` otherwise. For an
 *      area it applies to Dexterity saves only.
 * 5. `Nothing Applies Itself`:
 *    - The functions here never submit damage; the card submits
 *      `APPLY_DAMAGE` per target on Apply, after the user (or GM) reviewed or
 *      adjusted each amount.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `startAction(pending)` (sheet dispatcher)
 * ├── attack: targets <- `targetTokenIdSignal`, board clicks toggle more.
 * ├── area:   board click sets `areaOriginSignal`; `PROJECT_AOE` -> engine
 * │           `AOE_PROJECTED.affected_token_ids` become the targets.
 * ├── `resolveAttackTarget` / `resolveSaveTargets` (server rolls).
 * └── review -> Apply -> `APPLY_DAMAGE { damage_type, is_critical }` each.
 * ============================================================================
 */
import { signal } from '@preact/signals';
import {
  CompendiumResolver,
  attackSourceOf,
  computeDnd5eSheetDerived,
  d20Expression,
  damageAfterSave,
  damageExpression,
  resolveAttackOutcome,
  resolveAttackRollMode,
  resolveSaveOutcome,
  resolveSavingThrowMode,
  saveBonusWithCover,
  type AbilityId,
  type AttackOutcome,
  type AttackSource,
  type ConditionState,
  type CoverLevel,
  type DamageType,
  type DerivedAttack,
  type DerivedFeatureRollRule,
  type Dnd5eActorData,
  type Dnd5eDerivedStats,
  type RollMode,
  type SaveOutcome,
} from '../../../game-systems/dnd5e/src/index.ts';
import type { ApiClient } from '../api/client.ts';
import type { AoeShapeDto, AoeTemplateDto } from '../engine/wasmBridge.ts';
import type { ProjectedTableState, Uuid, WirePoint2D, WireTokenState } from '../api/wire.ts';
import { acceptedCoverSignal, targetTokenIdSignal } from './CoverSuggestionPanel.tsx';
import { boardMetrics } from './scene/tableScene.ts';
import type { TableToken } from './tableView.ts';

const ABILITIES: readonly AbilityId[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

/** Action waiting on the table: a sheet attack (or attack / save spell), or an area spell. */
export type PendingAction =
  | { kind: 'attack'; actorId: Uuid; attackId: string }
  | { kind: 'area'; actorId: Uuid; spellId: string };

/** Action the resolution card is open for (`null` when none). */
export const pendingActionSignal = signal<PendingAction | null>(null);
/** Tokens targeted by a pending `attack` action. */
export const actionTargetIdsSignal = signal<Uuid[]>([]);
/** Board point (`px`) where a pending `area` action is centred, once placed. */
export const areaOriginSignal = signal<WirePoint2D | null>(null);

/** UUID of the area template of the pending action (stable from placement to projection). */
export const areaTemplateIdSignal = signal<Uuid>(newUuid());
/** The pending area was sent with `PROJECT_AOE`; its placement is locked. */
export const areaProjectedSignal = signal<boolean>(false);

function newUuid(): Uuid {
  return globalThis.crypto.randomUUID();
}

/** Opens the resolution card; an attack starts on the cover panel's target. */
export function startAction(action: PendingAction): void {
  pendingActionSignal.value = action;
  const target = targetTokenIdSignal.value;
  actionTargetIdsSignal.value = action.kind === 'attack' && target ? [target] : [];
  areaOriginSignal.value = null;
  areaTemplateIdSignal.value = newUuid();
  areaProjectedSignal.value = false;
}

/** Closes the resolution card without applying anything. */
export function cancelAction(): void {
  pendingActionSignal.value = null;
  actionTargetIdsSignal.value = [];
  areaOriginSignal.value = null;
  areaProjectedSignal.value = false;
}

/** Adds or removes a target of the pending attack. */
export function toggleActionTarget(tokenId: Uuid): void {
  const ids = actionTargetIdsSignal.value;
  actionTargetIdsSignal.value = ids.includes(tokenId) ? ids.filter((id) => id !== tokenId) : [...ids, tokenId];
}

/** Board clicks on tokens toggle targets instead of selecting. */
export function isPickingTargets(): boolean {
  return pendingActionSignal.value?.kind === 'attack';
}

/** Board clicks place the pending area until it is projected. */
export function isPlacingArea(): boolean {
  return pendingActionSignal.value?.kind === 'area' && !areaProjectedSignal.value;
}

/** First token on the table linked to `actorId` (the caster or attacker), `null` when none. */
export function casterTokenId(state: ProjectedTableState | null, actorId: Uuid): Uuid | null {
  const linked = (tokens: Record<Uuid, WireTokenState> | undefined) =>
    Object.values(tokens ?? {}).find((tok) => tok.actor_id === actorId)?.id ?? null;
  return linked(state?.tokens) ?? linked(state?.public_tokens as Record<Uuid, WireTokenState> | undefined);
}

/** What the card resolves: a sheet attack or spell reduced to the numbers the rules need. */
export interface ResolvableAction {
  id: string;
  name: string;
  /** Attack roll bonus; `null` when targets save instead. */
  attackBonus: number | null;
  /** Saving throw targets make (`null` for attack rolls). */
  save: { ability: AbilityId; dc: number } | null;
  /** A successful save halves the damage (otherwise it negates it). */
  halfDamageOnSave: boolean;
  /** Damage dice (`""` when the action deals no damage). */
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
}

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
  };
}

/** The action a pending action resolves for the attacker's derived sheet, `null` when it is gone. */
export function resolvableFor(pending: PendingAction, derived: Dnd5eDerivedStats): ResolvableAction | null {
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

/** Attacker side of an action. */
export interface AttackerContext {
  /** Token on the table, `null` when the actor has none. */
  tokenId: Uuid | null;
  conditions: ConditionState;
  /** `derived.featureRules.rolls` of the attacker's sheet. */
  featureRolls: readonly DerivedFeatureRollRule[];
}

/** Target side of an action (invariant 3). */
export interface TargetContext {
  tokenId: Uuid;
  name: string;
  /** Armor Class, `null` when hidden from the viewer. */
  ac: number | null;
  conditions: ConditionState;
  /** Target's own feature roll rules (Danger Sense, Reckless Attack). */
  featureRolls: readonly DerivedFeatureRollRule[];
  /** Saving throw bonuses, `null` when unknown to the viewer. */
  saveBonuses: Partial<Record<AbilityId, number>> | null;
  /** Distance to the attacker in feet (`ft`); `5` when unknown. */
  distanceFt: number;
  cover: CoverLevel;
}

function statBlockSaves(block: Record<string, unknown> | undefined): Partial<Record<AbilityId, number>> | null {
  const scores = block?.abilities as Partial<Record<AbilityId, number>> | undefined;
  if (!scores) return null;
  const saves = (block?.savingThrows ?? {}) as Partial<Record<AbilityId, number>>;
  return Object.fromEntries(
    ABILITIES.map((ab) => [ab, typeof saves[ab] === 'number' ? saves[ab] : Math.floor(((scores[ab] ?? 10) - 10) / 2)]),
  ) as Partial<Record<AbilityId, number>>;
}

/** Feet between two footprints: empty cells between them plus one, times the cell size. */
export function footprintDistanceFt(a: TableToken, b: TableToken, cellPx: number, feetPerCell: number): number {
  const span = (start: number, cells: number) => [start / cellPx, start / cellPx + cells] as const;
  const [ax0, ax1] = span(a.topLeft.x, a.gridW);
  const [bx0, bx1] = span(b.topLeft.x, b.gridW);
  const [ay0, ay1] = span(a.topLeft.y, a.gridH);
  const [by0, by1] = span(b.topLeft.y, b.gridH);
  const gap = Math.max(0, bx0 - ax1, ax0 - bx1, by0 - ay1, ay0 - by1);
  return Math.round(gap + 1) * feetPerCell;
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

/** Attacker context of `actorId` (its first linked token). */
export function attackerContext(sources: ContextSources, actorId: Uuid): AttackerContext {
  const token = sources.tokens.find((tok) => tok.actorId === actorId && tok.controlled) ?? sources.tokens.find((tok) => tok.actorId === actorId);
  return {
    tokenId: token?.id ?? null,
    conditions: { conditions: token?.conditions ?? [], overrides: token?.conditionOverrides ?? [] },
    featureRolls: sheetRolls(sources, actorId),
  };
}

/** Target context of `target` seen from `attackerTokenId` (invariants 3 and 4). */
export function targetContext(sources: ContextSources, target: TableToken, attackerTokenId: Uuid | null): TargetContext {
  const raw = target.controlled ? sources.state?.tokens[target.id] : undefined;
  const sheet = target.actorId ? sources.sheets[target.actorId]?.data : undefined;
  const derived = sheet ? deriveSheet(sheet) : null;
  const attacker = attackerTokenId ? sources.tokens.find((tok) => tok.id === attackerTokenId) : undefined;
  const { cellPx } = boardMetrics(sources.state);
  const accepted = acceptedCoverSignal.value;
  const cover = accepted && accepted.attackerId === attackerTokenId && accepted.targetId === target.id ? accepted.cover : 'NONE';
  return {
    tokenId: target.id,
    name: target.name,
    ac: typeof raw?.ac === 'number' ? raw.ac : null,
    conditions: { conditions: target.conditions, overrides: target.conditionOverrides },
    featureRolls: derived?.featureRules?.rolls ?? [],
    saveBonuses: derived ? { ...derived.savingThrows } : statBlockSaves(raw?.stat_block),
    distanceFt: attacker ? footprintDistanceFt(attacker, target, cellPx, sources.state?.feet_per_cell || 5) : 5,
    cover,
  };
}

/** Per-target result shown for review. */
export interface TargetResolution {
  tokenId: Uuid;
  name: string;
  mode: RollMode;
  advantageSources: string[];
  disadvantageSources: string[];
  /** d20 expression sent, `null` when nothing was rolled. */
  expression: string | null;
  natural: number | null;
  total: number | null;
  outcome: AttackOutcome | SaveOutcome;
  critical: boolean;
  /** Damage rolled before any save (`null` while not rolled). */
  rolledDamage: number | null;
  /** Amount to apply; editable before Apply. */
  damage: number;
}

/** Server roll: total and the kept natural d20 of the first term (`null` without one). */
export type DiceRoller = (expression: string, reason: string) => Promise<{ total: number; natural: number | null }>;

/** `DiceRoller` over REST `POST .../dice/roll` (public rolls, logged for the table). */
export function restDiceRoller(client: ApiClient, campaignId: Uuid): DiceRoller {
  return async (expression, reason) => {
    const roll = await client.rollDiceRest(campaignId, expression, { visibility: 'Public', reason });
    const first = (roll.terms ?? [])[0] as { kept_rolls?: number[] } | undefined;
    return { total: roll.total ?? 0, natural: first?.kept_rolls?.[0] ?? null };
  };
}

/** Rolls the damage of `action` (dice doubled on a critical hit); `0` without damage dice. */
export async function rollDamage(action: ResolvableAction, critical: boolean, roll: DiceRoller): Promise<number> {
  if (!action.damageDice) return 0;
  const result = await roll(damageExpression(action.damageDice, action.damageModifier, critical), `${action.name}: damage`);
  return Math.max(0, result.total);
}

/** Roll mode and expression of an attack against `target`. */
export function attackRollPlan(action: ResolvableAction, attacker: AttackerContext, target: TargetContext) {
  const mode = resolveAttackRollMode({
    attacker: attacker.conditions,
    target: target.conditions,
    distanceFt: target.distanceFt,
    source: action.source,
    attackerFeatures: attacker.featureRolls,
    targetFeatures: target.featureRolls,
  });
  return { ...mode, expression: d20Expression(mode.mode, action.attackBonus ?? 0) };
}

/** Rolls one attack and, on a hit or critical hit, its damage (invariants 1 and 2). */
export async function resolveAttackTarget(
  action: ResolvableAction,
  attacker: AttackerContext,
  target: TargetContext,
  roll: DiceRoller,
): Promise<TargetResolution> {
  const plan = attackRollPlan(action, attacker, target);
  const base = {
    tokenId: target.tokenId,
    name: target.name,
    mode: plan.mode,
    advantageSources: plan.advantageSources,
    disadvantageSources: plan.disadvantageSources,
  };
  if (target.cover === 'TOTAL') {
    return { ...base, expression: null, natural: null, total: null, outcome: 'blocked', critical: false, rolledDamage: null, damage: 0 };
  }
  const result = await roll(plan.expression, `${action.name}: attack vs ${target.name}`);
  const outcome = resolveAttackOutcome({
    natural: result.natural ?? 10,
    total: result.total,
    targetAc: target.ac,
    cover: target.cover,
    criticalRange: action.criticalRange,
    autoCritical: plan.autoCritical,
  });
  const critical = outcome === 'critical';
  const rolledDamage = outcome === 'hit' || critical ? await rollDamage(action, critical, roll) : null;
  return { ...base, expression: plan.expression, natural: result.natural, total: result.total, outcome, critical, rolledDamage, damage: rolledDamage ?? 0 };
}

/** Roll mode, automatic failure and bonus (with cover) of `target`'s save against `action`. */
export function saveRollPlan(action: ResolvableAction, target: TargetContext) {
  const ability = action.save!.ability;
  const mode = resolveSavingThrowMode(target.conditions, ability, undefined, target.featureRolls);
  const known = target.saveBonuses?.[ability];
  const bonus = typeof known === 'number' ? saveBonusWithCover(known, ability, target.cover) : null;
  return { ...mode, bonus, expression: bonus === null ? null : d20Expression(mode.mode, bonus) };
}

/**
 * Rolls the damage once, then each target's save (when its bonus is known)
 * and the damage it takes: full on a failure, half or none on a success.
 * Unknown outcomes keep the full damage until the user rules them.
 */
export async function resolveSaveTargets(
  action: ResolvableAction,
  targets: readonly TargetContext[],
  roll: DiceRoller,
): Promise<TargetResolution[]> {
  const rawDamage = await rollDamage(action, false, roll);
  const results: TargetResolution[] = [];
  for (const target of targets) {
    const plan = saveRollPlan(action, target);
    const blocked = target.cover === 'TOTAL';
    const rolled = !blocked && !plan.autoFail && plan.expression ? await roll(plan.expression, `${target.name}: ${action.save!.ability.toUpperCase()} save vs ${action.name}`) : null;
    const outcome = resolveSaveOutcome({ total: rolled ? rolled.total : null, dc: action.save!.dc, autoFail: plan.autoFail, cover: target.cover });
    results.push({
      tokenId: target.tokenId,
      name: target.name,
      mode: plan.mode,
      advantageSources: plan.advantageSources,
      disadvantageSources: plan.disadvantageSources,
      expression: rolled ? plan.expression : null,
      natural: rolled?.natural ?? null,
      total: rolled?.total ?? null,
      outcome,
      critical: false,
      rolledDamage: rawDamage,
      damage: outcome === 'unknown' ? rawDamage : damageAfterSave(rawDamage, outcome, action.halfDamageOnSave),
    });
  }
  return results;
}

/**
 * Resolves `action` against every target: one attack roll each, else the
 * targets' saving throws, else (automatic hits such as Magic Missile) the
 * full damage.
 */
export async function resolveTargets(
  action: ResolvableAction,
  attacker: AttackerContext,
  targets: readonly TargetContext[],
  roll: DiceRoller,
): Promise<TargetResolution[]> {
  if (action.attackBonus !== null) {
    const results: TargetResolution[] = [];
    for (const target of targets) results.push(await resolveAttackTarget(action, attacker, target, roll));
    return results;
  }
  if (action.save) return resolveSaveTargets(action, targets, roll);
  return resolveUnsavedTargets(action, targets, roll);
}

/** Area targets without a saving throw take the full damage (rolled once). */
export async function resolveUnsavedTargets(
  action: ResolvableAction,
  targets: readonly TargetContext[],
  roll: DiceRoller,
): Promise<TargetResolution[]> {
  const rawDamage = await rollDamage(action, false, roll);
  return targets.map((target) => ({
    tokenId: target.tokenId,
    name: target.name,
    mode: 'normal',
    advantageSources: [],
    disadvantageSources: [],
    expression: null,
    natural: null,
    total: null,
    outcome: target.cover === 'TOTAL' ? 'blocked' : 'hit',
    critical: false,
    rolledDamage: rawDamage,
    damage: target.cover === 'TOTAL' ? 0 : rawDamage,
  }));
}

/** Applies a user ruling on an unknown attack (hidden AC): a hit or critical hit rolls its damage. */
export async function ruleAttack(
  result: TargetResolution,
  outcome: 'hit' | 'critical' | 'miss',
  action: ResolvableAction,
  roll: DiceRoller,
): Promise<TargetResolution> {
  const critical = outcome === 'critical';
  const rolledDamage = outcome === 'miss' ? null : await rollDamage(action, critical, roll);
  return { ...result, outcome, critical, rolledDamage, damage: rolledDamage ?? 0 };
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
  if (pending?.kind !== 'area' || !point) return null;
  const data = CompendiumResolver.getDefault().get(pending.spellId)?.data;
  const area = data?.area as SpellArea | undefined;
  if (!area) return null;
  const casterId = casterTokenId(state, pending.actorId);
  const token = casterId ? (state?.tokens[casterId] ?? state?.public_tokens?.[casterId]) : undefined;
  const { cellPx } = boardMetrics(state);
  const feetPerCell = state?.feet_per_cell || 5;
  const caster = token?.top_left
    ? {
        center: { x: token.top_left.x + ((token.grid_w ?? 1) * cellPx) / 2, y: token.top_left.y + ((token.grid_h ?? 1) * cellPx) / 2 },
        radiusFt: ((token.grid_w ?? 1) * feetPerCell) / 2,
      }
    : null;
  return areaTemplate(area, point, caster, areaTemplateIdSignal.value, data?.concentration === true ? casterId : null);
}

/** Applies a user ruling on a save outcome: the damage follows `damageAfterSave`. */
export function ruleSave(result: TargetResolution, outcome: 'success' | 'failure', action: ResolvableAction): TargetResolution {
  return { ...result, outcome, damage: damageAfterSave(result.rolledDamage ?? 0, outcome, action.halfDamageOnSave) };
}

/** `true` once every target has a known outcome (Apply is blocked before). */
export function isReadyToApply(results: readonly TargetResolution[]): boolean {
  return results.length > 0 && results.every((r) => r.outcome !== 'unknown');
}
