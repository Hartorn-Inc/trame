# Spécification Technique & Fonctionnelle : Built-in D&D 5e GameSystemPack (SRD 5.1)

## 1. Contexte & Objectifs

Cette spécification définit l'implémentation complète du pack système D&D 5e (`packages/game-systems/dnd5e`) pour TRAME V1. Le pack s'appuie sur le moteur générique `crates/trame-engine` et standardise l'ensemble des règles de référence du System Reference Document 5.1 (SRD 5.1) sous licence Creative Commons CC-BY-4.0.

Le module fournit :
1. Le manifeste déclaratif `packages/game-systems/dnd5e/system.json` décrivant les caractéristiques, compétences et formules du graphe acyclique `derivedDAG`.
2. Les schémas TypeScript stricts dans `packages/game-systems/dnd5e/src/manifest.ts` et `types.ts` pour `Dnd5eActorData`, `AbilityId`, `SkillId`, `ProficiencyRank` et `ResourcePool`.
3. Le pipeline de dégâts déterministe dans `packages/game-systems/dnd5e/src/pipeline.ts` gérant les instances de dégâts multi-types, l'absorption prioritaire par les PV temporaires, la mort instantanée, les échecs automatiques de jets de sauvegarde contre la mort à 0 PV et la génération de l'invitation au jet de concentration (`ConcentrationCheckPrompt`).
4. Les fonctions de repos court (`applyShortRest`) et repos long (`applyLongRest`) restaurant les dés de vie, emplacements de sorts et réserves de ressources configurées sur `SHORT_REST` ou `LONG_REST`.
5. La décrémentation des durées de conditions selon les déclencheurs de tour (`ROUNDS`, `TURNS_START`, `TURNS_END`) corrélée à l'acteur actif du tour.
6. Les tables et fonctions pures de progression des niveaux 1 à 20 dans `packages/game-systems/dnd5e/src/progression.ts` pour le bonus de maîtrise, les emplacements de sorts (lanceurs complets, demi-lanceurs et magie de pacte) et l'augmentation de niveau (`applyLevelUp`).
7. Le résolveur hiérarchique immuable `CompendiumResolver` dans `packages/game-systems/dnd5e/src/compendium.ts` appliquant la cascade `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD` avec notice légale CC-BY-4.0.

---

## 2. Architecture & Organisation des Fichiers

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

L'ensemble des tests automatisés est exécuté via le test runner natif de Node 24 (`node --test`) configuré dans `packages/web` :
- `packages/web/tests/dnd5e.test.ts`

---

## 3. Schémas de Données & Manifeste Déclaratif (`system.json` & `manifest.ts`)

### 3.1 Types Fondamentaux (`types.ts` & `manifest.ts`)

Le module `manifest.ts` déclare les types stricts suivants :

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

### 3.2 Manifeste Système Déclaratif (`system.json`)

Le fichier `system.json` fournit la configuration lisible par le moteur `trame-engine` pour la validation et l'évaluation du graphe `derivedDAG` :

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

### 3.3 Fonction de Calcul Dérivé (`computeDnd5eSheetDerived`)

Le module `manifest.ts` expose la fonction synchrone pure `computeDnd5eSheetDerived(actor: Dnd5eActorData)` qui calcule les valeurs dérivées en miroir du graphe `derivedDAG` pour les tests sans runtime WASM :
1. Elle calcule le modificateur de chaque caractéristique : `Math.floor((score - 10) / 2)`.
2. Elle calcule le bonus de maîtrise : `Math.floor((level - 1) / 4) + 2`.
3. Elle calcule la perception passive : `10 + wisMod + (perceptionRank * profBonus)`.
4. Elle calcule la classe d'armure (CA) selon le type d'armure (`none` -> 10 + DEX mod, `light` -> baseAC + DEX mod, `medium` -> baseAC + min(DEX mod, 2), `heavy` -> baseAC) augmentée du bonus de bouclier.
5. Elle calcule le DD de sauvegarde des sorts : `8 + profBonus + abilityMod` (si `spellcastingAbility` est définie).

---

## 4. Pipeline de Dégâts, Mort & Concentration (`pipeline.ts`)

### 4.1 Interface et Contrat de Sortie

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

### 4.2 Algorithme Déterministe de `resolveDamagePipeline`

La fonction `resolveDamagePipeline(actor: Dnd5eActorData, damageInstances: DamageInstance[], options: DamagePipelineOptions = {}): DamageResolutionResult` applique l'algorithme suivant :

