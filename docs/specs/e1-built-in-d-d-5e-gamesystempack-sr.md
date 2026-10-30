# Technical & Functional Specification: Built-in D&D 5e GameSystemPack (SRD 5.1)

## 1. Context & Objectives

This specification defines the complete implementation of the built-in D&D 5e system pack (`packages/game-systems/dnd5e`) for TRAME V1. The pack builds upon the generic `crates/trame-engine` core and standardizes the reference rules of the System Reference Document 5.1 (SRD 5.1) under the Creative Commons CC-BY-4.0 license.

The module provides:
1. The declarative manifest `packages/game-systems/dnd5e/system.json` describing abilities, skills, and `derivedDAG` acyclic graph formulas.
2. Strict TypeScript schemas in `packages/game-systems/dnd5e/src/manifest.ts` and `types.ts` for `Dnd5eActorData`, `AbilityId`, `SkillId`, `ProficiencyRank`, and `ResourcePool`.
3. The deterministic damage pipeline in `packages/game-systems/dnd5e/src/pipeline.ts` handling multi-type damage instances, priority absorption by temporary HP, instant death, automatic death saving throw failures at 0 HP, and generation of the concentration check prompt (`ConcentrationCheckPrompt`).
4. Short rest (`applyShortRest`) and long rest (`applyLongRest`) functions restoring hit dice, spell slots, and resource pools configured with `SHORT_REST` or `LONG_REST`.
5. Condition duration decrementation according to turn triggers (`ROUNDS`, `TURNS_START`, `TURNS_END`) correlated with the active turn actor.
6. Pure progression tables and functions for levels 1 through 20 in `packages/game-systems/dnd5e/src/progression.ts` for proficiency bonus, spell slots (full casters, half casters, and pact magic), and leveling up (`applyLevelUp`).
7. The immutable hierarchical resolver `CompendiumResolver` in `packages/game-systems/dnd5e/src/compendium.ts` enforcing the `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` cascade with CC-BY-4.0 legal attribution.

---

## 2. Architecture & File Organization

```text
packages/game-systems/dnd5e/
├── package.json
├── system.json
└── src/
    ├── index.ts
    ├── types.ts
    ├── manifest.ts
    ├── pipeline.ts
    ├── progression.ts
    └── compendium.ts
```

All automated tests are executed via the native Node 24 test runner (`node --test`) configured in `packages/web`:
- `packages/web/tests/dnd5e.test.ts`

---

## 3. Data Schemas & Declarative Manifest (`system.json` & `manifest.ts`)

### 3.1 Core Types (`types.ts` & `manifest.ts`)

The `manifest.ts` module declares the following strict types:

