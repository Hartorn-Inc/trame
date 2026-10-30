/**
 * ============================================================================
 * D&D 5E CORE DOMAIN TYPES & STATE CONTRACTS (types.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Defines the canonical TypeScript domain types, enumerations, and actor data
 * contracts for Dungeons & Dragons 5th Edition (SRD 5.1 CC-BY-4.0) within TRAME.
 * Without this shared contract layer, derived-stat evaluation, combat damage
 * mitigation, rest recovery, and compendium resolution would lack compile-time
 * type parity across client sheets and server-side pipelines.
 *
 * Open Game Content Attribution:
 * This work includes material taken from the System Reference Document 5.1 ("SRD 5.1")
 * by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document.
 * The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License
 * available at https://creativecommons.org/licenses/by/4.0/legalcode.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Closed Domain Enumerations`:
 *      - Ability identifiers (`AbilityId`), skill identifiers (`SkillId`),
 *        damage types (`DamageType`), and mitigation levels (`MitigationLevel`)
 *        are strictly bounded string union types, preventing silent typos in
 *        DAG formula dependencies or damage calculation lookups.
 *   2. `Numeric Proficiency Multipliers`:
 *      - `ProficiencyRank` constrains numeric skill multipliers to `0`
 *        (untrained), `1` (proficient), or `2` (expertise).
 *   3. `Deterministic Condition Expiry`:
 *      - `ActiveConditionState` pairs a non-negative `durationRounds` counter
 *        with an explicit `TurnTrigger` (`ROUNDS`, `TURNS_START`, `TURNS_END`)
 *        and optional source actor ID so round/turn transitions remain
 *        deterministic across combat ticks.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   1. Actor sheets and NPC templates instantiate `Dnd5eActorData`.
 *   2. `manifest.ts` reads ability, skill, and armor fields to project derived stats.
 *   3. `pipeline.ts` and `progression.ts` immutably clone and transition
 *      `Dnd5eActorData` across combat damage, rests, and level-up boundaries.
 * ============================================================================
 */

/**
 * Canonical six core ability score identifiers in D&D 5e:
 * - `"str"`: Strength
 * - `"dex"`: Dexterity
 * - `"con"`: Constitution
 * - `"int"`: Intelligence
 * - `"wis"`: Wisdom
 * - `"cha"`: Charisma
 */
export type AbilityId = "str" | "dex" | "con" | "int" | "wis" | "cha";

/**
 * Canonical eighteen skill identifiers in D&D 5e (SRD 5.1).
 * Each skill maps deterministically to a governing `AbilityId` in `DND5E_SKILLS`.
 */
export type SkillId =
  | "acrobatics"
  | "animal_handling"
  | "arcana"
  | "athletics"
  | "deception"
  | "history"
  | "insight"
  | "intimidation"
  | "investigation"
  | "medicine"
  | "nature"
  | "perception"
  | "performance"
  | "persuasion"
  | "religion"
  | "sleight_of_hand"
  | "stealth"
  | "survival";

/**
 * Numeric proficiency rank multiplier applied to the actor's proficiency bonus:
 * - `0`: Untrained (`0 * proficiencyBonus`)
 * - `1`: Proficient (`1 * proficiencyBonus`)
 * - `2`: Expertise (`2 * proficiencyBonus`)
 */
export type ProficiencyRank = 0 | 1 | 2;

/**
 * Canonical thirteen damage types defined by the D&D 5e SRD 5.1 combat rules.
 * Used to index into `Dnd5eActorData.damageMitigations` during damage resolution.
 */
export type DamageType =
  | "acid"
  | "bludgeoning"
  | "cold"
  | "fire"
  | "force"
  | "lightning"
  | "necrotic"
  | "piercing"
  | "poison"
  | "psychic"
  | "radiant"
  | "slashing"
  | "thunder";

/**
 * Damage modification tier for a specific `DamageType`:
 * - `"IMMUNE"`: Reduces incoming damage of that type to `0`.
 * - `"RESISTANT"`: Halves incoming damage of that type (rounded down via `Math.floor`).
 * - `"VULNERABLE"`: Doubles incoming damage of that type (`amount * 2`).
 * - `"NONE"`: Applies unmodified damage (`amount * 1`).
 */
export type MitigationLevel = "IMMUNE" | "RESISTANT" | "VULNERABLE" | "NONE";

/**
 * Recovery cadence selector for expendable class features and resource pools:
 * - `"SHORT_REST"`: Pool replenishes to `max` on both short and long rests.
 * - `"LONG_REST"`: Pool replenishes to `max` only upon completing a long rest.
 */
export type RestType = "SHORT_REST" | "LONG_REST";

/**
 * Combat initiative boundary that decrements an `ActiveConditionState` duration:
 * - `"ROUNDS"`: Decrements once per full combat round boundary.
 * - `"TURNS_START"`: Decrements at the start of `appliedTurnActorId`'s turn.
 * - `"TURNS_END"`: Decrements at the end of `appliedTurnActorId`'s turn.
 */
export type TurnTrigger = "ROUNDS" | "TURNS_START" | "TURNS_END";

/**
 * Bounded expendable resource pool (e.g., Ki Points, Action Surge, Rage uses).
 */
export interface ResourcePool {
  /** Remaining available uses in the range `0..=max`. */
  current: number;
  /** Maximum capacity restored upon completing `resetOn`. */
  max: number;
  /** Rest boundary that resets `current` back to `max`. */
  resetOn: RestType;
}