1. Cloner en profondeur l'objet `actor` pour préserver l'immuabilité de l'argument initial.
2. Pour chaque `instance` de `damageInstances` :
   - Récupérer `mitigation = clone.damageMitigations[instance.type] || 'NONE'`.
   - IF `mitigation === 'IMMUNE'`, THEN les dégâts de cette instance valent 0.
   - ELSE IF `mitigation === 'RESISTANT'`, THEN les dégâts de cette instance valent `Math.floor(instance.amount * 0.5)`.
   - ELSE IF `mitigation === 'VULNERABLE'`, THEN les dégâts de cette instance valent `instance.amount * 2`.
   - ELSE, THEN les dégâts de cette instance valent `instance.amount`.
   - Ajouter les dégâts obtenus à `totalMitigatedDamage`.
3. IF `totalMitigatedDamage === 0`, THEN retourner immédiatement le résultat avec l'acteur non modifié, sans prompt de concentration ni altération des PV.
4. Traitement selon l'état des PV courants de l'acteur :
   - **Cas A : L'acteur est déjà à 0 PV (`clone.attributes.hp.current === 0`)** :
     - IF `totalMitigatedDamage >= clone.attributes.hp.max`, THEN :
       - Le composant `pipeline` active `clone.isDead = true`.
       - Le composant `pipeline` fixe `clone.attributes.deathSaves.failures = 3`.
       - Le composant `pipeline` renvoie `instantDeath = true`.
     - ELSE :
       - Le composant `pipeline` calcule le nombre d'échecs ajoutés : `addedFailures = options.isCritical ? 2 : 1`.
       - Le composant `pipeline` incrémente `clone.attributes.deathSaves.failures = Math.min(3, clone.attributes.deathSaves.failures + addedFailures)`.
       - IF `clone.attributes.deathSaves.failures >= 3`, THEN le composant `pipeline` active `clone.isDead = true`.
     - Le composant `pipeline` renvoie `damageAppliedToTempHp = 0` et `damageAppliedToCurrentHp = 0`.
   - **Cas B : L'acteur possède plus de 0 PV (`clone.attributes.hp.current > 0`)** :
     - Le composant `pipeline` initialise `unabsorbedDamage = totalMitigatedDamage`.
     - IF `clone.attributes.hp.temp > 0`, THEN :
       - `damageAppliedToTempHp = Math.min(clone.attributes.hp.temp, unabsorbedDamage)`.
       - `clone.attributes.hp.temp -= damageAppliedToTempHp`.
       - `unabsorbedDamage -= damageAppliedToTempHp`.
     - ELSE, `damageAppliedToTempHp = 0`.
     - IF `unabsorbedDamage > 0`, THEN :
       - `damageAppliedToCurrentHp = Math.min(clone.attributes.hp.current, unabsorbedDamage)`.
       - `clone.attributes.hp.current -= damageAppliedToCurrentHp`.
       - `excessDamage = unabsorbedDamage - damageAppliedToCurrentHp`.
     - ELSE, `damageAppliedToCurrentHp = 0` et `excessDamage = 0`.
     - IF `clone.attributes.hp.current === 0`, THEN :
       - IF `excessDamage >= clone.attributes.hp.max`, THEN :
         - Le composant `pipeline` active `clone.isDead = true`.
         - Le composant `pipeline` fixe `clone.attributes.deathSaves.failures = 3`.
         - Le composant `pipeline` renvoie `instantDeath = true`.
       - ELSE :
         - Le composant `pipeline` vérifie si la condition `unconscious` existe déjà dans `clone.conditions` ; si absente, il ajoute `{ id: 'unconscious', name: 'Inconscient', durationRounds: 999, trigger: 'ROUNDS' }`.
5. Traitement de la concentration :
   - IF `clone.concentratingOnSpellId` est défini ET `clone.isDead !== true` ET `clone.attributes.hp.current > 0` ET `totalMitigatedDamage > 0`, THEN :
     - Le composant `pipeline` calcule `concentrationDC = Math.max(10, Math.floor(totalMitigatedDamage / 2))`.
     - Le composant `pipeline` renvoie `concentrationPrompt = { spellId: clone.concentratingOnSpellId, dc: concentrationDC }`.
   - IF `clone.attributes.hp.current === 0` ET `clone.concentratingOnSpellId` est défini, THEN le composant `pipeline` réinitialise `clone.concentratingOnSpellId = undefined` car l'inconscience ou la mort brise immédiatement la concentration.

### 4.3 Algorithme Déterministe de `rollDeathSavingThrow`

