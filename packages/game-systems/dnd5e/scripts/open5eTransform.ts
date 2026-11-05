/**
 * ============================================================================
 * OPEN5E SRD 5.2.1 SNAPSHOT TO COMPENDIUM PACKS TRANSFORM (open5eTransform.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Turns the pinned Open5e `srd-2024` dataset (SRD 5.2.1, CC-BY-4.0) into the
 * three generated compendium packs: spells, monsters (`MonsterStatBlock`) and
 * magic items. It is a pure function of the snapshot so the committed packs
 * are reproducible byte for byte (audit GS7, GS8, decision D8).
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Pinned, Verified Source`:
 *      - `OPEN5E_SOURCE` fixes the Open5e tag, commit and the sha256 of every
 *        input file; `generate-srd-content.ts` refuses any other bytes.
 *   2. `Stable Ids`:
 *      - Ids are `srd:<kind>:<snake_name>`. `MONSTER_ID_ALIASES` keeps the
 *        ids of monsters renamed by SRD 5.2.1 (`goblin` for Goblin Warrior)
 *        so existing actors and encounters keep resolving.
 *   3. `Rules Text Is The Source Of Truth`:
 *      - Open5e structured columns are incomplete (attack damage types,
 *        spell saves and areas). Attacks, saves, damage, areas and riders are
 *        parsed from the SRD-verbatim description instead; facts Open5e lost
 *        entirely come from `open5eCorrections.ts`.
 *   4. `Automation Is Conservative`:
 *      - An action is `"full"` only when every sentence matched a known
 *        pattern; any leftover prose downgrades it to `"partial"`, and an
 *        action without an attack roll or saving throw is `"text"`.
 *   5. `Deterministic Output`:
 *      - Entries are sorted by id, no timestamps are written, and
 *      `serializePack` emits one entry per line.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `buildSrdPacks(snapshot)`
 *     ├── 1. Index creature actions and traits by parent creature.
 *     ├── 2. Map each creature to a `MonsterStatBlock` (+ corrections) and its actor sheet.
 *     ├── 3. Map each spell, parsing damage, save, attack and area from its text.
 *     ├── 4. Group magic item variants sharing one rules text into one entry.
 *     └── 5. Sort every pack by id.
 * ============================================================================
 */

import type { CompendiumEntry } from "../src/compendium.ts";
import type { SrdPacks } from "../src/srdPacks.ts";
import {
  monsterSheetFromStatBlock,
  proficiencyBonusForChallengeRating,
  xpForChallengeRating,
  type AreaOfEffect,
  type ConditionId,
  type CreatureSize,
  type CreatureType,
  type DamagePart,
  type MonsterAction,
  type MonsterActionRider,
  type MonsterActionUsage,
  type MonsterStatBlock,
  type MonsterTrait,
  type MultiattackStep,
} from "../src/monsterStatBlock.ts";
import type { AbilityId, DamageType, SkillId } from "../src/types.ts";
import {
  GEAR_MAGIC_ITEMS,
  legendaryActionUses,
  MAGIC_ITEM_RARITIES,
  monsterCorrection,
  SPELL_CLASS_ADDITIONS,
  SPELL_DESCRIPTIONS,
} from "./open5eCorrections.ts";

/** Open5e fixture record (`model`, `pk`, `fields`) as stored in the `data/v2` JSON files. */
export interface Open5eRecord {
  model: string;
  pk: string | number;
  fields: Record<string, unknown>;
}

/** The seven Open5e `srd-2024` files the generator reads. */
export interface Open5eSnapshot {
  creatures: Open5eRecord[];
  creatureActions: Open5eRecord[];
  creatureTraits: Open5eRecord[];
  spells: Open5eRecord[];
  magicItems: Open5eRecord[];
  /** Adventuring gear; only the records listed in `GEAR_MAGIC_ITEMS` are read. */
  items: Open5eRecord[];
  documents: Open5eRecord[];
}

/** Pinned Open5e source: tag `v2.2.3` resolves to `commit`; each file is checked against its sha256. */
export const OPEN5E_SOURCE = {
  repository: "https://github.com/open5e/open5e-api",
  tag: "v2.2.3",
  commit: "0692d64c1438c848c1da11fbed2d84014b131452",
  documentKey: "srd-2024",
  dataPath: "data/v2/wizards-of-the-coast/srd-2024",
  files: {
    creatures: { file: "Creature.json", sha256: "1d0a4980f816390865b93894813bed9fd22a8104b579946c20fb9664510b9009" },
    creatureActions: { file: "CreatureAction.json", sha256: "28c82fabbf6b5cb83d9eb6ccb5b73dbb31ccdda131e77cafd0aafa0422024867" },
    creatureTraits: { file: "CreatureTrait.json", sha256: "f9ad51a72a47a8ac9798694c34b422bfcd7e109917482ea25d884e4cf840223d" },
    spells: { file: "Spell.json", sha256: "ba87b7bd39fb57a2e2121a2d0f88bd23c731df9f90358ac8201f985e1702df4a" },
    magicItems: { file: "MagicItem.json", sha256: "30354f10e94d28eae784f738affe9ff47a845d799e18335ff52dc8a3d80d6c97" },
    items: { file: "Item.json", sha256: "01a8bc82d2957d0aa9fc3a619e91e140b989bc5e3e47173ef1f7602ee58edbc0" },
    documents: { file: "Document.json", sha256: "c9a85da12a2a90cf272f35f061f7ec60adf52f501312c45ee59fb17890611b1a" },
  },
} as const satisfies {
  repository: string;
  tag: string;
  commit: string;
  documentKey: string;
  dataPath: string;
  files: Record<keyof Open5eSnapshot, { file: string; sha256: string }>;
};

