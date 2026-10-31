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
 * Localized display metadata providing bilingual name and descriptions.
 */
export interface LocalizedDisplayMetadata {
  /** Localized display label for the compendium item. */
  name: string;
  /** Localized description text describing properties, mechanics, or lore. */
  description: string;
  [key: string]: unknown;
}

/**
 * Canonical domain category identifier for compendium entities.
 */
export type CompendiumEntityType =
  | "monster"
  | "spell"
  | "item"
  | "class"
  | "subclass"
  | "feat"
  | "weapon"
  | "armor";

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
  entityType: CompendiumEntityType;
  /** Authoritative tier from which this entry originates. */
  tier: CompendiumTier;
  /** Arbitrary system-specific payload describing stats, mechanics, or descriptions. */
  data: Record<string, unknown>;
  /** Optional ID of the upstream entry in a lower tier that this entry overrides. */
  overrideEntityId?: string;
  /** Non-breaking optional bilingual localization metadata. */
  i18n?: {
    en: LocalizedDisplayMetadata;
    fr: LocalizedDisplayMetadata;
  };
  /** Container tare weight in pounds (also accessible via data.weight). */
  weight?: number;
  /** Container carrying capacity in pounds (also accessible via data.capacity). */
  capacity?: number;
  /** Contents weight multiplier (0 for weightless containers like Bag of Holding, 1 for normal). */
  contentWeightMultiplier?: number;
}

/**
 * Filter criteria for `CompendiumResolver.list()`.
 */
export interface CompendiumQuery {
  /** Case-insensitive substring matched against `entry.name` or `entry.slug`. */
  searchTerm?: string;
  /** Optional entity category filter. */
  entityType?: CompendiumEntityType | string;
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
  private static defaultInstance: CompendiumResolver | null = null;

  private readonly systemSrd: Map<string, CompendiumEntry>;
  private readonly instanceLibrary: Map<string, CompendiumEntry>;
  private readonly campaignHomebrew: Map<string, CompendiumEntry>;

  /**
   * Returns the singleton baseline resolver loaded with `SYSTEM_SRD`.
   */
  public static getDefault(): CompendiumResolver {
    if (!CompendiumResolver.defaultInstance) {
      CompendiumResolver.defaultInstance = new CompendiumResolver(SYSTEM_SRD);
    }
    return CompendiumResolver.defaultInstance;
  }

  /**
   * Static helper resolving an entry by `id` or `slug` from the default `SYSTEM_SRD` compendium.
   */
  public static get(idOrSlug: string): CompendiumEntry | undefined {
    return CompendiumResolver.getDefault().get(idOrSlug);
  }

  /**
   * Static helper listing entries from the default `SYSTEM_SRD` compendium.
   */
  public static list(query?: CompendiumQuery): CompendiumEntry[] {
    return CompendiumResolver.getDefault().list(query);
  }

  /**
   * Static helper returning the mandatory SRD 5.1 CC-BY-4.0 notice.
   */
  public static getAttribution(): string {
    return SRD_51_ATTRIBUTION;
  }

  /**
   * Static helper returning subclasses from the default `SYSTEM_SRD` compendium.
   */
  public static getSubclasses(classId?: string): CompendiumEntry[] {
    return CompendiumResolver.getDefault().getSubclasses(classId);
  }

  /**
   * Static helper returning feats from the default `SYSTEM_SRD` compendium.
   */
  public static getFeats(): CompendiumEntry[] {
    return CompendiumResolver.getDefault().getFeats();
  }

  /**
   * Static helper returning spells filtered by spell circle and optional class identifier.
   */
  public static getSpellsByLevel(level: number, classId?: string): CompendiumEntry[] {
    return CompendiumResolver.getDefault().getSpellsByLevel(level, classId);
  }

  /**
   * Indexes the three compendium tiers by both `id` and `slug` for `O(1)` lookup.
   * Defaults `systemSrd` to `SYSTEM_SRD` when omitted.
   */
  constructor(
    systemSrd: CompendiumEntry[] = SYSTEM_SRD,
    instanceLibrary: CompendiumEntry[] = [],
    campaignHomebrew: CompendiumEntry[] = []
  ) {
    this.systemSrd = new Map();
    for (const e of systemSrd) {
      this.indexEntry(this.systemSrd, e);
    }
    this.instanceLibrary = new Map();
    for (const e of instanceLibrary) {
      this.indexEntry(this.instanceLibrary, e);
    }
    this.campaignHomebrew = new Map();
    for (const e of campaignHomebrew) {
      this.indexEntry(this.campaignHomebrew, e);
    }
  }