```typescript
export function rollDeathSavingThrow(
  actor: Dnd5eActorData,
  d20Roll: number
): { actor: Dnd5eActorData; outcome: 'success' | 'failure' | 'revived' | 'dead' | 'stabilized' }
```

1. Cloner en profondeur l'objet `actor`.
2. IF `d20Roll === 1`, THEN :
   - `clone.attributes.deathSaves.failures += 2`.
   - IF `clone.attributes.deathSaves.failures >= 3`, THEN `clone.isDead = true`, outcome = `'dead'` ; ELSE outcome = `'failure'`.
3. ELSE IF `d20Roll === 20`, THEN :
   - `clone.attributes.hp.current = 1`.
   - `clone.attributes.deathSaves.successes = 0`.
   - `clone.attributes.deathSaves.failures = 0`.
   - Supprimer la condition `'unconscious'` si présente.
   - outcome = `'revived'`.
4. ELSE IF `d20Roll >= 10`, THEN :
   - `clone.attributes.deathSaves.successes += 1`.
   - IF `clone.attributes.deathSaves.successes >= 3`, THEN :
     - `clone.attributes.deathSaves.successes = 0`.
     - `clone.attributes.deathSaves.failures = 0`.
     - outcome = `'stabilized'`.
   - ELSE outcome = `'success'`.
5. ELSE (`d20Roll < 10`) :
   - `clone.attributes.deathSaves.failures += 1`.
   - IF `clone.attributes.deathSaves.failures >= 3`, THEN `clone.isDead = true`, outcome = `'dead'` ; ELSE outcome = `'failure'`.

---

## 5. Progression & Montée de Niveau (`progression.ts`)

### 5.1 Tables Déclaratives d'Emplacements de Sorts (Niveaux 1 à 20)

Le module `progression.ts` contient les matrices statiques exhaustives sans ellipsis :

- **Lanceur Complet (Full Caster : Barde, Clerc, Druide, Ensorceleur, Magicien)** :

| Niveau | 1er | 2e | 3e | 4e | 5e | 6e | 7e | 8e | 9e |
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

- **Demi-Lanceur (Half Caster : Paladin, Rôdeur)** :

| Niveau | 1er | 2e | 3e | 4e | 5e |
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

- **Magie de Pacte (Pact Magic : Démoniste)** :

| Niveau | Nombre d'emplacements | Niveau de l'emplacement |
|:---|:---|:---|
| 1 | 1 | 1er |
| 2 | 2 | 1er |
| 3 | 2 | 2e |
| 4 | 2 | 2e |
| 5 | 2 | 3e |
| 6 | 2 | 3e |
| 7 | 2 | 4e |
| 8 | 2 | 4e |
| 9 | 2 | 5e |
| 10 | 2 | 5e |
| 11-16 | 3 | 5e |
| 17-20 | 4 | 5e |

### 5.2 Helper de Montée de Niveau (`applyLevelUp`)

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

Algorithme pour `applyLevelUp` :
1. IF `actor.attributes.level >= 20`, THEN lever une erreur `Error('Cannot level up past level 20')`.
2. Cloner en profondeur l'objet `actor`.
3. Incrémenter `clone.attributes.level += 1`.
4. Incrémenter `clone.attributes.hitDiceMax += 1` et `clone.attributes.hitDiceCurrent += 1`.
5. Calculer le modificateur de constitution : `conMod = Math.floor((clone.abilities.con.score - 10) / 2)`.
6. Déterminer le gain de PV :
   - IF `options.hpIncreaseMode === 'fixed'`, THEN `hpGain = Math.max(1, Math.floor(clone.attributes.hitDieSize / 2) + 1 + conMod)`.
   - ELSE (`'roll'`), THEN `hpGain = Math.max(1, (options.rolledHp || 1) + conMod)`.
7. Incrémenter `clone.attributes.hp.max += hpGain` et `clone.attributes.hp.current += hpGain`.
8. IF `options.casterType` est défini et différent de `'none'`, THEN mettre à jour `clone.spellSlots` en synchronisant les nouvelles valeurs maximales depuis la matrice correspondante.

---

## 6. Pipeline des Repos & Expiration des Conditions (`pipeline.ts`)

### 6.1 Repos Court (`applyShortRest`)

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

