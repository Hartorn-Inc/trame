import type { ActionDefinition, Dnd5eActorSheet } from "./pipeline.ts";

export type CompendiumTier = "SYSTEM_SRD" | "INSTANCE_LIBRARY" | "CAMPAIGN_HOMEBREW";

export interface CompendiumEntry {
  id: string;
  slug: string;
  name: string;
  entityType: "monster" | "spell" | "item" | "class" | "feat";
  tier: CompendiumTier;
  data: Record<string, unknown>;
  overrideEntityId?: string;
}

export interface CompendiumQuery {
  searchTerm?: string;
  entityType?: "monster" | "spell" | "item" | "class" | "feat";
}

export const SRD_51_ATTRIBUTION =
  'This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode.';

export class CompendiumResolver {
  private readonly systemSrd: Map<string, CompendiumEntry>;
  private readonly instanceLibrary: Map<string, CompendiumEntry>;
  private readonly campaignHomebrew: Map<string, CompendiumEntry>;

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

  public getAttribution(): string {
    return SRD_51_ATTRIBUTION;
  }
}

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
