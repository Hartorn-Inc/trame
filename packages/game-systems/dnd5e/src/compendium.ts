/**
 * ============================================================================
 * D&D 5E 3-TIER COMPENDIUM RESOLVER & SRD STARTER CONTENT (compendium.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Implements the 3-tier hierarchical compendium lookup and search engine
 * (`SYSTEM_SRD` < `INSTANCE_LIBRARY` < `CAMPAIGN_HOMEBREW`), along with
 * canonical CC-BY-4.0 SRD 5.1 attribution, starter spell/breath actions, and
 * the Adult Red Dragon reference boss sheet.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Strict 3-Tier Override Precedence`:
 *      - `CompendiumResolver.get(idOrSlug)` and `CompendiumResolver.list(query)`
 *        guarantee that `CAMPAIGN_HOMEBREW` entries shadow `INSTANCE_LIBRARY`
 *        entries, which in turn shadow base `SYSTEM_SRD` entries sharing the
 *        same `id` or `slug` without mutating the underlying SRD catalog.
 *   2. `Dual-Key Indexing`:
 *      - Every `CompendiumEntry` is indexed by both `id` and `slug` in each
 *        tier's internal lookup map for `O(1)` resolution, while `list()`
 *        deduplicates by `slug` in ascending precedence order before sorting
 *        alphabetically by `name`.
 *   3. `Mandatory CC-BY-4.0 Attribution`:
 *      - `SRD_51_ATTRIBUTION` and `CompendiumResolver.getAttribution()` expose
 *        the verbatim Wizards of the Coast SRD 5.1 Creative Commons legal notice.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `CompendiumResolver.list(query)`
 *     ├── 1. Populate `bySlug` map in order: `SYSTEM_SRD` -> `INSTANCE_LIBRARY` -> `CAMPAIGN_HOMEBREW`.
 *     ├── 2. Filter deduplicated entries by `query.entityType` if specified.
 *     ├── 3. Filter case-insensitively by `query.searchTerm` against `name` and `slug`.
 *     └── 4. Sort surviving entries lexicographically via `localeCompare`.
 * ============================================================================
 */

import type { ActionDefinition, Dnd5eActorSheet } from "./pipeline.ts";

/**
 * Hierarchical compendium storage layer ordered from lowest to highest precedence:
 * - `"SYSTEM_SRD"`: Built-in read-only SRD 5.1 baseline catalog.
 * - `"INSTANCE_LIBRARY"`: Server-wide shared custom content overriding `"SYSTEM_SRD"`.
 * - `"CAMPAIGN_HOMEBREW"`: Campaign-local overrides taking highest precedence.
 */
export type CompendiumTier = "SYSTEM_SRD" | "INSTANCE_LIBRARY" | "CAMPAIGN_HOMEBREW";

/**
 * Single entity record stored in one of the three compendium tiers.
 */
export interface CompendiumEntry {
  /** Globally unique identifier for this specific entry record. */
  id: string;
  /** Canonical URL/lookup slug shared across tiers when overriding an entity (e.g., `"fireball"`). */
  slug: string;
  /** Human-readable display name of the monster, spell, item, class, or feat. */
  name: string;
  /** Domain category of the compendium entry. */
  entityType: "monster" | "spell" | "item" | "class" | "feat";
  /** Authoritative tier from which this entry originates. */
  tier: CompendiumTier;
  /** Arbitrary system-specific payload describing stats, mechanics, or descriptions. */
  data: Record<string, unknown>;
  /** Optional ID of the upstream entry in a lower tier that this entry overrides. */
  overrideEntityId?: string;
}

/**
 * Filter criteria for `CompendiumResolver.list()`.
 */
export interface CompendiumQuery {
  /** Case-insensitive substring matched against `entry.name` or `entry.slug`. */
  searchTerm?: string;
  /** Optional entity category filter. */
  entityType?: "monster" | "spell" | "item" | "class" | "feat";
}

/**
 * Verbatim Creative Commons Attribution 4.0 International (CC-BY-4.0) legal notice
 * required when distributing D&D 5e SRD 5.1 Open Game Content.
 */
export const SRD_51_ATTRIBUTION =
  'This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode.';

/**
 * Three-tier compendium lookup and query engine enforcing
 * `CAMPAIGN_HOMEBREW > INSTANCE_LIBRARY > SYSTEM_SRD` precedence.
 */
export class CompendiumResolver {
  private readonly systemSrd: Map<string, CompendiumEntry>;
  private readonly instanceLibrary: Map<string, CompendiumEntry>;
  private readonly campaignHomebrew: Map<string, CompendiumEntry>;

  /**
   * Indexes the three compendium tiers by both `id` and `slug` for `O(1)` lookup.
   */
  constructor(
    systemSrd: CompendiumEntry[],
    instanceLibrary: CompendiumEntry[] = [],
    campaignHomebrew: CompendiumEntry[] = []
  ) {
    this.systemSrd = new Map();
    for (const e of systemSrd) {
      this.systemSrd.set(e.id, e);
      this.systemSrd.set(e.slug, e);
    }
    this.instanceLibrary = new Map();
    for (const e of instanceLibrary) {
      this.instanceLibrary.set(e.id, e);
      this.instanceLibrary.set(e.slug, e);
    }
    this.campaignHomebrew = new Map();
    for (const e of campaignHomebrew) {
      this.campaignHomebrew.set(e.id, e);
      this.campaignHomebrew.set(e.slug, e);
    }
  }

