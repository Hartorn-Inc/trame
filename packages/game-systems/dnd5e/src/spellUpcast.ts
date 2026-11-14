/**
 * ============================================================================
 * SPELL UPCAST DAMAGE SCALING (spellUpcast.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * A spell cast with a higher-level slot deals the extra damage its SRD 5.2.1
 * "Using a Higher-Level Spell Slot" text grants ("The damage increases by
 * 1d6 for each spell slot level above 1."). Without this, an upcast Burning
 * Hands rolled the level-1 dice while spending a level-3 slot.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Structured Text Only`:
 *    - Only the per-slot damage sentence is read (`UPCAST_DAMAGE_PATTERN`,
 *      including "Both types of damage increase by" and a parenthetical such
 *      as "(both initial and later)"). Other scaling (more darts or rays,
 *      longer durations, two separate clauses) is left as written: the base
 *      dice are returned unchanged rather than guessed.
 * 2. `Never Below The Base`:
 *    - A cast level at or below the sentence's threshold returns the base
 *      dice; the extra count is `(castLevel - threshold) * perLevel`.
 * 3. `Same Die Merges`:
 *    - The extra dice join the first term with the same die (`3d6` + `2d6` =
 *      `5d6`); otherwise they are appended (`1d4 + 1` + `1d4` stays readable).
 * ============================================================================
 */

/** "The damage increases by 1d6 for each spell slot level above 1." and its SRD variants. */
export const UPCAST_DAMAGE_PATTERN = /damage(?: \([^)]*\))? increases? by (\d+)d(\d+) for each spell slot level above (\d+)/i;

/**
 * Damage dice of a spell cast at `castLevel`: `baseDice` plus the extra dice
 * its `higherLevel` text grants per slot level (invariants 1 to 3).
 */
export function upcastDamageDice(baseDice: string, higherLevel: string | undefined, castLevel: number): string {
  const match = higherLevel ? UPCAST_DAMAGE_PATTERN.exec(higherLevel) : null;
  if (!match || !baseDice) return baseDice;
  const [, perLevel, sides, threshold] = match;
  const extra = (castLevel - Number(threshold)) * Number(perLevel);
  if (extra <= 0) return baseDice;
  const sameDie = new RegExp(`(^|[^\\d])(\\d+)d${sides}(?!\\d)`);
  if (sameDie.test(baseDice)) return baseDice.replace(sameDie, (_, lead: string, count: string) => `${lead}${Number(count) + extra}d${sides}`);
  return `${baseDice} + ${extra}d${sides}`;
}