```typescript
export type AbilityId = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

export type SkillId =
  | 'acrobatics'
  | 'animal_handling'
  | 'arcana'
  | 'athletics'
  | 'deception'
  | 'history'
  | 'insight'
  | 'intimidation'
  | 'investigation'
  | 'medicine'
  | 'nature'
  | 'perception'
  | 'performance'
  | 'persuasion'
  | 'religion'
  | 'sleight_of_hand'
  | 'stealth'
  | 'survival';

export type ProficiencyRank = 0 | 1 | 2;

export type DamageType =
  | 'acid'
  | 'bludgeoning'
  | 'cold'
  | 'fire'
  | 'force'
  | 'lightning'
  | 'necrotic'
  | 'piercing'
  | 'poison'
  | 'psychic'
  | 'radiant'
  | 'slashing'
  | 'thunder';

export type MitigationLevel = 'IMMUNE' | 'RESISTANT' | 'VULNERABLE' | 'NONE';

export type RestType = 'SHORT_REST' | 'LONG_REST';

export type TurnTrigger = 'ROUNDS' | 'TURNS_START' | 'TURNS_END';

export interface ResourcePool {
  current: number;
  max: number;
  resetOn: RestType;
}

export interface DeathSavesState {
  successes: number;
  failures: number;
}

export interface ActiveConditionState {
  id: string;
  name: string;
  durationRounds: number;
  appliedTurnActorId?: string;
  trigger: TurnTrigger;
}

export interface SpellSlotTier {
  current: number;
  max: number;
}

export interface SpellSlotsState {
  level1?: SpellSlotTier;
  level2?: SpellSlotTier;
  level3?: SpellSlotTier;
  level4?: SpellSlotTier;
  level5?: SpellSlotTier;
  level6?: SpellSlotTier;
  level7?: SpellSlotTier;
  level8?: SpellSlotTier;
  level9?: SpellSlotTier;
  pact?: SpellSlotTier;
}

export interface Dnd5eActorData {
  id: string;
  name: string;
  type: 'character' | 'npc' | 'monster';
  abilities: Record<AbilityId, { score: number; saveProficiency: boolean }>;
  skills: Record<SkillId, { ability: AbilityId; proficiencyRank: ProficiencyRank }>;
  attributes: {
    level: number;
    hp: {
      current: number;
      max: number;
      temp: number;
    };
    hitDiceMax: number;
    hitDiceCurrent: number;
    hitDieSize: number;
    exhaustion: number;
    deathSaves: DeathSavesState;
    spellcastingAbility?: AbilityId;
    baseArmorAC?: number;
    shieldBonus?: number;
    armorType?: 'none' | 'light' | 'medium' | 'heavy';
  };
  damageMitigations: Record<DamageType, MitigationLevel>;
  conditions: ActiveConditionState[];
  resources?: Record<string, ResourcePool>;
  spellSlots?: SpellSlotsState;
  concentratingOnSpellId?: string;
  isDead?: boolean;
}
```

### 3.2 Declarative System Manifest (`system.json`)

The `system.json` file provides the configuration read by `trame-engine` for validation and `derivedDAG` evaluation:

```json
{
  "id": "dnd5e",
  "name": "Dungeons & Dragons 5th Edition (SRD 5.1)",
  "version": "1.0.0",
  "license": "CC-BY-4.0",
  "attribution": "This work includes material taken from the System Reference Document 5.1 (\"SRD 5.1\") by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode.",
  "actorTypes": ["character", "npc", "monster"],
  "itemTypes": ["weapon", "armor", "shield", "spell", "consumable", "feature", "equipment"],
  "abilities": ["str", "dex", "con", "int", "wis", "cha"],
  "skills": [
    "acrobatics",
    "animal_handling",
    "arcana",
    "athletics",
    "deception",
    "history",
    "insight",
    "intimidation",
    "investigation",
    "medicine",
    "nature",
    "perception",
    "performance",
    "persuasion",
    "religion",
    "sleight_of_hand",
    "stealth",
    "survival"
  ],
  "derivedDAG": {
    "abilities.str.mod": "floor((abilities.str.score - 10) / 2)",
    "abilities.dex.mod": "floor((abilities.dex.score - 10) / 2)",
    "abilities.con.mod": "floor((abilities.con.score - 10) / 2)",
    "abilities.int.mod": "floor((abilities.int.score - 10) / 2)",
    "abilities.wis.mod": "floor((abilities.wis.score - 10) / 2)",
    "abilities.cha.mod": "floor((abilities.cha.score - 10) / 2)",
    "attributes.proficiencyBonus": "floor((attributes.level - 1) / 4) + 2",
    "skills.perception.modifier": "abilities.wis.mod + (skills.perception.proficiencyRank * attributes.proficiencyBonus)",
    "attributes.passivePerception": "10 + abilities.wis.mod + (skills.perception.proficiencyRank * attributes.proficiencyBonus)",
    "attributes.spellSaveDC": "8 + attributes.proficiencyBonus + abilities[attributes.spellcastingAbility].mod",
    "attributes.spellAttackModifier": "attributes.proficiencyBonus + abilities[attributes.spellcastingAbility].mod",
    "attributes.armorClass": "(attributes.armorType == 'none') ? (10 + abilities.dex.mod + (attributes.shieldBonus || 0)) : (attributes.baseArmorAC + min(abilities.dex.mod, (attributes.armorType == 'medium' ? 2 : (attributes.armorType == 'heavy' ? 0 : 99))) + (attributes.shieldBonus || 0))",
    "attributes.encumbrance.carryingCapacity": "abilities.str.score * 15",
    "attributes.encumbrance.heavilyEncumbered": "abilities.str.score * 10",
    "attributes.encumbrance.encumbered": "abilities.str.score * 5"
  }
}
```