  /**
   * Resolves a single compendium entry by `id` or `slug`, checking
   * `CAMPAIGN_HOMEBREW` first, then `INSTANCE_LIBRARY`, and finally `SYSTEM_SRD`.
   */
  public get(idOrSlug: string): CompendiumEntry | undefined {
    if (this.campaignHomebrew.has(idOrSlug)) {
      return this.campaignHomebrew.get(idOrSlug);
    }
    if (this.instanceLibrary.has(idOrSlug)) {
      return this.instanceLibrary.get(idOrSlug);
    }
    if (this.systemSrd.has(idOrSlug)) {
      return this.systemSrd.get(idOrSlug);
    }
    return undefined;
  }

  /**
   * Lists all compendium entries deduplicated by `slug` according to tier
   * precedence, optionally filtered by `entityType` and `searchTerm`, and
   * sorted alphabetically by `name`.
   */
  public list(query?: CompendiumQuery): CompendiumEntry[] {
    const bySlug = new Map<string, CompendiumEntry>();
    for (const entry of this.systemSrd.values()) {
      bySlug.set(entry.slug, entry);
    }
    for (const entry of this.instanceLibrary.values()) {
      bySlug.set(entry.slug, entry);
    }
    for (const entry of this.campaignHomebrew.values()) {
      bySlug.set(entry.slug, entry);
    }

    let entries = Array.from(bySlug.values());

    if (query?.entityType) {
      entries = entries.filter((e) => e.entityType === query.entityType);
    }

    if (query?.searchTerm && query.searchTerm.trim().length > 0) {
      const term = query.searchTerm.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.name.toLowerCase().includes(term) ||
          e.slug.toLowerCase().includes(term)
      );
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  /**
   * Returns the mandatory SRD 5.1 CC-BY-4.0 attribution text.
   */
  public getAttribution(): string {
    return SRD_51_ATTRIBUTION;
  }
}

/**
 * Starter SRD 5.1 action definitions (`fireball`, `hold_person`, `fire_breath`)
 * used by combat encounter pipelines and automated integration tests.
 */
export const SRD_STARTER_ACTIONS: Record<string, ActionDefinition> = {
  fireball: {
    id: "fireball",
    name: "Fireball",
    resourceCostId: "spell_slot_3",
    resolutionKind: "saving_throw",
    saveAbility: "dex",
    halfDamageOnSave: true,
    baseDamage: 28,
    upcastRule: {
      baseSlotLevel: 3,
      extraDamagePerSlot: 3.5,
    },
  },
  hold_person: {
    id: "hold_person",
    name: "Hold Person",
    resourceCostId: "spell_slot_2",
    resolutionKind: "saving_throw",
    saveAbility: "wis",
    halfDamageOnSave: false,
    baseDamage: 0,
    applyConditionOnFail: "Paralyzed",
  },
  fire_breath: {
    id: "fire_breath",
    name: "Fire Breath (Recharge 5-6)",
    resourceCostId: "fire_breath",
    resolutionKind: "saving_throw",
    saveAbility: "dex",
    halfDamageOnSave: true,
    baseDamage: 63,
  },
};

/**
 * Constructs a pre-populated SRD 5.1 Adult Red Dragon (`CR 17`, `256 HP`, `AC 19`)
 * `Dnd5eActorSheet` equipped with `3/Day` Legendary Resistance and `Recharge 5-6` Fire Breath.
 */
export function createAdultRedDragonSheet(id = "npc-adult-red-dragon"): Dnd5eActorSheet {
  return {
    id,
    name: "Adult Red Dragon",
    level: 17,
    spellcastingAbility: "cha",
    abilities: { str: 27, dex: 10, con: 25, int: 16, wis: 13, cha: 21 },
    saveProficiencies: { dex: true, con: true, wis: true, cha: true },
    skillProficiencies: { perception: "expertise", stealth: "proficient" },
    armorKind: "heavy",
    armorBaseAc: 19,
    hasShield: false,
    hpCurrent: 256,
    hpMax: 256,
    tempHp: 0,
    hitDiceCurrent: 19,
    hitDiceMax: 19,
    hitDieSides: 12,
    exhaustionLevel: 0,
    conditions: [],
    resources: {
      legendary_resistance: {
        id: "legendary_resistance",
        label: "Legendary Resistance (3/Day)",
        current: 3,
        max: 3,
        recovery: "long_rest",
      },
      fire_breath: {
        id: "fire_breath",
        label: "Fire Breath (Recharge 5-6)",
        current: 1,
        max: 1,
        recovery: "recharge",
        rechargeMinD6: 5,
      },
    },
    deathSaves: { successes: 0, failures: 0, isStable: false, isDead: false },
  };
}