  private indexEntry(map: Map<string, CompendiumEntry>, e: CompendiumEntry): void {
    map.set(e.id, e);
    map.set(e.slug, e);
    if (e.slug.startsWith("srd:")) {
      const parts = e.slug.split(":");
      const shortSlug = parts[parts.length - 1];
      if (!map.has(shortSlug)) {
        map.set(shortSlug, e);
      }
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

    const fallbackPrefixes = [
      `srd:item:${idOrSlug}`,
      `srd:spell:${idOrSlug}`,
      `srd:feat:${idOrSlug}`,
      `srd:monster:${idOrSlug}`,
      `srd:subclass:${idOrSlug}`,
      `srd:class:${idOrSlug}`,
    ];
    for (const prefixed of fallbackPrefixes) {
      if (this.campaignHomebrew.has(prefixed)) return this.campaignHomebrew.get(prefixed);
      if (this.instanceLibrary.has(prefixed)) return this.instanceLibrary.get(prefixed);
      if (this.systemSrd.has(prefixed)) return this.systemSrd.get(prefixed);
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
      entries = entries.filter((e) => {
        if (e.entityType === query.entityType) return true;
        if (query.entityType === "item" && (e.entityType === "weapon" || e.entityType === "armor")) {
          return true;
        }
        if (query.entityType === "weapon" && (e.entityType === "weapon" || e.data?.itemType === "weapon" || e.data?.category === "weapon")) {
          return true;
        }
        if (query.entityType === "armor" && (e.entityType === "armor" || e.data?.itemType === "armor" || e.data?.category === "armor")) {
          return true;
        }
        return false;
      });
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

  /**
   * Queries subclasses recorded in the compendium, optionally scoped to a parent class.
   */
  public getSubclasses(classId?: string): CompendiumEntry[] {
    const list = this.list({ entityType: "subclass" });
    if (!classId) return list;
    const clean = classId.replace(/^srd:class:/, "").toLowerCase();
    return list.filter((e) => {
      const entryClassId = String(e.data?.classId ?? e.data?.class ?? "").toLowerCase();
      return entryClassId === clean;
    });
  }

  /**
   * Queries all feats available in the compendium.
   */
  public getFeats(): CompendiumEntry[] {
    return this.list({ entityType: "feat" });
  }

  /**
   * Queries all spells of a given spell level, optionally filtered by spellcasting class.
   */
  public getSpellsByLevel(level: number, classId?: string): CompendiumEntry[] {
    const spells = this.list({ entityType: "spell" }).filter(
      (e) => e.data?.level === level
    );
    if (!classId) return spells;
    const clean = classId.replace(/^srd:class:/, "").toLowerCase();
    return spells.filter((e) => {
      const classes = e.data?.classes;
      if (Array.isArray(classes)) {
        return classes.map((c) => String(c).toLowerCase()).includes(clean);
      }
      return true;
    });
  }
}

/**
 * Helper query retrieving subclasses from a compendium resolver (or default SystemSRD).
 */
export function getSubclasses(
  classId?: string,
  resolver?: CompendiumResolver
): CompendiumEntry[] {
  return (resolver ?? CompendiumResolver.getDefault()).getSubclasses(classId);
}

/**
 * Helper query retrieving feats from a compendium resolver (or default SystemSRD).
 */
export function getFeats(resolver?: CompendiumResolver): CompendiumEntry[] {
  return (resolver ?? CompendiumResolver.getDefault()).getFeats();
}

/**
 * Helper query retrieving spells by spell circle from a compendium resolver (or default SystemSRD).
 */
export function getSpellsByLevel(
  level: number,
  classId?: string,
  resolver?: CompendiumResolver
): CompendiumEntry[] {
  return (resolver ?? CompendiumResolver.getDefault()).getSpellsByLevel(level, classId);
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
 * Canonical System Reference Document 5.1 baseline entities (weapons, armor, containers, spells, feats, and monsters).
 */
export const SYSTEM_SRD: CompendiumEntry[] = [
  // ==========================================================================
  // 1. CONTAINERS
  // ==========================================================================
  {
    id: "srd:item:backpack",
    slug: "srd:item:backpack",
    name: "Backpack",
    entityType: "item",
    tier: "SYSTEM_SRD",
    weight: 5,
    capacity: 30,
    contentWeightMultiplier: 1,
    data: {
      weight: 5,
      unitWeight: 5,
      capacity: 30,
      contentWeightMultiplier: 1,
      weightMultiplier: 1,
      isContainer: true,
      itemType: "container",
      cost: "2 gp",
    },
    i18n: {
      en: {
        name: "Backpack",
        description:
          "A cloth or leather pack strapped to the back, capable of holding up to 30 pounds of gear within 1.5 cubic feet.",
      },
      fr: {
        name: "Sac à dos",
        description:
          "Un sac en toile ou en cuir porté sur le dos, pouvant contenir jusqu'à 30 livres (15 kg) d'équipement dans un volume de 40 litres.",
      },
    },
  },
  {
    id: "srd:item:bag_of_holding",
    slug: "srd:item:bag_of_holding",
    name: "Bag of Holding",
    entityType: "item",
    tier: "SYSTEM_SRD",
    weight: 15,
    capacity: 500,
    contentWeightMultiplier: 0,
    data: {
      weight: 15,
      unitWeight: 15,
      capacity: 500,
      contentWeightMultiplier: 0,
      weightMultiplier: 0,
      isContainer: true,
      itemType: "container",
      rarity: "uncommon",
      magic: true,
    },
    i18n: {
      en: {
        name: "Bag of Holding",
        description:
          "This bag has an interior space considerably larger than its outside dimensions. It can hold up to 500 pounds, not exceeding a volume of 64 cubic feet. The bag always weighs 15 pounds, regardless of its contents.",
      },
      fr: {
        name: "Sac sans fond",
        description:
          "Ce sac possède un espace intérieur bien plus grand que ses dimensions extérieures. Il peut contenir jusqu'à 250 kg dans un volume de 1,8 mètre cube. Le sac pèse toujours 7,5 kg (15 livres), quel que soit son contenu.",
      },
    },
  },

  // ==========================================================================
  // 2. WEAPONS
  // ==========================================================================
  {
    id: "srd:item:dagger",
    slug: "srd:item:dagger",
    name: "Dagger",
    entityType: "weapon",
    tier: "SYSTEM_SRD",
    weight: 1,
    data: {
      itemType: "weapon",
      category: "simple",
      damage: "1d4",
      damageType: "piercing",
      properties: ["finesse", "light", "thrown"],
      range: "20/60",
      weight: 1,
      cost: "2 gp",
    },
    i18n: {
      en: {
        name: "Dagger",
        description:
          "A simple melee weapon with finesse, light, and thrown properties (range 20/60), dealing 1d4 piercing damage.",
      },
      fr: {
        name: "Dague",
        description:
          "Une arme de corps à corps courante avec les propriétés finesse, légère et lancer (portée 6/18 m), infligeant 1d4 dégâts perforants.",
      },
    },
  },
  {
    id: "srd:item:longsword",
    slug: "srd:item:longsword",
    name: "Longsword",
    entityType: "weapon",
    tier: "SYSTEM_SRD",
    weight: 3,
    data: {
      itemType: "weapon",
      category: "martial",
      damage: "1d8",
      versatileDamage: "1d10",
      damageType: "slashing",
      properties: ["versatile"],
      weight: 3,
      cost: "15 gp",
    },
    i18n: {
      en: {
        name: "Longsword",
        description:
          "A versatile martial melee weapon dealing 1d8 slashing damage (1d10 two-handed).",
      },
      fr: {
        name: "Épée longue",
        description:
          "Une arme de corps à corps de guerre polyvalente infligeant 1d8 dégâts tranchants (1d10 à deux mains).",
      },
    },
  },
  {
    id: "srd:item:greatsword",
    slug: "srd:item:greatsword",
    name: "Greatsword",
    entityType: "weapon",
    tier: "SYSTEM_SRD",
    weight: 6,
    data: {
      itemType: "weapon",
      category: "martial",
      damage: "2d6",
      damageType: "slashing",
      properties: ["heavy", "two-handed"],
      weight: 6,
      cost: "50 gp",
    },
    i18n: {
      en: {
        name: "Greatsword",
        description:
          "A massive two-handed martial melee weapon dealing 2d6 slashing damage.",
      },
      fr: {
        name: "Épée à deux mains",
        description:
          "Une imposante arme de corps à corps de guerre à deux mains infligeant 2d6 dégâts tranchants.",
      },
    },
  },
  {
    id: "srd:item:shortbow",
    slug: "srd:item:shortbow",
    name: "Shortbow",
    entityType: "weapon",
    tier: "SYSTEM_SRD",
    weight: 2,
    data: {
      itemType: "weapon",
      category: "simple",
      damage: "1d6",
      damageType: "piercing",
      properties: ["ammunition", "two-handed"],
      range: "80/320",
      weight: 2,
      cost: "25 gp",
    },
    i18n: {
      en: {
        name: "Shortbow",
        description:
          "A simple ranged weapon dealing 1d6 piercing damage (range 80/320).",
      },
      fr: {
        name: "Arc court",
        description:
          "Une arme à distance courante infligeant 1d6 dégâts perforants (portée 24/96 m).",
      },
    },
  },
  {
    id: "srd:item:longbow",
    slug: "srd:item:longbow",
    name: "Longbow",
    entityType: "weapon",
    tier: "SYSTEM_SRD",
    weight: 2,
    data: {
      itemType: "weapon",
      category: "martial",
      damage: "1d8",
      damageType: "piercing",
      properties: ["ammunition", "heavy", "two-handed"],
      range: "150/600",
      weight: 2,
      cost: "50 gp",
    },
    i18n: {
      en: {
        name: "Longbow",
        description:
          "A powerful martial ranged weapon dealing 1d8 piercing damage (range 150/600).",
      },
      fr: {
        name: "Arc long",
        description:
          "Une puissante arme à distance de guerre infligeant 1d8 dégâts perforants (portée 45/180 m).",
      },
    },
  },
  {
    id: "srd:item:light_crossbow",
    slug: "srd:item:light_crossbow",
    name: "Light Crossbow",
    entityType: "weapon",
    tier: "SYSTEM_SRD",
    weight: 5,
    data: {
      itemType: "weapon",
      category: "simple",
      damage: "1d8",
      damageType: "piercing",
      properties: ["ammunition", "loading", "two-handed"],
      range: "80/320",
      weight: 5,
      cost: "25 gp",
    },
    i18n: {
      en: {
        name: "Light Crossbow",
        description:
          "A simple ranged weapon dealing 1d8 piercing damage with loading property (range 80/320).",
      },
      fr: {
        name: "Arbalète légère",
        description:
          "Une arme à distance courante infligeant 1d8 dégâts perforants avec propriété chargement (portée 24/96 m).",
      },
    },
  },

  // ==========================================================================
  // 3. ARMOR
  // ==========================================================================
  {
    id: "srd:item:leather_armor",
    slug: "srd:item:leather_armor",
    name: "Leather Armor",
    entityType: "armor",
    tier: "SYSTEM_SRD",
    weight: 10,
    data: {
      itemType: "armor",
      category: "light",
      armorClass: 11,
      dexBonus: true,
      maxDexBonus: null,
      weight: 10,
      cost: "10 gp",
      stealthDisadvantage: false,
    },
    i18n: {
      en: {
        name: "Leather Armor",
        description:
          "Light armor made from supple, carefully cured leather. AC 11 + Dex modifier.",
      },
      fr: {
        name: "Armure de cuir",
        description:
          "Armure légère confectionnée en cuir souple et tanné. CA 11 + modificateur de Dex.",
      },
    },
  },
  {
    id: "srd:item:scale_mail",
    slug: "srd:item:scale_mail",
    name: "Scale Mail",
    entityType: "armor",
    tier: "SYSTEM_SRD",
    weight: 45,
    data: {
      itemType: "armor",
      category: "medium",
      armorClass: 14,
      dexBonus: true,
      maxDexBonus: 2,
      weight: 45,
      cost: "50 gp",
      stealthDisadvantage: true,
    },
    i18n: {
      en: {
        name: "Scale Mail",
        description:
          "Medium armor made of overlapping pieces of steel. AC 14 + Dex modifier (max 2), disadvantage on Stealth.",
      },
      fr: {
        name: "Armure d'écailles",
        description:
          "Armure intermédiaire faite d'écailles de métal superposées. CA 14 + modificateur de Dex (max 2), désavantage en Discrétion.",
      },
    },
  },
  {
    id: "srd:item:chain_mail",
    slug: "srd:item:chain_mail",
    name: "Chain Mail",
    entityType: "armor",
    tier: "SYSTEM_SRD",
    weight: 55,
    data: {
      itemType: "armor",
      category: "heavy",
      armorClass: 16,
      dexBonus: false,
      strengthRequirement: 13,
      weight: 55,
      cost: "75 gp",
      stealthDisadvantage: true,
    },
    i18n: {
      en: {
        name: "Chain Mail",
        description:
          "Heavy armor made of interlocking metal rings. AC 16, requires Str 13, disadvantage on Stealth.",
      },
      fr: {
        name: "Cotte de mailles",
        description:
          "Armure lourde faite d'anneaux métalliques entrelacés. CA 16, requiert For 13, désavantage en Discrétion.",
      },
    },
  },
  {
    id: "srd:item:plate_armor",
    slug: "srd:item:plate_armor",
    name: "Plate Armor",
    entityType: "armor",
    tier: "SYSTEM_SRD",
    weight: 65,
    data: {
      itemType: "armor",
      category: "heavy",
      armorClass: 18,
      dexBonus: false,
      strengthRequirement: 15,
      weight: 65,
      cost: "1500 gp",
      stealthDisadvantage: true,
    },
    i18n: {
      en: {
        name: "Plate Armor",
        description:
          "Heavy armor consisting of shaped, interlocking metal plates. AC 18, requires Str 15, disadvantage on Stealth.",
      },
      fr: {
        name: "Harnois",
        description:
          "Armure lourde constituée de plaques de métal ajustées recouvrant tout le corps. CA 18, requiert For 15, désavantage en Discrétion.",
      },
    },
  },
  {
    id: "srd:item:shield",
    slug: "srd:item:shield",
    name: "Shield",
    entityType: "armor",
    tier: "SYSTEM_SRD",
    weight: 6,
    data: {
      itemType: "armor",
      category: "shield",
      armorClassBonus: 2,
      weight: 6,
      cost: "10 gp",
    },
    i18n: {
      en: {
        name: "Shield",
        description:
          "A wooden or metal shield carried in one hand. Wielding a shield increases your Armor Class by 2.",
      },
      fr: {
        name: "Bouclier",
        description:
          "Un bouclier en bois ou en métal porté à une main. Brandir un bouclier augmente votre classe d'armure de 2.",
      },
    },
  },

  // ==========================================================================
  // 4. SPELLS (LEVELS 0-5)
  // ==========================================================================
  {
    id: "srd:spell:fire_bolt",
    slug: "srd:spell:fire_bolt",
    name: "Fire Bolt",
    entityType: "spell",
    tier: "SYSTEM_SRD",
    data: {
      level: 0,
      school: "evocation",
      castingTime: "1 action",
      range: "120 feet",
      components: ["V", "S"],
      duration: "Instantaneous",
      damageDice: "1d10",
      damageType: "fire",
      classes: ["sorcerer", "wizard"],
    },
    i18n: {
      en: {
        name: "Fire Bolt",
        description:
          "You hurl a mote of fire at a creature or object within range. Make a ranged spell attack; on a hit, the target takes 1d10 fire damage.",
      },
      fr: {
        name: "Trait de feu",
        description:
          "Vous projetez un trait enflammé sur une créature ou un objet à portée. Effectuez une attaque de sort à distance infligeant 1d10 dégâts de feu.",
      },
    },
  },
  {
    id: "srd:spell:magic_missile",
    slug: "srd:spell:magic_missile",
    name: "Magic Missile",
    entityType: "spell",
    tier: "SYSTEM_SRD",
    data: {
      level: 1,
      school: "evocation",
      castingTime: "1 action",
      range: "120 feet",
      components: ["V", "S"],
      duration: "Instantaneous",
      damageDice: "3d4+3",
      damageType: "force",
      classes: ["sorcerer", "wizard"],
    },
    i18n: {
      en: {
        name: "Magic Missile",
        description:
          "You create three glowing darts of magical force. Each dart hits a creature of your choice automatically for 1d4 + 1 force damage.",
      },
      fr: {
        name: "Projectile magique",
        description:
          "Vous créez trois dards d'énergie magique lumineuse qui touchent automatiquement leur cible en infligeant 1d4 + 1 dégâts de force chacun.",
      },
    },
  },
  {
    id: "srd:spell:cure_wounds",
    slug: "srd:spell:cure_wounds",
    name: "Cure Wounds",
    entityType: "spell",
    tier: "SYSTEM_SRD",
    data: {
      level: 1,
      school: "evocation",
      castingTime: "1 action",
      range: "Touch",
      components: ["V", "S"],
      duration: "Instantaneous",
      healDice: "1d8",
      classes: ["bard", "cleric", "druid", "paladin", "ranger"],
    },
    i18n: {
      en: {
        name: "Cure Wounds",
        description:
          "A creature you touch regains hit points equal to 1d8 + your spellcasting ability modifier.",
      },
      fr: {
        name: "Soins",
        description:
          "Une créature que vous touchez récupère un nombre de points de vie égal à 1d8 + votre modificateur d'incantation.",
      },
    },
  },
  {
    id: "srd:spell:shield",
    slug: "srd:spell:shield",
    name: "Shield",
    entityType: "spell",
    tier: "SYSTEM_SRD",
    data: {
      level: 1,
      school: "abjuration",
      castingTime: "1 reaction",
      range: "Self",
      components: ["V", "S"],
      duration: "1 round",
      bonusAc: 5,
      classes: ["sorcerer", "wizard"],
    },
    i18n: {
      en: {
        name: "Shield",
        description:
          "An invisible barrier of magical force protects you, granting a +5 bonus to AC until the start of your next turn and negating magic missile.",
      },
      fr: {
        name: "Bouclier",
        description:
          "Une barrière invisible d'énergie vous protège, conférant un bonus de +5 à la CA jusqu'au début de votre prochain tour et annulant projectile magique.",
      },
    },
  },
  {
    id: "srd:spell:hold_person",
    slug: "srd:spell:hold_person",
    name: "Hold Person",
    entityType: "spell",
    tier: "SYSTEM_SRD",
    data: {
      level: 2,
      school: "enchantment",
      castingTime: "1 action",
      range: "60 feet",
      components: ["V", "S", "M"],
      duration: "Concentration, up to 1 minute",
      saveAbility: "wis",
      applyConditionOnFail: "Paralyzed",
      classes: ["bard", "cleric", "druid", "sorcerer", "warlock", "wizard"],
    },
    i18n: {
      en: {
        name: "Hold Person",
        description:
          "Choose a humanoid within range. The target must succeed on a Wisdom saving throw or be paralyzed for the duration.",
      },
      fr: {
        name: "Immobilisation d'humanoïde",
        description:
          "Choisissez un humanoïde à portée. La cible doit réussir un jet de sauvegarde de Sagesse sous peine d'être paralysée pour la durée.",
      },
    },
  },
  {
    id: "srd:spell:misty_step",
    slug: "srd:spell:misty_step",
    name: "Misty Step",
    entityType: "spell",
    tier: "SYSTEM_SRD",
    data: {
      level: 2,
      school: "conjuration",
      castingTime: "1 bonus action",
      range: "Self",
      components: ["V"],
      duration: "Instantaneous",
      classes: ["sorcerer", "warlock", "wizard"],
    },
    i18n: {
      en: {
        name: "Misty Step",
        description:
          "Surrounded by silvery mist, you teleport up to 30 feet to an unoccupied space that you can see.",
      },
      fr: {
        name: "Pas brumeux",
        description:
          "Entouré d'une brume argentée, vous vous téléportez instantanément jusqu'à 9 mètres vers un espace inoccupé que vous voyez.",
      },
    },
  },
  {
    id: "srd:spell:fireball",
    slug: "srd:spell:fireball",
    name: "Fireball",
    entityType: "spell",
    tier: "SYSTEM_SRD",
    data: {
      level: 3,
      school: "evocation",
      castingTime: "1 action",
      range: "150 feet",
      components: ["V", "S", "M"],
      duration: "Instantaneous",
      saveAbility: "dex",
      halfDamageOnSave: true,
      damageDice: "8d6",
      damageType: "fire",
      classes: ["sorcerer", "wizard"],
    },
    i18n: {
      en: {
        name: "Fireball",
        description:
          "A bright streak flashes to a point within range and blossoms into an explosion of flame. Each creature in a 20-foot radius sphere takes 8d6 fire damage (half on successful Dex save).",
      },
      fr: {
        name: "Boule de feu",
        description:
          "Un trait lumineux jaillit et explose en un fracas de flammes. Chaque créature dans une sphère de 6 mètres de rayon subit 8d6 dégâts de feu (moitié sur sauvegarde de Dex réussie).",
      },
    },
  },
  {
    id: "srd:spell:counterspell",
    slug: "srd:spell:counterspell",
    name: "Counterspell",
    entityType: "spell",
    tier: "SYSTEM_SRD",
    data: {
      level: 3,
      school: "abjuration",
      castingTime: "1 reaction",
      range: "60 feet",
      components: ["S"],
      duration: "Instantaneous",
      classes: ["sorcerer", "warlock", "wizard"],
    },
    i18n: {
      en: {
        name: "Counterspell",
        description:
          "You attempt to interrupt a creature in the process of casting a spell. If the spell is 3rd level or lower, it fails automatically.",
      },
      fr: {
        name: "Contresort",
        description:
          "Vous tentez d'interrompre une créature en train d'incanter un sort. Si le sort est de niveau 3 ou inférieur, il échoue automatiquement.",
      },
    },
  },
  {
    id: "srd:spell:polymorph",
    slug: "srd:spell:polymorph",
    name: "Polymorph",
    entityType: "spell",
    tier: "SYSTEM_SRD",
    data: {
      level: 4,
      school: "transmutation",
      castingTime: "1 action",
      range: "60 feet",
      components: ["V", "S", "M"],
      duration: "Concentration, up to 1 hour",
      saveAbility: "wis",
      classes: ["bard", "druid", "sorcerer", "wizard"],
    },
    i18n: {
      en: {
        name: "Polymorph",
        description:
          "This spell transforms a creature with at least 1 hit point that you can see within range into a new beast form of equal or lesser challenge rating.",
      },
      fr: {
        name: "Métamorphose",
        description:
          "Ce sort transforme une créature consentante ou ayant raté sa sauvegarde de Sagesse en une forme de bête dont le FP est inférieur ou égal au sien.",
      },
    },
  },
  {
    id: "srd:spell:dimension_door",
    slug: "srd:spell:dimension_door",
    name: "Dimension Door",
    entityType: "spell",
    tier: "SYSTEM_SRD",
    data: {
      level: 4,
      school: "conjuration",
      castingTime: "1 action",
      range: "500 feet",
      components: ["V"],
      duration: "Instantaneous",
      classes: ["bard", "sorcerer", "warlock", "wizard"],
    },
    i18n: {
      en: {
        name: "Dimension Door",
        description:
          "You teleport yourself to any spot within range. You arrive at exactly the spot desired and can bring along one willing creature.",
      },
      fr: {
        name: "Porte dimensionnelle",
        description:
          "Vous vous téléportez à n'importe quel endroit situé à portée (jusqu'à 150 mètres) en emmenant éventuellement une créature consentante.",
      },
    },
  },
  {
    id: "srd:spell:cone_of_cold",
    slug: "srd:spell:cone_of_cold",
    name: "Cone of Cold",
    entityType: "spell",
    tier: "SYSTEM_SRD",
    data: {
      level: 5,
      school: "evocation",
      castingTime: "1 action",
      range: "Self (60-foot cone)",
      components: ["V", "S", "M"],
      duration: "Instantaneous",
      saveAbility: "con",
      halfDamageOnSave: true,
      damageDice: "8d8",
      damageType: "cold",
      classes: ["sorcerer", "wizard"],
    },
    i18n: {
      en: {
        name: "Cone of Cold",
        description:
          "A blast of cold air erupts from your hands. Each creature in a 60-foot cone takes 8d8 cold damage (half on successful Con save).",
      },
      fr: {
        name: "Cône de froid",
        description:
          "Une rafale glaciale jaillit de vos mains. Chaque créature dans un cône de 18 mètres subit 8d8 dégâts de froid (moitié sur sauvegarde de Con réussie).",
      },
    },
  },

  // ==========================================================================
  // 5. FEATS
  // ==========================================================================
  {
    id: "srd:feat:sharpshooter",
    slug: "srd:feat:sharpshooter",
    name: "Sharpshooter",
    entityType: "feat",
    tier: "SYSTEM_SRD",
    data: {
      category: "combat",
      benefit:
        "Attacking at long range doesn't impose disadvantage on ranged weapon attack rolls. Your ranged weapon attacks ignore half cover and three-quarters cover. Before you make an attack with a ranged weapon that you are proficient with, you can choose to take a -5 penalty to the attack roll to add +10 to the damage roll.",
    },
    i18n: {
      en: {
        name: "Sharpshooter",
        description:
          "Master of ranged strikes who ignores distance penalties, pierces partial cover, and can sacrifice attack accuracy (-5) for devastating power (+10 damage).",
      },
      fr: {
        name: "Tireur d'élite",
        description:
          "Maître du tir à distance ignorant les malus de portée, transperçant les abris partiels et pouvant sacrifier la précision (-5 au toucher) pour infliger +10 dégâts.",
      },
    },
  },
  {
    id: "srd:feat:great_weapon_master",
    slug: "srd:feat:great_weapon_master",
    name: "Great Weapon Master",
    entityType: "feat",
    tier: "SYSTEM_SRD",
    data: {
      category: "combat",
      benefit:
        "On your turn, when you score a critical hit with a melee weapon or reduce a creature to 0 hit points, you can make one melee weapon attack as a bonus action. Before you make a melee attack with a heavy weapon that you are proficient with, you can choose to take a -5 penalty to the attack roll to add +10 to the damage roll.",
    },
    i18n: {
      en: {
        name: "Great Weapon Master",
        description:
          "Wielder of massive weapons who cleaves through foes on critical hits or kills and can take -5 to hit for +10 damage.",
      },
      fr: {
        name: "Maître des armes à deux mains",
        description:
          "Spécialiste des armes imposantes obtenant une attaque supplémentaire en action bonus lors d'un coup critique ou d'un coup fatal, et pouvant échanger -5 au toucher contre +10 dégâts.",
      },
    },
  },
  {
    id: "srd:feat:tough",
    slug: "srd:feat:tough",
    name: "Tough",
    entityType: "feat",
    tier: "SYSTEM_SRD",
    data: {
      category: "general",
      benefit:
        "Your hit point maximum increases by an amount equal to twice your character level when you gain this feat. Whenever you gain a level thereafter, your hit point maximum increases by an additional 2 hit points.",
    },
    i18n: {
      en: {
        name: "Tough",
        description:
          "Increases your maximum Hit Points by 2 per character level immediately and retroactively upon each level-up.",
      },
      fr: {
        name: "Robuste",
        description:
          "Augmente votre maximum de points de vie de 2 par niveau de personnage immédiatement et rétroactivement à chaque montée de niveau.",
      },
    },
  },
  {
    id: "srd:feat:sentinel",
    slug: "srd:feat:sentinel",
    name: "Sentinel",
    entityType: "feat",
    tier: "SYSTEM_SRD",
    data: {
      category: "combat",
      benefit:
        "When you hit a creature with an opportunity attack, the creature's speed becomes 0 for the rest of the turn. Creatures provoke opportunity attacks even if they took the Disengage action. When a creature within 5 feet makes an attack against a target other than you, you can use your reaction to make a melee weapon attack against the attacking creature.",
    },
    i18n: {
      en: {
        name: "Sentinel",
        description:
          "Vigilant guardian whose opportunity attacks halt enemy movement to 0 and punish foes who bypass you to attack allies.",
      },
      fr: {
        name: "Sentinelle",
        description:
          "Protecteur vigilant dont les attaques d'opportunité réduisent la vitesse de l'ennemi à 0 et punissent les créatures attaquant vos alliés à portée.",
      },
    },
  },
  {
    id: "srd:feat:dual_wielder",
    slug: "srd:feat:dual_wielder",
    name: "Dual Wielder",
    entityType: "feat",
    tier: "SYSTEM_SRD",
    data: {
      category: "combat",
      benefit:
        "You gain a +1 bonus to AC while you are wielding a separate melee weapon in each hand. You can use two-weapon fighting even when the one-handed melee weapons you are wielding aren't light. You can draw or stow two one-handed weapons when you would normally be able to draw or stow only one.",
    },
    i18n: {
      en: {
        name: "Dual Wielder",
        description:
          "Grants +1 AC while holding two melee weapons and permits wielding non-light one-handed weapons in two-weapon fighting.",
      },
      fr: {
        name: "Spécialiste du combat à deux armes",
        description:
          "Confère un bonus de +1 à la CA lors du maniement de deux armes de corps à corps et autorise le combat à deux armes avec des armes non légères.",
      },
    },
  },

  // ==========================================================================
  // 6. READY-TO-USE MONSTER TEMPLATES
  // ==========================================================================
  {
    id: "srd:monster:goblin",
    slug: "srd:monster:goblin",
    name: "Goblin",
    entityType: "monster",
    tier: "SYSTEM_SRD",
    data: {
      id: "srd:monster:goblin",
      name: "Goblin",
      level: 1,
      challengeRating: "1/4",
      cr: 0.25,
      hpCurrent: 7,
      hpMax: 7,
      tempHp: 0,
      hitDiceCurrent: 2,
      hitDiceMax: 2,
      hitDieSides: 6,
      armorBaseAc: 15,
      armorKind: "light",
      hasShield: true,
      abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
      saveProficiencies: { dex: false, con: false, wis: false, cha: false },
      skillProficiencies: { stealth: "expertise" },
      exhaustionLevel: 0,
      conditions: [],
      resources: {},
      deathSaves: { successes: 0, failures: 0, isStable: false, isDead: false },
      actions: [
        {
          id: "scimitar",
          name: "Scimitar",
          attackBonus: 4,
          damage: "1d6 + 2",
          damageType: "slashing",
        },
        {
          id: "shortbow",
          name: "Shortbow",
          attackBonus: 4,
          damage: "1d6 + 2",
          damageType: "piercing",
          range: "80/320",
        },
      ],
    },
    i18n: {
      en: {
        name: "Goblin",
        description:
          "Small, black-hearted humanoids that gather in tribal hordes, inhabiting caves, ruins, and sinister dungeons.",
      },
      fr: {
        name: "Gobelin",
        description:
          "Petits humanoïdes au cœur noir qui se rassemblent en tribus et hantent les cavernes, les ruines et les donjons sinistres.",
      },
    },
  },
  {
    id: "srd:monster:bandit",
    slug: "srd:monster:bandit",
    name: "Bandit",
    entityType: "monster",
    tier: "SYSTEM_SRD",
    data: {
      id: "srd:monster:bandit",
      name: "Bandit",
      level: 1,
      challengeRating: "1/8",
      cr: 0.125,
      hpCurrent: 11,
      hpMax: 11,
      tempHp: 0,
      hitDiceCurrent: 2,
      hitDiceMax: 2,
      hitDieSides: 8,
      armorBaseAc: 12,
      armorKind: "light",
      hasShield: false,
      abilities: { str: 11, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
      saveProficiencies: { dex: false, con: false, wis: false, cha: false },
      skillProficiencies: {},
      exhaustionLevel: 0,
      conditions: [],
      resources: {},
      deathSaves: { successes: 0, failures: 0, isStable: false, isDead: false },
      actions: [
        {
          id: "scimitar",
          name: "Scimitar",
          attackBonus: 3,
          damage: "1d6 + 1",
          damageType: "slashing",
        },
        {
          id: "light_crossbow",
          name: "Light Crossbow",
          attackBonus: 3,
          damage: "1d8 + 1",
          damageType: "piercing",
          range: "80/320",
        },
      ],
    },
    i18n: {
      en: {
        name: "Bandit",
        description:
          "Outlaws and brigands who roam highways and wild borders, preying on travelers and merchant caravans.",
      },
      fr: {
        name: "Brigand",
        description:
          "Hors-la-loi et maraudeurs qui écument les grands chemins et les frontières sauvages, pillant voyageurs et caravanes marchandes.",
      },
    },
  },
  {
    id: "srd:monster:guard",
    slug: "srd:monster:guard",
    name: "Guard",
    entityType: "monster",
    tier: "SYSTEM_SRD",
    data: {
      id: "srd:monster:guard",
      name: "Guard",
      level: 1,
      challengeRating: "1/8",
      cr: 0.125,
      hpCurrent: 11,
      hpMax: 11,
      tempHp: 0,
      hitDiceCurrent: 2,
      hitDiceMax: 2,
      hitDieSides: 8,
      armorBaseAc: 16,
      armorKind: "medium",
      hasShield: true,
      abilities: { str: 13, dex: 12, con: 12, int: 10, wis: 11, cha: 10 },
      saveProficiencies: { dex: false, con: false, wis: false, cha: false },
      skillProficiencies: { perception: "proficient" },
      exhaustionLevel: 0,
      conditions: [],
      resources: {},
      deathSaves: { successes: 0, failures: 0, isStable: false, isDead: false },
      actions: [
        {
          id: "spear",
          name: "Spear",
          attackBonus: 3,
          damage: "1d6 + 1",
          versatileDamage: "1d8 + 1",
          damageType: "piercing",
          range: "20/60",
        },
      ],
    },
    i18n: {
      en: {
        name: "Guard",
        description:
          "City watch officers, soldiers, and personal bodyguards tasked with defending towns, citadels, and nobles.",
      },
      fr: {
        name: "Garde",
        description:
          "Membres du guet urbain, soldats et gardes du corps chargés de défendre cités, forteresses et dignitaires.",
      },
    },
  },
  {
    id: "srd:monster:skeleton",
    slug: "srd:monster:skeleton",
    name: "Skeleton",
    entityType: "monster",
    tier: "SYSTEM_SRD",
    data: {
      id: "srd:monster:skeleton",
      name: "Skeleton",
      level: 1,
      challengeRating: "1/4",
      cr: 0.25,
      hpCurrent: 13,
      hpMax: 13,
      tempHp: 0,
      hitDiceCurrent: 2,
      hitDiceMax: 2,
      hitDieSides: 8,
      armorBaseAc: 13,
      armorKind: "armor_scraps",
      hasShield: false,
      abilities: { str: 10, dex: 14, con: 15, int: 6, wis: 8, cha: 5 },
      saveProficiencies: { dex: false, con: false, wis: false, cha: false },
      skillProficiencies: {},
      damageVulnerabilities: ["bludgeoning"],
      damageImmunities: ["poison"],
      conditionImmunities: ["exhaustion", "poisoned"],
      exhaustionLevel: 0,
      conditions: [],
      resources: {},
      deathSaves: { successes: 0, failures: 0, isStable: false, isDead: false },
      actions: [
        {
          id: "shortsword",
          name: "Shortsword",
          attackBonus: 4,
          damage: "1d6 + 2",
          damageType: "piercing",
        },
        {
          id: "shortbow",
          name: "Shortbow",
          attackBonus: 4,
          damage: "1d6 + 2",
          damageType: "piercing",
          range: "80/320",
        },
      ],
    },
    i18n: {
      en: {
        name: "Skeleton",
        description:
          "Animated bones of the dead, driven by dark necromantic magic to obey their master's sinister commands.",
      },
      fr: {
        name: "Squelette",
        description:
          "Ossements réanimés par une magie nécromantique ténébreuse, exécutant sans faillir les ordres de leur maître.",
      },
    },
  },
  {
    id: "srd:monster:wolf",
    slug: "srd:monster:wolf",
    name: "Wolf",
    entityType: "monster",
    tier: "SYSTEM_SRD",
    data: {
      id: "srd:monster:wolf",
      name: "Wolf",
      level: 1,
      challengeRating: "1/4",
      cr: 0.25,
      hpCurrent: 11,
      hpMax: 11,
      tempHp: 0,
      hitDiceCurrent: 2,
      hitDiceMax: 2,
      hitDieSides: 8,
      armorBaseAc: 13,
      armorKind: "natural",
      hasShield: false,
      abilities: { str: 12, dex: 15, con: 12, int: 3, wis: 12, cha: 6 },
      saveProficiencies: { dex: false, con: false, wis: false, cha: false },
      skillProficiencies: { perception: "proficient", stealth: "proficient" },
      exhaustionLevel: 0,
      conditions: [],
      resources: {},
      deathSaves: { successes: 0, failures: 0, isStable: false, isDead: false },
      actions: [
        {
          id: "bite",
          name: "Bite",
          attackBonus: 4,
          damage: "2d4 + 2",
          damageType: "piercing",
        },
      ],
    },
    i18n: {
      en: {
        name: "Wolf",
        description:
          "Wild pack-hunting predators that track prey across tundras, forests, and misty grasslands.",
      },
      fr: {
        name: "Loup",
        description:
          "Prédateurs sauvages chassant en meute coordonnée à travers les toundras, forêts et steppes brumeuses.",
      },
    },
  },
  {
    id: "srd:monster:ogre",
    slug: "srd:monster:ogre",
    name: "Ogre",
    entityType: "monster",
    tier: "SYSTEM_SRD",
    data: {
      id: "srd:monster:ogre",
      name: "Ogre",
      level: 4,
      challengeRating: "2",
      cr: 2,
      hpCurrent: 59,
      hpMax: 59,
      tempHp: 0,
      hitDiceCurrent: 7,
      hitDiceMax: 7,
      hitDieSides: 10,
      armorBaseAc: 11,
      armorKind: "hide",
      hasShield: false,
      abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
      saveProficiencies: { dex: false, con: false, wis: false, cha: false },
      skillProficiencies: {},
      exhaustionLevel: 0,
      conditions: [],
      resources: {},
      deathSaves: { successes: 0, failures: 0, isStable: false, isDead: false },
      actions: [
        {
          id: "greatclub",
          name: "Greatclub",
          attackBonus: 6,
          damage: "2d8 + 4",
          damageType: "bludgeoning",
        },
        {
          id: "javelin",
          name: "Javelin",
          attackBonus: 6,
          damage: "2d6 + 4",
          damageType: "piercing",
          range: "30/120",
        },
      ],
    },
    i18n: {
      en: {
        name: "Ogre",
        description:
          "Fierce, gluttonous brutes that stand nearly ten feet tall and wield enormous clubs in battle.",
      },
      fr: {
        name: "Ogre",
        description:
          "Brutes féroces et gloutonnes mesurant près de trois mètres de haut, maniant de massives massues au combat.",
      },
    },
  },
  {
    id: "srd:monster:adult_red_dragon",
    slug: "srd:monster:adult_red_dragon",
    name: "Adult Red Dragon",
    entityType: "monster",
    tier: "SYSTEM_SRD",
    data: {
      id: "srd:monster:adult_red_dragon",
      name: "Adult Red Dragon",
      level: 17,
      challengeRating: "17",
      cr: 17,
      hpCurrent: 256,
      hpMax: 256,
      tempHp: 0,
      hitDiceCurrent: 19,
      hitDiceMax: 19,
      hitDieSides: 12,
      armorBaseAc: 19,
      armorKind: "heavy",
      hasShield: false,
      spellcastingAbility: "cha",
      abilities: { str: 27, dex: 10, con: 25, int: 16, wis: 13, cha: 21 },
      saveProficiencies: { dex: true, con: true, wis: true, cha: true },
      skillProficiencies: { perception: "expertise", stealth: "proficient" },
      damageImmunities: ["fire"],
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
      actions: [
        {
          id: "bite",
          name: "Bite",
          attackBonus: 14,
          damage: "2d10 + 8",
          damageType: "piercing",
        },
        {
          id: "fire_breath",
          name: "Fire Breath (Recharge 5-6)",
          damage: "18d6",
          damageType: "fire",
          saveAbility: "dex",
          dc: 21,
        },
      ],
    },
    i18n: {
      en: {
        name: "Adult Red Dragon",
        description:
          "Lordly and covetous tyrants of mountains and volcanoes, breathing catastrophic cones of fire.",
      },
      fr: {
        name: "Dragon rouge adulte",
        description:
          "Seigneurs tyrans et cupides des monts et volcans, crachant des cônes de feu dévastateurs.",
      },
    },
  },

  // ==========================================================================
  // 7. CANONICAL SRD 5.1 SUBCLASSES
  // ==========================================================================
  {
    id: "srd:subclass:berserker",
    slug: "srd:subclass:berserker",
    name: "Path of the Berserker",
    entityType: "subclass",
    tier: "SYSTEM_SRD",
    data: { classId: "barbarian", class: "barbarian" },
    i18n: {
      en: { name: "Path of the Berserker", description: "For some barbarians, rage is a means to an end—that end being violence." },
      fr: { name: "Voie du berserker", description: "Pour certains barbares, la rage est une fin en soi tournée vers la fureur pure." },
    },
  },
  {
    id: "srd:subclass:lore",
    slug: "srd:subclass:lore",
    name: "College of Lore",
    entityType: "subclass",
    tier: "SYSTEM_SRD",
    data: { classId: "bard", class: "bard" },
    i18n: {
      en: { name: "College of Lore", description: "Bards of the College of Lore know something about most everything." },
      fr: { name: "Collège du savoir", description: "Les bardes du collège du savoir accumulent des connaissances sur tout." },
    },
  },
  {
    id: "srd:subclass:life",
    slug: "srd:subclass:life",
    name: "Life Domain",
    entityType: "subclass",
    tier: "SYSTEM_SRD",
    data: { classId: "cleric", class: "cleric" },
    i18n: {
      en: { name: "Life Domain", description: "The Life domain focuses on the vibrant positive energy that sustains all life." },
      fr: { name: "Domaine de la vie", description: "Le domaine de la vie se consacre à l'énergie positive soutenant l'existence." },
    },
  },
  {
    id: "srd:subclass:land",
    slug: "srd:subclass:land",
    name: "Circle of the Land",
    entityType: "subclass",
    tier: "SYSTEM_SRD",
    data: { classId: "druid", class: "druid" },
    i18n: {
      en: { name: "Circle of the Land", description: "Mystics and sages who safeguard ancient knowledge and nature's wild rites." },
      fr: { name: "Cercle de la terre", description: "Mystiques gardiens des savoirs anciens et des rites sauvages de la nature." },
    },
  },
  {
    id: "srd:subclass:champion",
    slug: "srd:subclass:champion",
    name: "Champion",
    entityType: "subclass",
    tier: "SYSTEM_SRD",
    data: { classId: "fighter", class: "fighter" },
    i18n: {
      en: { name: "Champion", description: "Focuses on the development of raw physical power honed to deadly perfection." },
      fr: { name: "Champion", description: "Se consacre à la puissance physique brute portée à une redoutable perfection." },
    },
  },
  {
    id: "srd:subclass:open_hand",
    slug: "srd:subclass:open_hand",
    name: "Way of the Open Hand",
    entityType: "subclass",
    tier: "SYSTEM_SRD",
    data: { classId: "monk", class: "monk" },
    i18n: {
      en: { name: "Way of the Open Hand", description: "Masters of martial arts combat, whether armed or unarmed." },
      fr: { name: "Voie de la paume de fer", description: "Maîtres absolus des arts martiaux au corps à corps." },
    },
  },
  {
    id: "srd:subclass:devotion",
    slug: "srd:subclass:devotion",
    name: "Oath of Devotion",
    entityType: "subclass",
    tier: "SYSTEM_SRD",
    data: { classId: "paladin", class: "paladin" },
    i18n: {
      en: { name: "Oath of Devotion", description: "Binds a paladin to the loftiest ideals of justice, virtue, and order." },
      fr: { name: "Serment de dévotion", description: "Lie le paladin aux idéaux les plus élevés de justice et de vertu." },
    },
  },
  {
    id: "srd:subclass:hunter",
    slug: "srd:subclass:hunter",
    name: "Hunter",
    entityType: "subclass",
    tier: "SYSTEM_SRD",
    data: { classId: "ranger", class: "ranger" },
    i18n: {
      en: { name: "Hunter", description: "Emulating the hunter's predatory focus to defend frontier settlements." },
      fr: { name: "Chasseur", description: "Émule la traque prédatrice pour protéger les frontières de la civilisation." },
    },
  },
  {
    id: "srd:subclass:thief",
    slug: "srd:subclass:thief",
    name: "Thief",
    entityType: "subclass",
    tier: "SYSTEM_SRD",
    data: { classId: "rogue", class: "rogue" },
    i18n: {
      en: { name: "Thief", description: "Hones agility, stealth, and dexterity to infiltrate and plunder." },
      fr: { name: "Voleur", description: "Affine agilité, discrétion et dextérité pour s'infiltrer et dérober." },
    },
  },
  {
    id: "srd:subclass:draconic",
    slug: "srd:subclass:draconic",
    name: "Draconic Bloodline",
    entityType: "subclass",
    tier: "SYSTEM_SRD",
    data: { classId: "sorcerer", class: "sorcerer" },
    i18n: {
      en: { name: "Draconic Bloodline", description: "Innate magic mingled with the ancient blood of dragons." },
      fr: { name: "Lignée draconique", description: "Magie innée mêlée au sang ancestral des dragons." },
    },
  },
  {
    id: "srd:subclass:fiend",
    slug: "srd:subclass:fiend",
    name: "The Fiend",
    entityType: "subclass",
    tier: "SYSTEM_SRD",
    data: { classId: "warlock", class: "warlock" },
    i18n: {
      en: { name: "The Fiend", description: "Pact struck with a fiend from the lower planes of damnation." },
      fr: { name: "Le fiélon", description: "Pacte scellé avec un être des plans inférieurs de damnation." },
    },
  },
  {
    id: "srd:subclass:evocation",
    slug: "srd:subclass:evocation",
    name: "School of Evocation",
    entityType: "subclass",
    tier: "SYSTEM_SRD",
    data: { classId: "wizard", class: "wizard" },
    i18n: {
      en: { name: "School of Evocation", description: "Focuses study on creating powerful elemental magical effects." },
      fr: { name: "École d'évocation", description: "Consacre l'étude magique aux déflagrations élémentaires puissantes." },
    },
  },
];

/**
 * Backward-compatible alias for `SYSTEM_SRD`.
 */
export const SystemSRD = SYSTEM_SRD;

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