### 3.3 Derived Calculation Function (`computeDnd5eSheetDerived`)

The `manifest.ts` module exposes the pure synchronous function `computeDnd5eSheetDerived(actor: Dnd5eActorData)` that computes derived values mirroring the `derivedDAG` graph for tests running without the WASM runtime:
1. Computes each ability modifier: `Math.floor((score - 10) / 2)`.
2. Computes the proficiency bonus: `Math.floor((level - 1) / 4) + 2`.
3. Computes passive perception: `10 + wisMod + (perceptionRank * profBonus)`.
4. Computes Armor Class (AC) based on armor type (`none` -> 10 + DEX mod, `light` -> baseAC + DEX mod, `medium` -> baseAC + min(DEX mod, 2), `heavy` -> baseAC) plus any shield bonus.
5. Computes spell save DC: `8 + profBonus + abilityMod` (when `spellcastingAbility` is defined).

---

## 4. Damage, Death & Concentration Pipeline (`pipeline.ts`)

### 4.1 Interface and Output Contract

```typescript
export interface DamageInstance {
  amount: number;
  type: DamageType;
}

export interface DamagePipelineOptions {
  isCritical?: boolean;
}

export interface ConcentrationPrompt {
  spellId: string;
  dc: number;
}

export interface DamageResolutionResult {
  actor: Dnd5eActorData;
  totalMitigatedDamage: number;
  damageAppliedToTempHp: number;
  damageAppliedToCurrentHp: number;
  instantDeath: boolean;
  deathSavesModified: boolean;
  concentrationPrompt?: ConcentrationPrompt;
}
```

### 4.2 Deterministic Algorithm for `resolveDamagePipeline`

The `resolveDamagePipeline(actor: Dnd5eActorData, damageInstances: DamageInstance[], options: DamagePipelineOptions = {}): DamageResolutionResult` function applies the following algorithm:

1. Deep-clone the `actor` object to preserve immutability of the input argument.
2. For each `instance` in `damageInstances`:
   - Retrieve `mitigation = clone.damageMitigations[instance.type] || 'NONE'`.
   - IF `mitigation === 'IMMUNE'`, THEN the damage for this instance is 0.
   - ELSE IF `mitigation === 'RESISTANT'`, THEN the damage for this instance is `Math.floor(instance.amount * 0.5)`.
   - ELSE IF `mitigation === 'VULNERABLE'`, THEN the damage for this instance is `instance.amount * 2`.
   - ELSE, THEN the damage for this instance is `instance.amount`.
   - Add the resulting damage to `totalMitigatedDamage`.