Algorithme pour `applyShortRest` :
1. IF `options.hitDiceSpent < 0 || options.hitDiceSpent > actor.attributes.hitDiceCurrent`, THEN lever une erreur `Error('Invalid hit dice count spent')`.
2. IF `options.diceRolls.length !== options.hitDiceSpent`, THEN lever une erreur `Error('Dice rolls count must match hit dice spent')`.
3. Cloner en profondeur l'objet `actor`.
4. Calculer le modificateur de constitution : `conMod = Math.floor((clone.abilities.con.score - 10) / 2)`.
5. Pour chaque jet `r` de `options.diceRolls` :
   - `recovered = Math.max(1, r + conMod)`.
   - `clone.attributes.hp.current = Math.min(clone.attributes.hp.max, clone.attributes.hp.current + recovered)`.
6. Décrémenter `clone.attributes.hitDiceCurrent -= options.hitDiceSpent`.
7. IF `clone.resources` est défini, THEN pour chaque ressource `res` de `clone.resources`, IF `res.resetOn === 'SHORT_REST'`, THEN fixer `res.current = res.max`.
8. IF `clone.spellSlots?.pact` est présent, THEN fixer `clone.spellSlots.pact.current = clone.spellSlots.pact.max`.

### 6.2 Repos Long (`applyLongRest`)

```typescript
export function applyLongRest(actor: Dnd5eActorData): Dnd5eActorData
```

Algorithme pour `applyLongRest` :
1. Cloner en profondeur l'objet `actor`.
2. Restaurer tous les points de vie courants : `clone.attributes.hp.current = clone.attributes.hp.max`.
3. Réinitialiser les points de vie temporaires : `clone.attributes.hp.temp = 0`.
4. Calculer la récupération des dés de vie : `recoveredDice = Math.max(1, Math.floor(clone.attributes.hitDiceMax / 2))`.
5. Mettre à jour les dés de vie : `clone.attributes.hitDiceCurrent = Math.min(clone.attributes.hitDiceMax, clone.attributes.hitDiceCurrent + recoveredDice)`.
6. IF `clone.attributes.exhaustion > 0`, THEN décrémenter `clone.attributes.exhaustion -= 1`.
7. Réinitialiser l'état des jets de sauvegarde contre la mort : `clone.attributes.deathSaves.successes = 0`, `clone.attributes.deathSaves.failures = 0`.
8. IF `clone.spellSlots` est défini, THEN pour chaque niveau d'emplacement présent, fixer `slot.current = slot.max`.
9. IF `clone.resources` est défini, THEN pour chaque ressource `res` de `clone.resources`, fixer `res.current = res.max` (indépendamment de la fréquence `SHORT_REST` ou `LONG_REST`).

### 6.3 Décrémentation des Conditions Actives (`decrementConditionDurations`)

```typescript
export function decrementConditionDurations(
  conditions: ActiveConditionState[],
  trigger: TurnTrigger,
  currentTurnActorId?: string
): ActiveConditionState[]
```