/**
 * Death saving throw tally tracked while an actor is at `0` Hit Points.
 */
export interface DeathSavesState {
  /** Accumulated death save successes in the range `0..=3` (`3` stabilizes). */
  successes: number;
  /** Accumulated death save failures in the range `0..=3` (`3` causes death). */
  failures: number;
}

/**
 * Active status condition affixed to an actor during combat or exploration.
 */
export interface ActiveConditionState {
  /** Canonical machine identifier for the condition (e.g., `"unconscious"`, `"paralyzed"`). */
  id: string;
  /** Human-readable display label for the condition badge. */
  name: string;
  /** Remaining duration measured in combat rounds (`>= 1` while active). */
  durationRounds: number;
  /** Optional actor ID whose turn boundary drives `"TURNS_START"` or `"TURNS_END"` expiry. */
  appliedTurnActorId?: string;
  /** Initiative lifecycle hook that decrements `durationRounds`. */
  trigger: TurnTrigger;
}

/**
 * Available and maximum spell slots for a single spell level or Pact Magic pool.
 */
export interface SpellSlotTier {
  /** Currently unexpended spell slots (`0..=max`). */
  current: number;
  /** Total spell slots granted at the actor's current caster level (`>= 0`). */
  max: number;
}

/**
 * Complete spell slot allocation across levels 1 through 9 plus Warlock Pact Magic.
 */
export interface SpellSlotsState {
  /** 1st-level spell slot pool. */
  level1?: SpellSlotTier;
  /** 2nd-level spell slot pool. */
  level2?: SpellSlotTier;
  /** 3rd-level spell slot pool. */
  level3?: SpellSlotTier;
  /** 4th-level spell slot pool. */
  level4?: SpellSlotTier;
  /** 5th-level spell slot pool. */
  level5?: SpellSlotTier;
  /** 6th-level spell slot pool. */
  level6?: SpellSlotTier;
  /** 7th-level spell slot pool. */
  level7?: SpellSlotTier;
  /** 8th-level spell slot pool. */
  level8?: SpellSlotTier;
  /** 9th-level spell slot pool. */
  level9?: SpellSlotTier;
  /** Warlock Pact Magic slot pool (replenished on `"SHORT_REST"` or `"LONG_REST"`). */
  pact?: SpellSlotTier;
}

/**
 * Authoritative D&D 5e actor state record used by the damage, rest, and progression pipelines.
 */
export interface Dnd5eActorData {
  /** Unique identifier of the actor instance within the campaign. */
  id: string;
  /** Display name of the character, NPC, or monster. */
  name: string;
  /** Actor classification controlling sheet presentation and NPC rules. */
  type: "character" | "npc" | "monster";
  /** Map of the six core ability scores (`1..=30`) and saving throw proficiencies. */
  abilities: Record<AbilityId, { score: number; saveProficiency: boolean }>;
  /** Map of the eighteen canonical skills with their governing ability and proficiency rank. */
  skills: Record<SkillId, { ability: AbilityId; proficiencyRank: ProficiencyRank }>;
  /** Core combat vitality, level progression, armor, and spellcasting attributes. */
  attributes: {
    /** Character or monster challenge/caster level clamped to `1..=20` for proficiency math. */
    level: number;
    /** Hit Point vitality pools. */
    hp: {
      /** Current Hit Points in the range `0..=max`. */
      current: number;
      /** Maximum Hit Points (`>= 1`). */
      max: number;
      /** Temporary Hit Points (`>= 0`) that absorb damage prior to `current`. */
      temp: number;
    };
    /** Total Hit Dice capacity (typically equal to `level`, `>= 1`). */
    hitDiceMax: number;
    /** Unspent Hit Dice available for short-rest healing (`0..=hitDiceMax`). */
    hitDiceCurrent: number;
    /** Number of faces on the class Hit Die (e.g., `6`, `8`, `10`, `12`). */
    hitDieSize: number;
    /** Current exhaustion level (`0..=6`). */
    exhaustion: number;
    /** Death saving throw counters while at `0` HP. */
    deathSaves: DeathSavesState;
    /** Primary ability used to compute Spell Save DC and Spell Attack Bonus. */
    spellcastingAbility?: AbilityId;
    /** Base Armor Class provided by equipped armor or natural armor (defaults to `10`). */
    baseArmorAC?: number;
    /** Additive Armor Class bonus from an equipped shield (e.g., `+2`, defaults to `0`). */
    shieldBonus?: number;
    /** Equipped armor category determining how much Dexterity modifier applies to AC. */
    armorType?: "none" | "light" | "medium" | "heavy";
  };
  /** Per-damage-type immunity, resistance, vulnerability, or normal mitigation lookup. */
  damageMitigations: Record<DamageType, MitigationLevel>;
  /** Active status conditions currently affecting the actor. */
  conditions: ActiveConditionState[];
  /** Named class/monster resource pools indexed by resource key. */
  resources?: Record<string, ResourcePool>;
  /** Spell slot pools across standard spell levels 1–9 and Pact Magic. */
  spellSlots?: SpellSlotsState;
  /** Identifier of the spell currently maintained via Concentration, if any. */
  concentratingOnSpellId?: string;
  /** Whether the actor has suffered instant death or accumulated 3 death save failures. */
  isDead?: boolean;
}