3. IF `totalMitigatedDamage === 0`, THEN immediately return the result with the unmodified actor, no concentration prompt, and no HP alteration.
4. Process according to the actor's current HP state:
   - **Case A: The actor is already at 0 HP (`clone.attributes.hp.current === 0`)**:
     - IF `totalMitigatedDamage >= clone.attributes.hp.max`, THEN:
       - The `pipeline` component sets `clone.isDead = true`.
       - The `pipeline` component sets `clone.attributes.deathSaves.failures = 3`.
       - The `pipeline` component returns `instantDeath = true`.
     - ELSE:
       - The `pipeline` component computes the number of added failures: `addedFailures = options.isCritical ? 2 : 1`.
       - The `pipeline` component increments `clone.attributes.deathSaves.failures = Math.min(3, clone.attributes.deathSaves.failures + addedFailures)`.
       - IF `clone.attributes.deathSaves.failures >= 3`, THEN the `pipeline` component sets `clone.isDead = true`.
     - The `pipeline` component returns `damageAppliedToTempHp = 0` and `damageAppliedToCurrentHp = 0`.
   - **Case B: The actor has more than 0 HP (`clone.attributes.hp.current > 0`)**:
     - The `pipeline` component initializes `unabsorbedDamage = totalMitigatedDamage`.
     - IF `clone.attributes.hp.temp > 0`, THEN:
       - `damageAppliedToTempHp = Math.min(clone.attributes.hp.temp, unabsorbedDamage)`.
       - `clone.attributes.hp.temp -= damageAppliedToTempHp`.
       - `unabsorbedDamage -= damageAppliedToTempHp`.
     - ELSE, `damageAppliedToTempHp = 0`.
     - IF `unabsorbedDamage > 0`, THEN:
       - `damageAppliedToCurrentHp = Math.min(clone.attributes.hp.current, unabsorbedDamage)`.
       - `clone.attributes.hp.current -= damageAppliedToCurrentHp`.
       - `excessDamage = unabsorbedDamage - damageAppliedToCurrentHp`.
     - ELSE, `damageAppliedToCurrentHp = 0` and `excessDamage = 0`.
     - IF `clone.attributes.hp.current === 0`, THEN:
       - IF `excessDamage >= clone.attributes.hp.max`, THEN:
         - The `pipeline` component sets `clone.isDead = true`.
         - The `pipeline` component sets `clone.attributes.deathSaves.failures = 3`.
         - The `pipeline` component returns `instantDeath = true`.
       - ELSE:
         - The `pipeline` component checks whether the `unconscious` condition already exists in `clone.conditions`; if absent, it appends `{ id: 'unconscious', name: 'Unconscious', durationRounds: 999, trigger: 'ROUNDS' }`.
5. Process concentration:
   - IF `clone.concentratingOnSpellId` is defined AND `clone.isDead !== true` AND `clone.attributes.hp.current > 0` AND `totalMitigatedDamage > 0`, THEN:
     - The `pipeline` component computes `concentrationDC = Math.max(10, Math.floor(totalMitigatedDamage / 2))`.
     - The `pipeline` component returns `concentrationPrompt = { spellId: clone.concentratingOnSpellId, dc: concentrationDC }`.
   - IF `clone.attributes.hp.current === 0` AND `clone.concentratingOnSpellId` is defined, THEN the `pipeline` component resets `clone.concentratingOnSpellId = undefined` because unconsciousness or death immediately breaks concentration.

### 4.3 Deterministic Algorithm for `rollDeathSavingThrow`

```typescript
export function rollDeathSavingThrow(
  actor: Dnd5eActorData,
  d20Roll: number
): { actor: Dnd5eActorData; outcome: 'success' | 'failure' | 'revived' | 'dead' | 'stabilized' }
```

1. Deep-clone the `actor` object.
2. IF `d20Roll === 1`, THEN:
   - `clone.attributes.deathSaves.failures += 2`.
   - IF `clone.attributes.deathSaves.failures >= 3`, THEN `clone.isDead = true`, outcome = `'dead'`; ELSE outcome = `'failure'`.
3. ELSE IF `d20Roll === 20`, THEN:
   - `clone.attributes.hp.current = 1`.
   - `clone.attributes.deathSaves.successes = 0`.
   - `clone.attributes.deathSaves.failures = 0`.
   - Remove the `'unconscious'` condition if present.
   - outcome = `'revived'`.
4. ELSE IF `d20Roll >= 10`, THEN:
   - `clone.attributes.deathSaves.successes += 1`.
   - IF `clone.attributes.deathSaves.successes >= 3`, THEN:
     - `clone.attributes.deathSaves.successes = 0`.
     - `clone.attributes.deathSaves.failures = 0`.
     - outcome = `'stabilized'`.
   - ELSE outcome = `'success'`.