/** Monsters renamed by SRD 5.2.1 keep the id they had in the curated catalog. */
export const MONSTER_ID_ALIASES: Readonly<Record<string, string>> = {
  "bugbear-warrior": "srd:monster:bugbear",
  "gnoll-warrior": "srd:monster:gnoll",
  "goblin-warrior": "srd:monster:goblin",
  "hobgoblin-warrior": "srd:monster:hobgoblin",
  "kobold-warrior": "srd:monster:kobold",
  "minotaur-of-baphomet": "srd:monster:minotaur",
};

/**
 * SRD 5.2.1 names of magic items whose Open5e variants share one rules text,
 * keyed by the name derived from the variants (common base or word prefix).
 */
const MAGIC_ITEM_GROUP_NAMES: Readonly<Record<string, string>> = {
  Ammunition: "Ammunition, +1, +2, or +3",
  "Ammunition of": "Ammunition of Slaying",
  Berserker: "Berserker Axe",
  Dancing: "Dancing Sword",
  Demon: "Demon Armor",
  Dwarven: "Dwarven Plate",
  Shield: "Shield, +1, +2, or +3",
  Vicious: "Vicious Weapon",
  Vorpal: "Vorpal Sword",
  "Wand of the War Mage": "Wand of the War Mage, +1, +2, or +3",
  "of Etherealness": "Plate Armor of Etherealness",
  "of Life Stealing": "Sword of Life Stealing",
  "of Sharpness": "Sword of Sharpness",
  "of Wounding": "Sword of Wounding",
  "armor:+N": "Armor, +1, +2, or +3",
  "weapon:+N": "Weapon, +1, +2, or +3",
};

