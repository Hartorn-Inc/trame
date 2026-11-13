/**
 * ============================================================================
 * SPELL DAMAGE RESOLUTION RULES (spellResolution.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Reads how a spell's damage resolves from its compendium data: an attack
 * roll, a saving throw, an automatic hit (Magic Missile), a rider on a weapon
 * hit (Hex, Divine Smite) or a described effect the table resolves (Spike
 * Growth's movement damage, Teleport's mishap). Without it every damaging
 * spell that names no saving throw borrowed the spell attack bonus, so Magic
 * Missile rolled to hit and Power Word Kill rolled 12d12 on a d20.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `No Roll Means No Attack`:
 *      - Only `attackType` makes an attack roll. A damaging spell with neither
 *        `attackType` nor `saveAbility` is `automatic` or `rider` when its data
 *        says so (`damageResolution`), and `described` otherwise, including
 *        homebrew spells that do not carry the field.
 *   2. `Extra Parts Only When Dealt Together`:
 *      - `damageCombination: "all"` (Flame Strike) adds every later `damage`
 *        part to the roll; `"choice"` (Spirit Guardians) offers the part types
 *        as one chosen type. Without the field only the first part is dealt at
 *        once: later parts are timed or conditional (Acid Arrow, Vitriolic
 *        Sphere) and stay in the description.
 *   3. `Instances Resolve Separately`:
 *      - `instances` (beams, darts, rays) count at the caster's level for a
 *        cantrip (Eldritch Blast: 1, 2 at 5, 3 at 11, 4 at 17) or at the slot
 *        level (Magic Missile: 3, +1 per slot level above 1). The damage dice
 *        are one instance's dice and never scale with the cantrip tier.
 * ============================================================================
 */

import { UPCAST_DAMAGE_PATTERN, upcastDamageDice } from "./spellUpcast.ts";
import type { DamageType } from "./types.ts";

/** How a spell's damage resolves (banner invariant 1). */
export type SpellDamageResolution =
  /** Spell attack roll against AC (`attackType`). */
  | "attack"
  /** Saving throw against the spell save DC (`saveAbility`). */
  | "save"
  /** Hits without a roll (Magic Missile). */
  | "automatic"
  /** Extra damage on a weapon hit the caster already made (Hex, Divine Smite). */
  | "rider"
  /** Damage from a later trigger or to the caster; the table resolves it. */
  | "described";

/** Repeated beams, darts or rays of one spell (banner invariant 3). */
export interface SpellInstances {
  /** What one instance is called on the table. */
  unit: "beam" | "dart" | "ray";
  /** Instances at the spell's level (character level 1 for a cantrip). */
  count: number;
  /** Extra instances per slot level above the spell's level. */
  perSlotLevel?: number;
  /** Cantrip: `count` times the cantrip damage tier. */
  cantripScaling?: boolean;
}

/** One typed damage roll of a spell (`"5d6"` Radiant). */
export interface SpellDamagePart {
  dice: string;
  type: DamageType;
}

/** Spell compendium `data` as the resolution helpers read it. */
export type SpellData = Readonly<Record<string, unknown>>;

/**
 * How `data`'s damage resolves, `null` when the spell deals no damage
 * (no `damageDice`). See banner invariant 1.
 */
export function spellDamageResolution(data: SpellData): SpellDamageResolution | null {
  if (typeof data.damageDice !== "string") return null;
  if (typeof data.attackType === "string") return "attack";
  if (typeof data.saveAbility === "string") return "save";
  return data.damageResolution === "automatic" || data.damageResolution === "rider" ? data.damageResolution : "described";
}

/** Cantrip damage tier at `characterLevel`: `1`, `2` at 5, `3` at 11, `4` at 17. */
export function cantripTier(characterLevel: number): number {
  return 1 + (characterLevel >= 5 ? 1 : 0) + (characterLevel >= 11 ? 1 : 0) + (characterLevel >= 17 ? 1 : 0);
}

/** Instance rules of `data`, `undefined` for a spell resolved once. */
export function spellInstances(data: SpellData): SpellInstances | undefined {
  const instances = data.instances as SpellInstances | undefined;
  return instances && typeof instances.count === "number" ? instances : undefined;
}

/**
 * Number of separately resolved instances when cast by a character of
 * `characterLevel` with a slot of `castLevel` (the spell's level when omitted).
 * `1` for spells without `instances`.
 */
export function spellInstanceCount(data: SpellData, characterLevel: number, castLevel?: number): number {
  const instances = spellInstances(data);
  if (!instances) return 1;
  if (instances.cantripScaling) return instances.count * cantripTier(characterLevel);
  const level = typeof data.level === "number" ? data.level : 0;
  return instances.count + Math.max(0, (castLevel ?? level) - level) * (instances.perSlotLevel ?? 0);
}

/**
 * Damage parts of `data` beyond the primary one (banner invariant 2):
 * `extra` holds the parts dealt together with it, `typeOptions` the types a
 * caster picks from (the primary type first). Both are empty otherwise.
 */
export function spellDamageParts(data: SpellData): { extra: SpellDamagePart[]; typeOptions: DamageType[] } {
  const parts = (Array.isArray(data.damage) ? data.damage : []) as SpellDamagePart[];
  if (parts.length < 2) return { extra: [], typeOptions: [] };
  if (data.damageCombination === "all") return { extra: parts.slice(1), typeOptions: [] };
  if (data.damageCombination === "choice") return { extra: [], typeOptions: [...new Set(parts.map((part) => part.type))] };
  return { extra: [], typeOptions: [] };
}

/**
 * Dice of an extra damage part at `castLevel`: upcast only when the
 * higher-level text names the part's type next to the damage increase
 * (Flame Strike's "Fire damage and the Radiant damage increase"); Ice Storm
 * raises only its Bludgeoning damage, so its Cold part keeps its dice.
 */
export function upcastExtraPartDice(part: SpellDamagePart, higherLevel: string | undefined, castLevel: number): string {
  if (!higherLevel || !UPCAST_DAMAGE_PATTERN.test(higherLevel)) return part.dice;
  return new RegExp(`\\b${part.type} damage\\b`, "i").test(higherLevel) ? upcastDamageDice(part.dice, higherLevel, castLevel) : part.dice;
}