5. ELSE (`d20Roll < 10`):
   - `clone.attributes.deathSaves.failures += 1`.
   - IF `clone.attributes.deathSaves.failures >= 3`, THEN `clone.isDead = true`, outcome = `'dead'`; ELSE outcome = `'failure'`.

---

## 5. Progression & Leveling Up (`progression.ts`)

### 5.1 Declarative Spell Slot Tables (Levels 1 to 20)

The `progression.ts` module contains exhaustive static matrices with no ellipsis:

- **Full Caster (Bard, Cleric, Druid, Sorcerer, Wizard)**:

| Level | 1st | 2nd | 3rd | 4th | 5th | 6th | 7th | 8th | 9th |
|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| 1 | 2 | - | - | - | - | - | - | - | - |
| 2 | 3 | - | - | - | - | - | - | - | - |
| 3 | 4 | 2 | - | - | - | - | - | - | - |
| 4 | 4 | 3 | - | - | - | - | - | - | - |
| 5 | 4 | 3 | 2 | - | - | - | - | - | - |
| 6 | 4 | 3 | 3 | - | - | - | - | - | - |
| 7 | 4 | 3 | 3 | 1 | - | - | - | - | - |
| 8 | 4 | 3 | 3 | 2 | - | - | - | - | - |
| 9 | 4 | 3 | 3 | 3 | 1 | - | - | - | - |
| 10 | 4 | 3 | 3 | 3 | 2 | - | - | - | - |
| 11 | 4 | 3 | 3 | 3 | 2 | 1 | - | - | - |
| 12 | 4 | 3 | 3 | 3 | 2 | 1 | - | - | - |
| 13 | 4 | 3 | 3 | 3 | 2 | 1 | 1 | - | - |
| 14 | 4 | 3 | 3 | 3 | 2 | 1 | 1 | - | - |
| 15 | 4 | 3 | 3 | 3 | 2 | 1 | 1 | 1 | - |
| 16 | 4 | 3 | 3 | 3 | 2 | 1 | 1 | 1 | - |
| 17 | 4 | 3 | 3 | 3 | 2 | 1 | 1 | 1 | 1 |
| 18 | 4 | 3 | 3 | 3 | 3 | 1 | 1 | 1 | 1 |
| 19 | 4 | 3 | 3 | 3 | 3 | 2 | 1 | 1 | 1 |
| 20 | 4 | 3 | 3 | 3 | 3 | 2 | 2 | 1 | 1 |

- **Half Caster (Paladin, Ranger)**:

| Level | 1st | 2nd | 3rd | 4th | 5th |
|:---|:---|:---|:---|:---|:---|
| 1 | - | - | - | - | - |
| 2 | 2 | - | - | - | - |
| 3 | 3 | - | - | - | - |
| 4 | 3 | - | - | - | - |
| 5 | 4 | 2 | - | - | - |
| 6 | 4 | 2 | - | - | - |
| 7 | 4 | 3 | - | - | - |
| 8 | 4 | 3 | - | - | - |
| 9 | 4 | 3 | 2 | - | - |
| 10 | 4 | 3 | 2 | - | - |
| 11 | 4 | 3 | 3 | - | - |
| 12 | 4 | 3 | 3 | - | - |
| 13 | 4 | 3 | 3 | 1 | - |
| 14 | 4 | 3 | 3 | 1 | - |
| 15 | 4 | 3 | 3 | 2 | - |
| 16 | 4 | 3 | 3 | 2 | - |
| 17 | 4 | 3 | 3 | 3 | 1 |
| 18 | 4 | 3 | 3 | 3 | 1 |
| 19 | 4 | 3 | 3 | 3 | 2 |
| 20 | 4 | 3 | 3 | 3 | 2 |

- **Pact Magic (Warlock)**:

| Level | Slot Count | Slot Level |
|:---|:---|:---|
| 1 | 1 | 1st |
| 2 | 2 | 1st |
| 3 | 2 | 2nd |
| 4 | 2 | 2nd |
| 5 | 2 | 3rd |
| 6 | 2 | 3rd |
| 7 | 2 | 4th |
| 8 | 2 | 4th |
| 9 | 2 | 5th |
| 10 | 2 | 5th |
| 11-16 | 3 | 5th |
| 17-20 | 4 | 5th |