Algorithme strict sans ambiguïté :
1. Initialiser une nouvelle liste vide `survivingConditions: ActiveConditionState[]`.
2. Pour chaque `cond` de `conditions` :
   - IF `trigger === 'TURNS_START' || trigger === 'TURNS_END'`, THEN :
     - IF `cond.appliedTurnActorId !== undefined && cond.appliedTurnActorId === currentTurnActorId && cond.trigger === trigger`, THEN :
       - `remaining = cond.durationRounds - 1`.
     - ELSE :
       - `remaining = cond.durationRounds` (la condition ne décrémente pas si l'acteur du tour ne correspond pas ou si `appliedTurnActorId` est absent).
   - ELSE IF `trigger === 'ROUNDS'`, THEN :
     - IF `cond.trigger === 'ROUNDS'`, THEN :
       - `remaining = cond.durationRounds - 1`.
     - ELSE :
       - `remaining = cond.durationRounds`.
   - IF `remaining > 0`, THEN ajouter `{ ...cond, durationRounds: remaining }` dans `survivingConditions`.
3. Retourner `survivingConditions`.

---

## 7. Compendium Hiérarchique à 3 Niveaux & Attribution CC-BY-4.0 (`compendium.ts`)

### 7.1 Schémas et Signature de `CompendiumResolver`

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

### 7.2 Résolution et Déduplication Prioritaire

1. `get(idOrSlug: string)` :
   - Vérifier d'abord la clé dans `campaignHomebrew` (recherche par `id` ou `slug`). Si trouvée, retourner l'entrée.
   - Vérifier ensuite dans `instanceLibrary`. Si trouvée, retourner l'entrée.
   - Vérifier enfin dans `systemSrd`. Si trouvée, retourner l'entrée.
   - Si aucune correspondance, retourner `undefined`.
2. `list(query?: CompendiumQuery)` :
   - Construire une table d'arbitrage `Map<string, CompendiumEntry>` où la clé est le `slug`.
   - Insérer toutes les entrées de `systemSrd`.
   - Insérer ensuite les entrées de `instanceLibrary` (écrasant par slug toute entrée `systemSrd` existante).
   - Insérer enfin les entrées de `campaignHomebrew` (écrasant par slug toute entrée précédente).
   - Obtenir la liste de toutes les valeurs dédupliquées.
   - IF `query?.entityType` est défini, THEN filtrer les entrées sur `entry.entityType === query.entityType`.
   - IF `query?.searchTerm` est défini et non vide, THEN filtrer les entrées via une recherche de sous-chaîne insensible à la casse : `entry.name.toLowerCase().includes(term.toLowerCase()) || entry.slug.toLowerCase().includes(term.toLowerCase())`.
   - Retourner la liste filtrée triée par nom.
3. `getAttribution()` :
   - Retourner la mention légale obligatoire verbatim :
     `"This work includes material taken from the System Reference Document 5.1 (\"SRD 5.1\") by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode."`

---

## 8. Matrice des Tests d'Acceptation (`packages/web/tests/dnd5e.test.ts`)

La suite de tests unitaires sous `node --test` doit valider les scénarios suivants :

| ID Test | Composant | Scénario | Résultat Attendu |
|:---|:---|:---|:---|
| T-DND-01 | `manifest.ts` | Évaluation des caractéristiques et dérivés (Niveau 1, Sagesse 16, Maîtrise Perception) | mod +3, bonus maîtrise +2, perception passive = 15 |
| T-DND-02 | `system.json` | Validation structurelle du manifeste système contre les types du moteur | Toutes les clés requises présentes, aucune formule circulaire |
| T-DND-03 | `pipeline.ts` | Dégâts multiples simultanés (tranchant 10 sur résistance, radiant 6 sur neutre) | Dégâts totaux effectifs = floor(10*0.5) + 6 = 11 |
| T-DND-04 | `pipeline.ts` | Absorption Temp HP prioritaire (Temp HP 5, Dégâts 8) | Temp HP = 0, Current HP réduit de 3 |
| T-DND-05 | `pipeline.ts` | Dégâts à 0 PV non critiques | Ajout de 1 échec de jet de mort sans réduction de PV |
| T-DND-06 | `pipeline.ts` | Dégâts à 0 PV avec coup critique (`isCritical: true`) | Ajout de 2 échecs de jet de mort immédiats |
| T-DND-07 | `pipeline.ts` | Mort instantanée (PV actuels 2, Dégâts 24, PV max 10, reliquat 22 >= 10) | `instantDeath: true`, `isDead: true`, `failures: 3` |
| T-DND-08 | `pipeline.ts` | Prompt de concentration sur dégâts reçus (Dégâts effectifs 14, sort actif) | `concentrationPrompt.dc = max(10, floor(14/2)) = 10` |
| T-DND-09 | `pipeline.ts` | Prompt de concentration sur dégâts élevés (Dégâts effectifs 26, sort actif) | `concentrationPrompt.dc = max(10, floor(26/2)) = 13` |
| T-DND-10 | `pipeline.ts` | Jet de sauvegarde contre la mort : 1 naturel | `failures` incrémenté de 2 |
| T-DND-11 | `pipeline.ts` | Jet de sauvegarde contre la mort : 20 naturel | `hp.current = 1`, `successes = 0`, `failures = 0`, retrait de `unconscious` |
| T-DND-12 | `pipeline.ts` | Repos court avec dépense de dés de vie et ressource `SHORT_REST` | PV augmentés (min 1 par dé), `hitDiceCurrent` décrémenté, ressource réinitialisée |
| T-DND-13 | `pipeline.ts` | Repos long | PV au max, Temp HP = 0, récupération de floor(maxHD/2), exhaustion -1, slots et ressources rechargés |
| T-DND-14 | `pipeline.ts` | Décrémentation conditions `TURNS_START` | Décrémente si `appliedTurnActorId === currentTurnActorId`, reste inchangé sinon |
| T-DND-15 | `progression.ts` | Montée de niveau du niveau 1 au niveau 20 | Bonus de maîtrise exact (+2 à +6) et progression rigoureuse des emplacements |
| T-DND-16 | `compendium.ts` | Cascade 3 niveaux et surcharge de sort par campagne | Version `CAMPAIGN_HOMEBREW` renvoyée en priorité sur `SYSTEM_SRD` |
| T-DND-17 | `compendium.ts` | Notice d'attribution CC-BY-4.0 | Contient la mention légale intégrale de Wizards of the Coast LLC |