const ABILITY_NAMES: Record<AbilityId, string> = {
  str: "strength",
  dex: "dexterity",
  con: "constitution",
  int: "intelligence",
  wis: "wisdom",
  cha: "charisma",
};
const ABILITY_BY_NAME: Record<string, AbilityId> = Object.fromEntries(
  Object.entries(ABILITY_NAMES).map(([id, name]) => [name, id as AbilityId])
);
const ABILITIES = Object.keys(ABILITY_NAMES) as AbilityId[];
const SKILLS: readonly SkillId[] = [
  "acrobatics", "animal_handling", "arcana", "athletics", "deception", "history", "insight",
  "intimidation", "investigation", "medicine", "nature", "perception", "performance",
  "persuasion", "religion", "sleight_of_hand", "stealth", "survival",
];
const CONDITIONS: ReadonlySet<string> = new Set<ConditionId>([
  "blinded", "charmed", "deafened", "exhaustion", "frightened", "grappled", "incapacitated",
  "invisible", "paralyzed", "petrified", "poisoned", "prone", "restrained", "stunned", "unconscious",
]);
const COUNT_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const DAMAGE_TYPES = "Acid|Bludgeoning|Cold|Fire|Force|Lightning|Necrotic|Piercing|Poison|Psychic|Radiant|Slashing|Thunder";
const ABILITY_WORDS = "Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma";
/** `13 (1d10 + 8) Slashing damage` or a flat `1 Piercing damage`, with an optional trailing qualifier. */
const DAMAGE_SEGMENT = new RegExp(`^(\\d+)(?: \\(([^)]+)\\))? (${DAMAGE_TYPES}) damage(?: (.+))?$`);
const ATTACK_HEAD = new RegExp(
  "^(Melee or Ranged|Melee|Ranged) Attack Roll: ([+\\-−]\\d+)(?: to hit)?( \\([^)]*\\))?, " +
    "(?:reach (\\d+) (?:ft|feet)\\.?(?: or range (\\d+)(?:/(\\d+))? (?:ft|feet)\\.?)?|range (\\d+)(?:/(\\d+))? (?:ft|feet)\\.?)" +
    "\\s*(?:Hit: )?([\\s\\S]*)$"
);
const SAVE_HEAD = new RegExp(`^(${ABILITY_WORDS}) Saving Throw: DC (\\d+), ([^.]*?)\\.\\s+([\\s\\S]*)$`);
const SAVE_LABEL = /(First Failure|Second Failure|Failure or Success|Failure|Success):?\s/g;
const CONDITION_SENTENCE = /^(?:(If [^,]+), (?:it|the target)|The target) has the (\w+) condition(?: \(escape DC (\d+)\))?\.$/;
const SIMPLE_SAVE_TARGET = /^(?:each creature in an? \d.*|one creature(?: the [\w' -]+ can see)? within \d+ feet)$/;

/** Lowercase snake-case key (`"Hunter's Mark"` -> `"hunters_mark"`), at most 64 characters. */
export function snakeKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/**
 * Removes 5etools tags leaked into Open5e text, keeping the displayed words:
 * `Sphere [Area of Effect]|XPHB|Sphere` -> `Sphere`, `Cover|XPHB|Total Cover`
 * -> `Total Cover`, `Short Rest|XPHB|Short or Long Rest` -> `Short or Long Rest`.
 */
function cleanText(text: string): string {
  return text
    .replace(/ \[[^\]]*\]\|XPHB\|\w+/g, "")
    .replace(/(?:Cover|Short Rest)\|XPHB\|/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function normalizeDice(dice: string): string {
  return dice.replace(/−/g, "-").replace(/\s*([+-])\s*/g, " $1 ").replace(/\s+/g, " ").trim();
}

function str(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  return typeof value === "string" ? value : "";
}

function num(fields: Record<string, unknown>, key: string): number | undefined {
  const value = fields[key];
  return typeof value === "number" ? value : undefined;
}

function strings(fields: Record<string, unknown>, key: string): string[] {
  const value = fields[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function stripPrefix(pk: string | number): string {
  return String(pk).replace(/^srd-2024_/, "");
}

function byId(a: CompendiumEntry, b: CompendiumEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

// ============================================================================
// DAMAGE, AREA AND RIDER PARSING
// ============================================================================

function damagePart(average: string, dice: string | undefined, type: string): DamagePart {
  return { dice: normalizeDice(dice ?? average), average: Number(average), type: type.toLowerCase() as DamageType };
}

/**
 * Parses `"13 (1d10 + 8) Slashing damage plus 5 (2d4) Fire damage"` into
 * unconditional parts and conditional riders. `complete` is false when a
 * segment could not be read.
 */
function parseDamageList(
  text: string,
  trigger: MonsterActionRider["trigger"]
): { damage: DamagePart[]; riders: MonsterActionRider[]; complete: boolean } {
  const damage: DamagePart[] = [];
  const riders: MonsterActionRider[] = [];
  let complete = true;
  for (const segment of text.replace(/\.$/, "").split(/,? plus /)) {
    const match = DAMAGE_SEGMENT.exec(segment.trim());
    if (!match) {
      complete = false;
      break;
    }
    const part = damagePart(match[1], match[2], match[3]);
    const qualifier = match[4];
    if (!qualifier) {
      damage.push(part);
    } else if (damage.length > 0 && /^(?:if|when|against|to) /.test(qualifier)) {
      riders.push({ trigger, when: qualifier, damage: part });
    } else {
      damage.push(part);
      complete = false;
      break;
    }
  }
  return { damage, riders, complete };
}

/** First area of effect named in a text (`20-foot-radius Sphere`, `60-foot Cone`, `100-foot-long, 5-foot-wide Line`). */
export function parseArea(text: string): AreaOfEffect | undefined {
  const line = /(\d+)-foot-long, (\d+)-foot-wide Line|Line that is (\d+) feet long and (\d+) feet wide/i.exec(text);
  const cylinder = /(\d+)-foot-radius, (\d+)-foot-(?:high|tall) Cylinder/i.exec(text);
  const simple = /(\d+)-foot(?:-radius)? (Sphere|Cone|Cube|Emanation|Cylinder)/i.exec(text);
  const candidates: { index: number; area: AreaOfEffect }[] = [];
  if (line) {
    const sizeFt = Number(line[1] ?? line[3]);
    const widthFt = Number(line[2] ?? line[4]);
    candidates.push({ index: line.index, area: { shape: "line", sizeFt, widthFt } });
  }
  if (cylinder) {
    candidates.push({
      index: cylinder.index,
      area: { shape: "cylinder", sizeFt: Number(cylinder[1]), heightFt: Number(cylinder[2]) },
    });
  }
  if (simple && simple.index !== cylinder?.index) {
    const shape = simple[2].toLowerCase() as AreaOfEffect["shape"];
    candidates.push({ index: simple.index, area: { shape, sizeFt: Number(simple[1]) } });
  }
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]?.area;
}

function sentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=\.)\s+(?=[A-Z])/)
    .filter((s) => s.length > 0);
}

/** Reads `"If the target is ..., it has the Prone condition."` into a rider. */
function conditionRider(sentence: string, trigger: MonsterActionRider["trigger"]): MonsterActionRider | undefined {
  const match = CONDITION_SENTENCE.exec(sentence);
  if (!match) return undefined;
  const condition = match[2].toLowerCase();
  if (!CONDITIONS.has(condition)) return undefined;
  return {
    trigger,
    ...(match[1] ? { when: match[1] } : {}),
    condition: condition as ConditionId,
    ...(match[3] ? { escapeDc: Number(match[3]) } : {}),
  };
}

// ============================================================================
// MONSTER ACTIONS
// ============================================================================

type ParsedAction = Pick<MonsterAction, "automation" | "attack" | "save" | "damage" | "riders">;

function parseAttackAction(description: string): ParsedAction | undefined {
  const match = ATTACK_HEAD.exec(description);
  if (!match) return undefined;
  const kind = match[1] === "Melee" ? "melee" : match[1] === "Ranged" ? "ranged" : "melee_or_ranged";
  const toHit = Number(match[2].replace("−", "-"));
  const reachFt = match[4] ? Number(match[4]) : undefined;
  const rangeFt = match[5] ?? match[7];
  const longRangeFt = match[6] ?? match[8];
  const attack = {
    kind,
    toHit,
    ...(reachFt !== undefined ? { reachFt } : {}),
    ...(rangeFt ? { rangeFt: Number(rangeFt) } : {}),
    ...(longRangeFt ? { longRangeFt: Number(longRangeFt) } : {}),
  } as const;

  let complete = match[3] === undefined;
  const [hit, ...rest] = sentences(match[9]);
  const parsed = hit ? parseDamageList(hit, "onHit") : { damage: [], riders: [], complete: false };
  complete &&= parsed.complete;
  const riders = [...parsed.riders];
  for (const sentence of rest) {
    const rider = conditionRider(sentence, "onHit");
    if (rider) riders.push(rider);
    else complete = false;
  }
  return {
    automation: complete && parsed.damage.length > 0 ? "full" : "partial",
    attack,
    ...(parsed.damage.length > 0 ? { damage: parsed.damage } : {}),
    ...(riders.length > 0 ? { riders } : {}),
  };
}

function parseSaveAction(description: string): ParsedAction | undefined {
  const match = SAVE_HEAD.exec(description);
  if (!match) return undefined;
  const ability = ABILITY_BY_NAME[match[1].toLowerCase()];
  const dc = Number(match[2]);
  const target = match[3];
  const area = parseArea(target);
  const segments = new Map<string, string>();
  const labels = [...match[4].matchAll(SAVE_LABEL)];
  let complete = SIMPLE_SAVE_TARGET.test(target) && labels.length > 0 && labels[0].index === 0;
  labels.forEach((label, i) => {
    const start = label.index + label[0].length;
    const end = i + 1 < labels.length ? labels[i + 1].index : match[4].length;
    if (segments.has(label[1])) complete = false;
    segments.set(label[1], match[4].slice(start, end).trim());
  });
  for (const key of segments.keys()) {
    if (key !== "Failure" && key !== "Success") complete = false;
  }
  const success = segments.get("Success");
  const onSuccess = success && /^Half damage\.?/.test(success) ? "half" : "none";
  if (success !== undefined && !/^Half damage\.?$/.test(success)) complete = false;

  const damage: DamagePart[] = [];
  const riders: MonsterActionRider[] = [];
  const failure = segments.get("Failure") ?? "";
  const failureSentences = sentences(failure);
  failureSentences.forEach((sentence, i) => {
    if (i === 0 && /^\d/.test(sentence)) {
      const parsed = parseDamageList(sentence, "onFailedSave");
      damage.push(...parsed.damage);
      riders.push(...parsed.riders);
      if (!parsed.complete) complete = false;
      return;
    }
    const rider = conditionRider(sentence, "onFailedSave");
    if (rider) riders.push(rider);
    else complete = false;
  });
  if (damage.length === 0 && riders.length === 0) complete = false;
  return {
    automation: complete ? "full" : "partial",
    save: { ability, dc, ...(area ? { area } : {}), onSuccess },
    ...(damage.length > 0 ? { damage } : {}),
    ...(riders.length > 0 ? { riders } : {}),
  };
}

/** Reads `"The dragon makes three Rend attacks."` and its variants into steps over sibling action ids. */
function parseMultiattack(
  description: string,
  siblings: readonly MonsterAction[]
): { steps: MultiattackStep[]; complete: boolean } {
  const match = /^The [^.]*? makes ([^.]+)\.(?:\s+([\s\S]*))?$/.exec(description);
  if (!match) return { steps: [], complete: false };
  const idByName = new Map<string, string>();
  for (const action of siblings) {
    idByName.set(action.name.toLowerCase(), action.id);
    idByName.set(action.name.replace(/ \([^)]*Form Only\)$/, "").toLowerCase(), action.id);
  }
  const steps: MultiattackStep[] = [];
  let complete = !match[2];
  const anyCombination = /^(\w+) attacks, using (.+?) in any combination$/.exec(match[1]);
  if (anyCombination) {
    const names = anyCombination[2].split(/, or |, | or | and /);
    const ids = names.map((n) => idByName.get(n.trim().toLowerCase()));
    const count = COUNT_WORDS[anyCombination[1]];
    if (count && ids.every((id) => id !== undefined)) {
      steps.push({ actionIds: ids as string[], count });
    } else {
      complete = false;
    }
    return { steps, complete };
  }
  for (const part of match[1].split(/,? and |, /)) {
    const attack = /^(\w+) (.+?) attacks?$/.exec(part.trim());
    const use = /^uses (.+?)(?: (twice))?$/.exec(part.trim());
    const count = attack ? COUNT_WORDS[attack[1]] : use ? (use[2] ? 2 : 1) : undefined;
    const names = attack?.[2] ?? use?.[1];
    const ids = names?.split(" or ").map((n) => idByName.get(n.trim().toLowerCase()));
    if (count && ids && ids.every((id) => id !== undefined)) {
      steps.push({ actionIds: ids as string[], count });
    } else {
      complete = false;
    }
  }
  return { steps, complete: complete && steps.length > 0 };
}

const USAGE_SUFFIX = /\s*\((?:Recharge (\d)(?:[–-]6)?|(\d+)\/Day(?: Each)?|Recharge after a Short or Long Rest)\)/;
const COST_SUFFIX = /\s*\(Costs (\d) Actions\)/;

function actionUsage(fields: Record<string, unknown>, rawName: string): MonsterActionUsage | undefined {
  const type = str(fields, "uses_type");
  const param = num(fields, "uses_param");
  if ((type === "RECHARGE_ON_ROLL" || type === "RECHARGE") && param) return { kind: "recharge", minRoll: param };
  if (type === "PER_DAY" && param) return { kind: "per_day", uses: param };
  const suffix = USAGE_SUFFIX.exec(rawName);
  if (type === "RECHARGE" || suffix?.[0].includes("Short or Long Rest")) return { kind: "rest" };
  if (suffix?.[1]) return { kind: "recharge", minRoll: Number(suffix[1]) };
  if (suffix?.[2]) return { kind: "per_day", uses: Number(suffix[2]) };
  return undefined;
}

function uniqueId(base: string, used: Set<string>, suffix: string): string {
  let id = base || "action";
  if (used.has(id)) id = `${id}_${suffix}`;
  let n = 2;
  while (used.has(id)) id = `${base}_${suffix}_${n++}`;
  used.add(id);
  return id;
}

function buildAction(record: Open5eRecord, used: Set<string>, suffix: string): MonsterAction {
  const fields = record.fields;
  const rawName = str(fields, "name");
  const form = str(fields, "limited_to_form");
  const baseName = rawName.replace(USAGE_SUFFIX, "").replace(COST_SUFFIX, "").trim();
  const name = form ? `${baseName} (${form})` : baseName;
  const description = cleanText(str(fields, "desc"));
  const usage = actionUsage(fields, rawName);
  const parsed = parseAttackAction(description) ?? parseSaveAction(description) ?? { automation: "text" as const };
  const legendaryCost =
    str(fields, "action_type") === "LEGENDARY_ACTION"
      ? Number(COST_SUFFIX.exec(rawName)?.[1] ?? num(fields, "legendary_action_cost") ?? 1)
      : undefined;
  return {
    id: uniqueId(snakeKey(name), used, suffix),
    name,
    description,
    automation: parsed.automation,
    ...(parsed.attack ? { attack: parsed.attack } : {}),
    ...(parsed.save ? { save: parsed.save } : {}),
    ...(parsed.damage ? { damage: parsed.damage } : {}),
    ...(parsed.riders ? { riders: parsed.riders } : {}),
    ...(usage ? { usage } : {}),
    ...(legendaryCost !== undefined ? { legendaryCost } : {}),
  };
}

function buildActionList(records: Open5eRecord[], used: Set<string>, suffix: string): MonsterAction[] {
  const sorted = [...records].sort(
    (a, b) =>
      (num(a.fields, "order_in_statblock") ?? 0) - (num(b.fields, "order_in_statblock") ?? 0) ||
      str(a.fields, "name").localeCompare(str(b.fields, "name"))
  );
  const multiattacks = sorted.filter((r) => str(r.fields, "name") === "Multiattack");
  const actions = sorted.filter((r) => str(r.fields, "name") !== "Multiattack").map((r) => buildAction(r, used, suffix));
  const multi = multiattacks.map((record): MonsterAction => {
    const description = cleanText(str(record.fields, "desc"));
    const { steps, complete } = parseMultiattack(description, actions);
    return {
      id: uniqueId("multiattack", used, suffix),
      name: "Multiattack",
      description,
      automation: steps.length === 0 ? "text" : complete ? "full" : "partial",
      ...(steps.length > 0 ? { multiattack: steps } : {}),
    };
  });
  return [...multi, ...actions];
}

// ============================================================================
// MONSTERS
// ============================================================================

function buildStatBlock(
  creature: Open5eRecord,
  actions: Open5eRecord[],
  traits: Open5eRecord[]
): MonsterStatBlock {
  const f = creature.fields;
  const key = stripPrefix(creature.pk);
  const fix = monsterCorrection(key);

  const abilities = Object.fromEntries(
    ABILITIES.map((ab) => [ab, fix.abilities?.[ab] ?? num(f, `ability_score_${ABILITY_NAMES[ab]}`) ?? 10])
  ) as Record<AbilityId, number>;
  const savingThrows: Partial<Record<AbilityId, number>> = {};
  for (const ab of ABILITIES) {
    const total = fix.savingThrows?.[ab] ?? num(f, `saving_throw_${ABILITY_NAMES[ab]}`);
    if (total !== undefined && total !== abilityMod(abilities[ab])) savingThrows[ab] = total;
  }
  const skills: Partial<Record<SkillId, number>> = {};
  for (const skill of SKILLS) {
    const total = fix.skills?.[skill] ?? num(f, `skill_bonus_${skill}`);
    if (total !== undefined) skills[skill] = total;
  }

  const speed: MonsterStatBlock["speed"] = { walk: num(f, "walk") ?? 0 };
  for (const mode of ["fly", "swim", "climb", "burrow"] as const) {
    const value = num(f, mode);
    if (value) speed[mode] = value;
  }
  if (f.hover === true) speed.hover = true;

  const senses: MonsterStatBlock["senses"] = { passivePerception: num(f, "passive_perception") ?? 10 };
  for (const sense of ["darkvision", "blindsight", "tremorsense", "truesight"] as const) {
    const value = num(f, `${sense}_range`);
    if (value) senses[sense] = value;
  }

  const cr = Number(str(f, "challenge_rating") || "0");
  const used = new Set<string>();
  const ofType = (type: string) => actions.filter((a) => str(a.fields, "action_type") === type);
  const legendaryRecords = ofType("LEGENDARY_ACTION");

  const traitIds = new Set<string>();
  const traitList: MonsterTrait[] = traits.map((t) => ({
    id: uniqueId(snakeKey(str(t.fields, "name")), traitIds, "trait"),
    name: str(t.fields, "name"),
    description: cleanText(str(t.fields, "desc")),
  }));
  const resistance = traitList
    .map((t) => /^Legendary Resistance \((\d+)\/Day(?:, or (\d+)\/Day in Lair)?\)/.exec(t.name))
    .find((m) => m !== null);

  const statBlock: MonsterStatBlock = {
    name: str(f, "name"),
    size: fix.size ?? (str(f, "size") as CreatureSize),
    creatureType: str(f, "type") as CreatureType,
    alignment: str(f, "alignment"),
    armorClass: { value: num(f, "armor_class") ?? 10 },
    hitPoints: { average: num(f, "hit_points") ?? 1, formula: normalizeDice(str(f, "hit_dice")) },
    speed,
    abilities,
    savingThrows,
    skills,
    initiativeBonus: num(f, "initiative_bonus") ?? abilityMod(abilities.dex),
    senses,
    languages: str(f, "languages_desc"),
    challengeRating: cr,
    xp: fix.xp ?? xpForChallengeRating(cr),
    proficiencyBonus: proficiencyBonusForChallengeRating(cr),
    damageVulnerabilities: fix.damageVulnerabilities ?? (strings(f, "damage_vulnerabilities") as DamageType[]),
    damageResistances: fix.damageResistances ?? (strings(f, "damage_resistances") as DamageType[]),
    damageImmunities: fix.damageImmunities ?? (strings(f, "damage_immunities") as DamageType[]),
    conditionImmunities: fix.conditionImmunities ?? (strings(f, "condition_immunities") as ConditionId[]),
    ...(resistance
      ? { legendaryResistance: { uses: Number(resistance[1]), ...(resistance[2] ? { lairUses: Number(resistance[2]) } : {}) } }
      : {}),
    traits: traitList,
    actions: buildActionList(ofType("ACTION"), used, "action"),
    bonusActions: buildActionList(ofType("BONUS_ACTION"), used, "bonus"),
    reactions: buildActionList(ofType("REACTION"), used, "reaction"),
    source: "srd-5.2.1",
  };
  if (legendaryRecords.length > 0) {
    const options = buildActionList(legendaryRecords, used, "legendary");
    statBlock.legendaryActions = { ...legendaryActionUses(key), options };
  }
  return statBlock;
}

function monsterEntry(creature: Open5eRecord, actions: Open5eRecord[], traits: Open5eRecord[]): CompendiumEntry {
  const key = stripPrefix(creature.pk);
  const id = MONSTER_ID_ALIASES[key] ?? `srd:monster:${snakeKey(key)}`;
  const statBlock = buildStatBlock(creature, actions, traits);
  return {
    id,
    slug: id,
    name: statBlock.name,
    entityType: "monster",
    tier: "SYSTEM_SRD",
    data: { ...monsterSheetFromStatBlock(id, statBlock), statBlock },
  };
}

// ============================================================================
// SPELLS
// ============================================================================

const CASTING_TIMES: Record<string, string> = {
  action: "1 action",
  "bonus-action": "1 bonus action",
  reaction: "1 reaction",
  "1minute": "1 minute",
  "10minutes": "10 minutes",
  "1hour": "1 hour",
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function spellEntry(record: Open5eRecord): CompendiumEntry {
  const f = record.fields;
  const key = stripPrefix(record.pk);
  const id = `srd:spell:${snakeKey(str(f, "name"))}`;
  const description = SPELL_DESCRIPTIONS[key] ?? cleanText(str(f, "desc"));
  const concentration = f.concentration === true;
  const duration = capitalize(str(f, "duration"));
  const classes = [
    ...new Set([...strings(f, "classes").map(stripPrefix), ...(SPELL_CLASS_ADDITIONS[key] ?? [])]),
  ].sort();
  const components = (["V", "S", "M"] as const).filter(
    (c) => f[{ V: "verbal", S: "somatic", M: "material" }[c]] === true
  );

  const damage: { dice: string; type: DamageType }[] = [];
  for (const match of description.matchAll(new RegExp(`(\\d+d\\d+(?: ?[+−-] ?\\d+)?) (${DAMAGE_TYPES}) damage`, "g"))) {
    const part = { dice: normalizeDice(match[1]), type: match[2].toLowerCase() as DamageType };
    if (!damage.some((d) => d.dice === part.dice && d.type === part.type)) damage.push(part);
  }
  const save = new RegExp(`(${ABILITY_WORDS}) saving throw`, "i").exec(description);
  const attack = /(melee|ranged) spell attack/i.exec(description);
  const heal = /regains? (?:a number of )?Hit Points equal to (\d+d\d+(?: ?\+ ?\d+)?)|regains? (\d+d\d+(?: ?\+ ?\d+)?) Hit Points/i.exec(description);
  const area = parseArea(description);
  const material = str(f, "material_specified");
  const materialCost = Number(str(f, "material_cost") || "0");
  const higherLevel = cleanText(str(f, "higher_level"));
  const reaction = str(f, "reaction_condition");

  return {
    id,
    slug: id,
    name: str(f, "name"),
    entityType: "spell",
    tier: "SYSTEM_SRD",
    data: {
      level: num(f, "level") ?? 0,
      school: str(f, "school"),
      classes,
      castingTime: CASTING_TIMES[str(f, "casting_time")] ?? str(f, "casting_time"),
      ...(reaction ? { reactionTrigger: reaction } : {}),
      range: str(f, "range_text"),
      components,
      ...(material ? { material } : {}),
      ...(materialCost > 0 ? { materialCostGp: materialCost } : {}),
      ...(f.material_consumed === true ? { materialConsumed: true } : {}),
      duration: concentration ? `Concentration, up to ${duration.toLowerCase()}` : duration,
      concentration,
      ritual: f.ritual === true,
      ...(attack ? { attackType: attack[1].toLowerCase() } : {}),
      ...(save ? { saveAbility: ABILITY_BY_NAME[save[1].toLowerCase()] } : {}),
      ...(/half as much damage on a successful/i.test(description) ? { halfDamageOnSave: true } : {}),
      ...(damage.length > 0 ? { damageDice: damage[0].dice, damageType: damage[0].type, damage } : {}),
      ...(heal ? { healDice: normalizeDice(heal[1] ?? heal[2]) } : {}),
      ...(area ? { area } : {}),
      description,
      ...(higherLevel ? { higherLevel } : {}),
      source: "srd-5.2.1",
    },
  };
}

// ============================================================================
// MAGIC ITEMS
// ============================================================================

const RARITY_ORDER = ["common", "uncommon", "rare", "very_rare", "legendary", "artifact"];

function groupName(names: string[], category: string): string {
  if (names.length === 1) return names[0];
  if (names.every((n) => /\(\+\d\)$/.test(n))) {
    const plain = new Set(names.map((n) => n.replace(/ \(\+\d\)$/, "")));
    const only = plain.size === 1 ? [...plain][0] : "";
    return MAGIC_ITEM_GROUP_NAMES[only] ?? MAGIC_ITEM_GROUP_NAMES[category === "armor" ? "armor:+N" : "weapon:+N"];
  }
  const bases = new Set(names.map((n) => n.replace(/ \(.*\)$/, "").replace(/ \+\d$/, "")));
  if (bases.size === 1) {
    const base = [...bases][0];
    return MAGIC_ITEM_GROUP_NAMES[base] ?? base;
  }
  const words = names.map((n) => n.split(" "));
  const prefix: string[] = [];
  for (let i = 0; words.every((w) => i < w.length && w[i] === words[0][i]); i++) prefix.push(words[0][i]);
  if (prefix.length > 0) {
    const label = prefix.join(" ");
    return MAGIC_ITEM_GROUP_NAMES[label] ?? label;
  }
  const suffix = /( of [A-Z][\w ]+)$/.exec(names[0])?.[1].trim();
  if (suffix && names.every((n) => n.endsWith(suffix))) return MAGIC_ITEM_GROUP_NAMES[suffix] ?? suffix;
  throw new Error(`No SRD name for magic item group: ${names.join(", ")}`);
}

function magicItemEntries(records: Open5eRecord[]): CompendiumEntry[] {
  const baseOf = (fields: Record<string, unknown>) => stripPrefix(str(fields, "weapon") || str(fields, "armor"));
  // Open5e repeats Defender and Holy Avenger as a generic record (no base
  // weapon) whose text only differs from the per-weapon variants by
  // paragraph breaks: group on collapsed whitespace, then drop that record.
  const groups = new Map<string, Open5eRecord[]>();
  for (const record of records) {
    const desc = str(record.fields, "desc").replace(/\s+/g, " ");
    groups.set(desc, [...(groups.get(desc) ?? []), record]);
  }
  return [...groups.values()].map((allRecords): CompendiumEntry => {
    const generic = (r: Open5eRecord) =>
      !baseOf(r.fields) && allRecords.some((o) => o !== r && str(o.fields, "name").startsWith(`${str(r.fields, "name")} (`));
    const group = allRecords.filter((r) => !generic(r));
    const first = group[0].fields;
    const category = str(first, "category").replace(/-/g, "_");
    const name = groupName(group.map((r) => str(r.fields, "name")), category);
    const id = `srd:item:${snakeKey(name)}`;
    const rarities = [
      ...new Set(MAGIC_ITEM_RARITIES[stripPrefix(group[0].pk)] ?? group.map((r) => str(r.fields, "rarity").replace(/-/g, "_"))),
    ].sort((a, b) => RARITY_ORDER.indexOf(a) - RARITY_ORDER.indexOf(b));
    const requiresAttunement = group.some((r) => r.fields.requires_attunement === true);
    const variants = group.map((r) => ({
      name: str(r.fields, "name"),
      rarity: str(r.fields, "rarity").replace(/-/g, "_"),
      ...(baseOf(r.fields) ? { baseItem: snakeKey(baseOf(r.fields)) } : {}),
    }));
    return {
      id,
      slug: id,
      name,
      entityType: "item",
      tier: "SYSTEM_SRD",
      data: {
        magic: true,
        category,
        rarity: rarities.length === 1 ? rarities[0] : "varies",
        ...(rarities.length > 1 ? { rarities } : {}),
        requiresAttunement,
        ...(group.length === 1 && baseOf(first) ? { baseItem: snakeKey(baseOf(first)) } : {}),
        ...(group.length > 1 ? { variants } : {}),
        description: cleanText(str(first, "desc")),
        source: "srd-5.2.1",
      },
    };
  });
}

const RARITY_WORDS = "Common|Uncommon|Rare|Very Rare|Legendary";
/** Markdown table row whose last cell is a rarity: `| Potion of Healing (greater) | 4d4 + 4 | Uncommon |`. */
const RARITY_TABLE_ROW = new RegExp(`^\\| ([^|]+?) +\\|(?: ([^|]+?) +\\|)*? (${RARITY_WORDS}) +\\|$`, "gm");
/** Inline variant heading: `Agility (Very Rare). Your Dexterity increases ...`. */
const RARITY_HEADING = new RegExp(`(?:^|\\. )([A-Z][a-z]+(?: [A-Z][a-z]+)?) \\((${RARITY_WORDS})\\)\\. `, "g");

function rarityKey(word: string): string {
  return word.toLowerCase().replace(" ", "_");
}

/** `"Potion of Giant Strength (frost or stone)"` -> `"Potion of Giant Strength (Frost or Stone)"`. */
function titleQualifier(name: string): string {
  return name.replace(/\(([^)]+)\)/, (_, qualifier: string) => `(${qualifier.replace(/\b[a-z]{3,}/g, capitalize)})`);
}

/**
 * Magic items Open5e files as adventuring gear (`GEAR_MAGIC_ITEMS`). Potions
 * of Healing become one entry per potency so each carries its own `healDice`
 * and rarity, and the common one keeps the curated `potion_of_healing` id;
 * the other items become one entry whose variants come from their text.
 */
function gearMagicItemEntries(records: Open5eRecord[]): CompendiumEntry[] {
  const byKey = new Map(records.map((r) => [stripPrefix(r.pk), r.fields]));
  const entries: CompendiumEntry[] = [];
  const entry = (name: string, data: Record<string, unknown>): CompendiumEntry => {
    const id = `srd:item:${snakeKey(name)}`;
    return { id, slug: id, name, entityType: "item", tier: "SYSTEM_SRD", data: { magic: true, ...data, source: "srd-5.2.1" } };
  };
  for (const [key, spec] of Object.entries(GEAR_MAGIC_ITEMS)) {
    const fields = byKey.get(key);
    if (!fields) throw new Error(`Open5e Item.json has no ${key} record`);
    const text = cleanText(str(fields, "desc"));
    const base = { category: spec.category, requiresAttunement: spec.requiresAttunement };
    if (key === "potions-of-healing") {
      const single = cleanText(str(byKey.get("potion-of-healing") ?? {}, "desc"));
      const description = single ? `${single}\n\n${text}` : text;
      for (const [, name, healDice, rarity] of text.matchAll(RARITY_TABLE_ROW)) {
        entries.push(entry(titleQualifier(name), { ...base, rarity: rarityKey(rarity), healDice: normalizeDice(healDice), description }));
      }
      continue;
    }
    const name = str(fields, "name");
    const variants = [
      ...[...text.matchAll(RARITY_TABLE_ROW)].map(([, row, , rarity]) => ({ name: titleQualifier(row), rarity: rarityKey(rarity) })),
      ...[...text.matchAll(RARITY_HEADING)].map(([, type, rarity]) => ({ name: `${name} (${type})`, rarity: rarityKey(rarity) })),
    ];
    const rarities = [...new Set(variants.map((v) => v.rarity))].sort(
      (a, b) => RARITY_ORDER.indexOf(a) - RARITY_ORDER.indexOf(b)
    );
    const rarity = spec.rarity ?? (rarities.length === 1 ? rarities[0] : "varies");
    entries.push(
      entry(name, {
        ...base,
        rarity,
        ...(rarity === "varies" ? { rarities } : {}),
        ...(variants.length > 1 ? { variants } : {}),
        description: text,
      })
    );
  }
  return entries;
}

// ============================================================================
// ENTRY POINTS
// ============================================================================

/** Builds the three generated packs from a pinned Open5e snapshot. Pure and deterministic. */
export function buildSrdPacks(snapshot: Open5eSnapshot): SrdPacks {
  const byParent = (records: Open5eRecord[]) => {
    const map = new Map<string, Open5eRecord[]>();
    for (const r of records) {
      const parent = str(r.fields, "parent");
      map.set(parent, [...(map.get(parent) ?? []), r]);
    }
    return map;
  };
  const actions = byParent(snapshot.creatureActions);
  const traits = byParent(snapshot.creatureTraits);
  const srdOnly = (records: Open5eRecord[]) =>
    records.filter((r) => String(r.pk).startsWith(`${OPEN5E_SOURCE.documentKey}_`));

  return {
    spells: srdOnly(snapshot.spells).map(spellEntry).sort(byId),
    monsters: srdOnly(snapshot.creatures)
      .map((c) => monsterEntry(c, actions.get(String(c.pk)) ?? [], traits.get(String(c.pk)) ?? []))
      .sort(byId),
    magicItems: [...magicItemEntries(srdOnly(snapshot.magicItems)), ...gearMagicItemEntries(srdOnly(snapshot.items))].sort(byId),
  };
}

/** Serializes a pack as a JSON array with one entry per line (stable, diff-friendly). */
export function serializePack(entries: readonly CompendiumEntry[]): string {
  return `[\n${entries.map((e) => JSON.stringify(e)).join(",\n")}\n]\n`;
}