### 5.2 Level-Up Helper (`applyLevelUp`)

```typescript
export interface LevelUpOptions {
  hpIncreaseMode: 'fixed' | 'roll';
  rolledHp?: number;
  casterType?: 'full' | 'half' | 'pact' | 'none';
}

export function calculateProficiencyBonus(level: number): number {
  return Math.floor((Math.max(1, Math.min(20, level)) - 1) / 4) + 2;
}

export function applyLevelUp(
  actor: Dnd5eActorData,
  options: LevelUpOptions
): Dnd5eActorData
```

Algorithm for `applyLevelUp`:
1. IF `actor.attributes.level >= 20`, THEN throw `Error('Cannot level up past level 20')`.
2. Deep-clone the `actor` object.
3. Increment `clone.attributes.level += 1`.
4. Increment `clone.attributes.hitDiceMax += 1` and `clone.attributes.hitDiceCurrent += 1`.
5. Compute the Constitution modifier: `conMod = Math.floor((clone.abilities.con.score - 10) / 2)`.
6. Determine HP gain:
   - IF `options.hpIncreaseMode === 'fixed'`, THEN `hpGain = Math.max(1, Math.floor(clone.attributes.hitDieSize / 2) + 1 + conMod)`.
   - ELSE (`'roll'`), THEN `hpGain = Math.max(1, (options.rolledHp || 1) + conMod)`.
7. Increment `clone.attributes.hp.max += hpGain` and `clone.attributes.hp.current += hpGain`.
8. IF `options.casterType` is defined and not `'none'`, THEN update `clone.spellSlots` by synchronizing the new maximum values from the corresponding progression matrix.

---

## 6. Rest Pipeline & Condition Expiration (`pipeline.ts`)

### 6.1 Short Rest (`applyShortRest`)

```typescript
export interface ShortRestOptions {
  hitDiceSpent: number;
  diceRolls: number[];
}

export function applyShortRest(
  actor: Dnd5eActorData,
  options: ShortRestOptions
): Dnd5eActorData
```

Algorithm for `applyShortRest`:
1. IF `options.hitDiceSpent < 0 || options.hitDiceSpent > actor.attributes.hitDiceCurrent`, THEN throw `Error('Invalid hit dice count spent')`.
2. IF `options.diceRolls.length !== options.hitDiceSpent`, THEN throw `Error('Dice rolls count must match hit dice spent')`.
3. Deep-clone the `actor` object.
4. Compute the Constitution modifier: `conMod = Math.floor((clone.abilities.con.score - 10) / 2)`.
5. For each roll `r` in `options.diceRolls`:
   - `recovered = Math.max(1, r + conMod)`.
   - `clone.attributes.hp.current = Math.min(clone.attributes.hp.max, clone.attributes.hp.current + recovered)`.
6. Decrement `clone.attributes.hitDiceCurrent -= options.hitDiceSpent`.
7. IF `clone.resources` is defined, THEN for each resource `res` in `clone.resources`, IF `res.resetOn === 'SHORT_REST'`, THEN set `res.current = res.max`.
8. IF `clone.spellSlots?.pact` is present, THEN set `clone.spellSlots.pact.current = clone.spellSlots.pact.max`.

### 6.2 Long Rest (`applyLongRest`)

```typescript
export function applyLongRest(actor: Dnd5eActorData): Dnd5eActorData
```

Algorithm for `applyLongRest`:
1. Deep-clone the `actor` object.
2. Restore all current hit points: `clone.attributes.hp.current = clone.attributes.hp.max`.
3. Reset temporary hit points: `clone.attributes.hp.temp = 0`.
4. Compute hit dice recovery: `recoveredDice = Math.max(1, Math.floor(clone.attributes.hitDiceMax / 2))`.
5. Update hit dice: `clone.attributes.hitDiceCurrent = Math.min(clone.attributes.hitDiceMax, clone.attributes.hitDiceCurrent + recoveredDice)`.
6. IF `clone.attributes.exhaustion > 0`, THEN decrement `clone.attributes.exhaustion -= 1`.
7. Reset death saving throws state: `clone.attributes.deathSaves.successes = 0`, `clone.attributes.deathSaves.failures = 0`.
8. IF `clone.spellSlots` is defined, THEN for each present spell slot tier, set `slot.current = slot.max`.
9. IF `clone.resources` is defined, THEN for each resource `res` in `clone.resources`, set `res.current = res.max` (regardless of whether `resetOn` is `SHORT_REST` or `LONG_REST`).

### 6.3 Active Condition Decrementation (`decrementConditionDurations`)

```typescript
export function decrementConditionDurations(
  conditions: ActiveConditionState[],
  trigger: TurnTrigger,
  currentTurnActorId?: string
): ActiveConditionState[]
```

Strict unambiguous algorithm:
1. Initialize a new empty list `survivingConditions: ActiveConditionState[]`.
2. For each `cond` in `conditions`:
   - IF `trigger === 'TURNS_START' || trigger === 'TURNS_END'`, THEN:
     - IF `cond.appliedTurnActorId !== undefined && cond.appliedTurnActorId === currentTurnActorId && cond.trigger === trigger`, THEN:
       - `remaining = cond.durationRounds - 1`.
     - ELSE:
       - `remaining = cond.durationRounds` (the condition does not decrement if the active turn actor does not match or if `appliedTurnActorId` is absent).
   - ELSE IF `trigger === 'ROUNDS'`, THEN:
     - IF `cond.trigger === 'ROUNDS'`, THEN:
       - `remaining = cond.durationRounds - 1`.
     - ELSE:
       - `remaining = cond.durationRounds`.
   - IF `remaining > 0`, THEN append `{ ...cond, durationRounds: remaining }` to `survivingConditions`.
3. Return `survivingConditions`.

---

## 7. 3-Tier Hierarchical Compendium & CC-BY-4.0 Attribution (`compendium.ts`)

### 7.1 Schemas and Signature of `CompendiumResolver`

```typescript
export type CompendiumTier = 'SYSTEM_SRD' | 'INSTANCE_LIBRARY' | 'CAMPAIGN_HOMEBREW';

export interface CompendiumEntry {
  id: string;
  slug: string;
  name: string;
  entityType: 'monster' | 'spell' | 'item' | 'class' | 'feat';
  tier: CompendiumTier;
  data: Record<string, unknown>;
  overrideEntityId?: string;
}

export interface CompendiumQuery {
  searchTerm?: string;
  entityType?: 'monster' | 'spell' | 'item' | 'class' | 'feat';
}

export class CompendiumResolver {
  private readonly systemSrd: Map<string, CompendiumEntry>;
  private readonly instanceLibrary: Map<string, CompendiumEntry>;
  private readonly campaignHomebrew: Map<string, CompendiumEntry>;

  constructor(
    systemSrd: CompendiumEntry[],
    instanceLibrary: CompendiumEntry[] = [],
    campaignHomebrew: CompendiumEntry[] = []
  );

  public get(idOrSlug: string): CompendiumEntry | undefined;
  public list(query?: CompendiumQuery): CompendiumEntry[];
  public getAttribution(): string;
}
```

### 7.2 Priority Resolution and Deduplication

1. `get(idOrSlug: string)`:
   - First check the key in `campaignHomebrew` (lookup by `id` or `slug`). If found, return the entry.
   - Next check in `instanceLibrary`. If found, return the entry.
   - Finally check in `systemSrd`. If found, return the entry.
   - If no match is found, return `undefined`.
2. `list(query?: CompendiumQuery)`:
   - Build an arbitration map `Map<string, CompendiumEntry>` keyed by `slug`.
   - Insert all entries from `systemSrd`.
   - Next insert entries from `instanceLibrary` (overwriting by slug any existing `systemSrd` entry).
   - Finally insert entries from `campaignHomebrew` (overwriting by slug any previous entry).
   - Obtain the list of all deduplicated values.
   - IF `query?.entityType` is defined, THEN filter entries by `entry.entityType === query.entityType`.
   - IF `query?.searchTerm` is defined and non-empty, THEN filter entries via case-insensitive substring matching: `entry.name.toLowerCase().includes(term.toLowerCase()) || entry.slug.toLowerCase().includes(term.toLowerCase())`.
   - Return the filtered list sorted by name.
3. `getAttribution()`:
   - Return the mandatory legal notice verbatim:
     `"This work includes material taken from the System Reference Document 5.1 (\"SRD 5.1\") by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode."`

---

## 8. Acceptance Test Matrix (`packages/web/tests/dnd5e.test.ts`)

The unit test suite under `node --test` must validate the following scenarios:

| Test ID | Component | Scenario | Expected Result |
|:---|:---|:---|:---|
| T-DND-01 | `manifest.ts` | Ability score and derived value evaluation (Level 1, Wisdom 16, Perception proficiency) | mod +3, proficiency bonus +2, passive perception = 15 |
| T-DND-02 | `system.json` | Structural validation of the system manifest against engine types | All required keys present, zero circular formulas |
| T-DND-03 | `pipeline.ts` | Simultaneous multi-type damage (10 slashing vs. resistance, 6 radiant vs. neutral) | Total effective damage = floor(10*0.5) + 6 = 11 |
| T-DND-04 | `pipeline.ts` | Priority Temp HP absorption (Temp HP 5, Damage 8) | Temp HP = 0, Current HP reduced by 3 |
| T-DND-05 | `pipeline.ts` | Non-critical damage at 0 HP | Adds 1 death save failure with no HP reduction |
| T-DND-06 | `pipeline.ts` | Critical hit damage at 0 HP (`isCritical: true`) | Immediately adds 2 death save failures |
| T-DND-07 | `pipeline.ts` | Instant death (Current HP 2, Damage 24, Max HP 10, excess 22 >= 10) | `instantDeath: true`, `isDead: true`, `failures: 3` |
| T-DND-08 | `pipeline.ts` | Concentration prompt on moderate damage taken (Effective damage 14, active spell) | `concentrationPrompt.dc = max(10, floor(14/2)) = 10` |
| T-DND-09 | `pipeline.ts` | Concentration prompt on high damage taken (Effective damage 26, active spell) | `concentrationPrompt.dc = max(10, floor(26/2)) = 13` |
| T-DND-10 | `pipeline.ts` | Death saving throw: natural 1 | `failures` incremented by 2 |
| T-DND-11 | `pipeline.ts` | Death saving throw: natural 20 | `hp.current = 1`, `successes = 0`, `failures = 0`, removes `unconscious` |
| T-DND-12 | `pipeline.ts` | Short rest spending hit dice and resetting `SHORT_REST` resource | HP increased (min 1 per die), `hitDiceCurrent` decremented, resource reset |
| T-DND-13 | `pipeline.ts` | Long rest | HP restored to max, Temp HP = 0, recovers floor(maxHD/2), exhaustion -1, spell slots and resources recharged |
| T-DND-14 | `pipeline.ts` | `TURNS_START` condition decrementation | Decrements if `appliedTurnActorId === currentTurnActorId`, remains unchanged otherwise |
| T-DND-15 | `progression.ts` | Leveling up from level 1 to level 20 | Exact proficiency bonus (+2 to +6) and strict spell slot progression |
| T-DND-16 | `compendium.ts` | 3-tier cascade and per-campaign spell override | `CAMPAIGN_HOMEBREW` entry returned with priority over `SYSTEM_SRD` |
| T-DND-17 | `compendium.ts` | CC-BY-4.0 attribution notice | Contains the full legal attribution notice from Wizards of the Coast LLC |
