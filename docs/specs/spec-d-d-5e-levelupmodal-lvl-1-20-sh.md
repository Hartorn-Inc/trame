# Spécification Technique & Fonctionnelle : D&D 5e LevelUpModal (Lvl 1-20), ShortRest/LongRest UI & Expanded SRD 5.1 Compendium

- **Identifiant** : `spec-d-d-5e-levelupmodal-lvl-1-20-sh`
- **Titre** : Spécification Technique de la Montée de Niveau (Lvl 1-20), de l'Interface de Repos et de l'Expansion du Compendium SRD 5.1
- **Statut** : Prêt pour Implémentation
- **Architecture de référence** : ADR-0036 (D&D 5e Level-Up (Lvl 1-20), Short/Long Rests, and SRD 5.1 Compendium Expansion Architecture)
- **Conformité** : ASD-STE100 (Controlled Technical Prompting, ADR-0031)

---

## 1. Contexte & Objectifs Métier

L'application TRAME ne fournit actuellement aucune interface utilisateur permettant à un joueur ou à un maître du jeu d'augmenter le niveau d'un `Actor` de 1 à 20. La fonction `applyLevelUp` existante dans `@trame/game-system-dnd5e` n'accepte pas la sélection de sous-classe, l'arbitrage entre Amélioration de Caractéristique (ASI) et Dons, ni l'apprentissage de sorts. De plus, aucune interface n'existe pour déclencher un `ShortRest` ou un `LongRest`. Enfin, le compendium `compendium.ts` ne contient qu'un jeu d'objets minimal sans conteneurs magiques, dons, sorts complets ou gabarits de monstres de référence.

Cette spécification définit l'implémentation complète des règles métier, des interfaces utilisateur et des données de référence nécessaires pour lever ces blocages.

---

## 2. Invariants du Modèle et Règles Métier SRD 5.1

### 2.1 Invariants d'Intégrité d'un Actor
1. Le niveau total d'un `Actor` est un entier compris entre 1 et 20 inclus (`1 <= level <= 20`).
2. `ProficiencyBonus` est une valeur dérivée déterminée exclusivement par le niveau total de l'`Actor` :
   - Niveaux 1 à 4 : `+2`
   - Niveaux 5 à 8 : `+3`
   - Niveaux 9 à 12 : `+4`
   - Niveaux 13 à 16 : `+5`
   - Niveaux 17 à 20 : `+6`
3. Aucun `AbilityScore` ne peut dépasser la valeur 20 par le biais d'un choix d'Amélioration de Caractéristique (ASI).
4. Le gain de points de vie maximum (`maxHp`) à chaque niveau respecte le plancher strict de 1 point de vie (`max(1, hitDieGain + constitutionModifier)`).
5. Le nombre total de dés de vie d'un `Actor` (`hitDiceCurrent`) ne peut jamais dépasser la valeur plafond `hitDiceMax`, laquelle est égale au niveau total de l'`Actor`.
6. Le composant d'interface de fiche d'un `Actor` verrouille toute édition directe des caractéristiques fondamentales en dehors du composant `LevelUpModal` conformément à `CoreBuildLock` (ADR-0006).

---

## 3. Architecture des Données et Signatures TypeScript

### 3.1 Types pour la Montée de Niveau (`packages/game-systems/dnd5e/src/progression.ts`)

```typescript
import type { AbilityKey, Dnd5eActorData } from './types';

export type HitPointsProgressionMode = 'fixed' | 'rolled';

export interface AsiChoiceBonus {
  readonly mode: 'asi';
  readonly bonuses: Partial<Record<AbilityKey, number>>;
}

export interface FeatChoiceSelection {
  readonly mode: 'feat';
  readonly featId: string;
}

export type AbilityScoreOrFeatChoice = AsiChoiceBonus | FeatChoiceSelection;

export interface LevelUpOptions {
  readonly targetLevel: number;
  readonly hitPointsMode: HitPointsProgressionMode;
  readonly rolledHp?: number;
  readonly subclassId?: string;
  readonly asiOrFeat?: AbilityScoreOrFeatChoice;
  readonly newSpellIds?: readonly string[];
}

export interface SpellSlotTierProgression {
  readonly 1: number;
  readonly 2: number;
  readonly 3: number;
  readonly 4: number;
  readonly 5: number;
  readonly 6: number;
  readonly 7: number;
  readonly 8: number;
  readonly 9: number;
}

export const FULL_CASTER_SPELL_SLOTS: Readonly<Record<number, readonly number[]>> = {
  1:  [2, 0, 0, 0, 0, 0, 0, 0, 0],
  2:  [3, 0, 0, 0, 0, 0, 0, 0, 0],
  3:  [4, 2, 0, 0, 0, 0, 0, 0, 0],
  4:  [4, 3, 0, 0, 0, 0, 0, 0, 0],
  5:  [4, 3, 2, 0, 0, 0, 0, 0, 0],
  6:  [4, 3, 3, 0, 0, 0, 0, 0, 0],
  7:  [4, 3, 3, 1, 0, 0, 0, 0, 0],
  8:  [4, 3, 3, 2, 0, 0, 0, 0, 0],
  9:  [4, 3, 3, 3, 1, 0, 0, 0, 0],
  10: [4, 3, 3, 3, 2, 0, 0, 0, 0],
  11: [4, 3, 3, 3, 2, 1, 0, 0, 0],
  12: [4, 3, 3, 3, 2, 1, 0, 0, 0],
  13: [4, 3, 3, 3, 2, 1, 1, 0, 0],
  14: [4, 3, 3, 3, 2, 1, 1, 0, 0],
  15: [4, 3, 3, 3, 2, 1, 1, 1, 0],
  16: [4, 3, 3, 3, 2, 1, 1, 1, 0],
  17: [4, 3, 3, 3, 2, 1, 1, 1, 1],
  18: [4, 3, 3, 3, 3, 1, 1, 1, 1],
  19: [4, 3, 3, 3, 3, 2, 1, 1, 1],
  20: [4, 3, 3, 3, 3, 2, 2, 1, 1],
};

export const HALF_CASTER_SPELL_SLOTS: Readonly<Record<number, readonly number[]>> = {
  1:  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  2:  [2, 0, 0, 0, 0, 0, 0, 0, 0],
  3:  [3, 0, 0, 0, 0, 0, 0, 0, 0],
  4:  [3, 0, 0, 0, 0, 0, 0, 0, 0],
  5:  [4, 2, 0, 0, 0, 0, 0, 0, 0],
  6:  [4, 2, 0, 0, 0, 0, 0, 0, 0],
  7:  [4, 3, 0, 0, 0, 0, 0, 0, 0],
  8:  [4, 3, 0, 0, 0, 0, 0, 0, 0],
  9:  [4, 3, 2, 0, 0, 0, 0, 0, 0],
  10: [4, 3, 2, 0, 0, 0, 0, 0, 0],
  11: [4, 3, 3, 0, 0, 0, 0, 0, 0],
  12: [4, 3, 3, 0, 0, 0, 0, 0, 0],
  13: [4, 3, 3, 1, 0, 0, 0, 0, 0],
  14: [4, 3, 3, 1, 0, 0, 0, 0, 0],
  15: [4, 3, 3, 2, 0, 0, 0, 0, 0],
  16: [4, 3, 3, 2, 0, 0, 0, 0, 0],
  17: [4, 3, 3, 3, 1, 0, 0, 0, 0],
  18: [4, 3, 3, 3, 1, 0, 0, 0, 0],
  19: [4, 3, 3, 3, 2, 0, 0, 0, 0],
  20: [4, 3, 3, 3, 2, 0, 0, 0, 0],
};

export const PACT_MAGIC_SPELL_SLOTS: Readonly<Record<number, { readonly slotCount: number; readonly slotLevel: number }>> = {
  1:  { slotCount: 1, slotLevel: 1 },
  2:  { slotCount: 2, slotLevel: 1 },
  3:  { slotCount: 2, slotLevel: 2 },
  4:  { slotCount: 2, slotLevel: 2 },
  5:  { slotCount: 2, slotLevel: 3 },
  6:  { slotCount: 2, slotLevel: 3 },
  7:  { slotCount: 2, slotLevel: 4 },
  8:  { slotCount: 2, slotLevel: 4 },
  9:  { slotCount: 2, slotLevel: 5 },
  10: { slotCount: 2, slotLevel: 5 },
  11: { slotCount: 3, slotLevel: 5 },
  12: { slotCount: 3, slotLevel: 5 },
  13: { slotCount: 3, slotLevel: 5 },
  14: { slotCount: 3, slotLevel: 5 },
  15: { slotCount: 3, slotLevel: 5 },
  16: { slotCount: 3, slotLevel: 5 },
  17: { slotCount: 4, slotLevel: 5 },
  18: { slotCount: 4, slotLevel: 5 },
  19: { slotCount: 4, slotLevel: 5 },
  20: { slotCount: 4, slotLevel: 5 },
};
```

### 3.2 Types pour les Repos (`packages/game-systems/dnd5e/src/rest.ts`)

```typescript
import type { Dnd5eActorData } from './types';

export interface HitDieSpendRequest {
  readonly count: number;
  readonly rollResults: readonly number[];
}

export interface ShortRestOptions {
  readonly hitDieSpend?: HitDieSpendRequest;
}

export interface RestRecoverySummary {
  readonly hpRecovered: number;
  readonly hitDiceSpent: number;
  readonly hitDiceRecovered: number;
  readonly spellSlotsRecovered: readonly number[];
  readonly exhaustionReduced: number;
}
```

---

## 4. Contrats d'Exécution Métier

### 4.1 Contrat de `applyLevelUp`

```typescript
export function applyLevelUp(actor: Dnd5eActorData, options: LevelUpOptions): Dnd5eActorData;
```

1. Le moteur valide la condition de niveau : `options.targetLevel` doit être égal à `actor.system.level + 1`. Si la condition échoue, le moteur lève une exception `Error('Invalid level increment')`.
2. Le moteur valide le plafond de niveau : `options.targetLevel` ne peut pas dépasser 20. Si `options.targetLevel > 20`, le moteur lève une exception `Error('Max level is 20')`.
3. Calcul du gain de points de vie :
   - Le moteur identifie la taille du dé de vie `hitDieSize` de la classe de l'`Actor` (ex: 6 pour Sorcier/Magicien, 8 pour Barde/Clerc/Druide/Moine/Roublard/Occultiste, 10 pour Guerrier/Paladin/Rôdeur, 12 pour Barbare).
   - Le moteur extrait le modificateur de Constitution `conMod = floor((actor.system.abilities.constitution.value - 10) / 2)`.
   - Si `options.hitPointsMode === 'fixed'`, le moteur calcule le gain selon `baseGain = floor(hitDieSize / 2) + 1`.
   - Si `options.hitPointsMode === 'rolled'`, le moteur exige la présence de `options.rolledHp`. Si `options.rolledHp` est absent ou inférieur à 1 ou supérieur à `hitDieSize`, le moteur lève une exception `Error('Invalid rolledHp value')`. Le moteur assigne `baseGain = options.rolledHp`.
   - Le moteur calcule l'accroissement net de points de vie : `hpIncrease = Math.max(1, baseGain + conMod)`.
   - Le moteur incrémente `actor.system.attributes.hp.max` et `actor.system.attributes.hp.value` de la valeur `hpIncrease`.
   - Le moteur incrémente `actor.system.attributes.hitDice.max` de 1 et `actor.system.attributes.hitDice.current` de 1.
4. Attribution de la sous-classe :
   - Le moteur vérifie si la classe de l'`Actor` acquiert sa sous-classe au niveau cible (`targetLevel === 1` pour Clerc et Ensorceleur ; `targetLevel === 2` pour Druide et Magicien ; `targetLevel === 3` pour Barbare, Barde, Guerrier, Moine, Paladin, Rôdeur, Roublard, Occultiste).
   - Si ce niveau correspond au palier requis et que `options.subclassId` est fourni, le moteur assigne `actor.system.details.subclass = options.subclassId`.
   - Si ce niveau correspond au palier requis et que `options.subclassId` est absent, le moteur lève une exception `Error('Subclass selection required at this level')`.
5. Attribution de l'ASI ou du Don :
   - Le moteur identifie les niveaux d'ASI de la classe :
     - Guerrier : niveaux 4, 6, 8, 12, 14, 16, 19.
     - Roublard : niveaux 4, 8, 10, 12, 16, 19.
     - Autres classes : niveaux 4, 8, 12, 16, 19.
   - Si `targetLevel` correspond à un niveau d'ASI, le moteur exige la présence de `options.asiOrFeat`.
   - Si `options.asiOrFeat.mode === 'asi'` :
     - Le moteur vérifie que la somme des bonus est égale à 2 (soit un bonus de `+2` sur une caractéristique, soit un bonus de `+1` sur exactement deux caractéristiques distinctes).
     - Le moteur vérifie pour chaque caractéristique ciblée que `actor.system.abilities[key].value + bonus <= 20`. Si un score dépasse 20, le moteur lève une exception `Error('Ability score cannot exceed 20')`.
     - Le moteur applique les bonus sur les scores ciblés.
   - Si `options.asiOrFeat.mode === 'feat'` :
     - Le moteur vérifie l'existence du `featId` dans `SystemSRD`.
     - Le moteur ajoute l'identifiant du don au tableau `actor.system.features`.
6. Progression des sorts et réconciliation :
   - Le moteur identifie la catégorie de lanceur de sorts de la classe :
     - `FULL_CASTER` : Barde, Clerc, Druide, Ensorceleur, Magicien.
     - `HALF_CASTER` : Paladin, Rôdeur.
     - `PACT_MAGIC` : Occultiste.
     - `NONE` : Barbare, Guerrier (hors sous-classe martiale), Moine, Roublard.
   - Le moteur appelle `reconcileSlots(actor: Dnd5eActorData, targetSlots: readonly number[]): void` :
     - Le moteur met à jour les capacités maximales des emplacements de sorts du niveau 1 à 9 pour refléter la table correspondante.
     - Le moteur ajuste la réserve courante de chaque emplacement sans excéder le nouveau maximum.
   - Si `options.newSpellIds` est fourni, le moteur ajoute les identifiants de sorts valides à `actor.system.spells` sans doublons.
7. Recalcul des valeurs dérivées :
   - Le moteur recalcule le `ProficiencyBonus` de l'`Actor`.
   - Le moteur recalcule les modificateurs de sauvegarde et compétences basés sur la nouvelle valeur de caractéristique et le `ProficiencyBonus`.
8. Le moteur incrémente `actor.system.level = options.targetLevel` et retourne l'objet `Dnd5eActorData` muté de manière immuable.

### 4.2 Contrat de `reconcileSlots`

```typescript
export function reconcileSlots(actor: Dnd5eActorData, targetSlots: readonly number[]): void {
  for (let tier = 1; tier <= 9; tier++) {
    const maxForTier = targetSlots[tier - 1] ?? 0;
    const currentSlot = actor.system.spells.slots[`tier_${tier}`];
    if (currentSlot) {
      currentSlot.max = maxForTier;
      currentSlot.value = Math.min(currentSlot.value, maxForTier);
    } else {
      actor.system.spells.slots[`tier_${tier}`] = {
        value: maxForTier,
        max: maxForTier,
      };
    }
  }
}
```

### 4.3 Contrat de `applyShortRest`

```typescript
export function applyShortRest(actor: Dnd5eActorData, options: ShortRestOptions): Dnd5eActorData;
```

1. Dépense de dés de vie :
   - Si `options.hitDieSpend` est fourni :
     - Le moteur vérifie que `options.hitDieSpend.count <= actor.system.attributes.hitDice.current`. Si le compte dépasse les dés restants, le moteur lève une exception `Error('Insufficient hit dice')`.
     - Le moteur vérifie que la longueur du tableau `options.hitDieSpend.rollResults` est égale à `options.hitDieSpend.count`.
     - Le modificateur de Constitution `conMod = floor((actor.system.abilities.constitution.value - 10) / 2)` est calculé.
     - Pour chaque tirage `roll` dans `options.hitDieSpend.rollResults`, le gain de PV est calculé par `hpGain = Math.max(1, roll + conMod)`.
     - Le moteur ajoute la somme des `hpGain` à `actor.system.attributes.hp.value` sans excéder `actor.system.attributes.hp.max`.
     - Le moteur décrémente `actor.system.attributes.hitDice.current` de la valeur `options.hitDieSpend.count`.
2. Récupération des réserves `SHORT_REST` :
   - Le moteur parcourt l'ensemble des `ResourcePool` de l'`Actor`.
   - Pour toute ressource possédant l'attribut `recovery === 'SHORT_REST'`, le moteur réassigne `resource.value = resource.max`.
3. Récupération de la magie de pacte (Warlock) :
   - Si l'`Actor` possède des emplacements de magie de pacte (`actor.system.spells.pact`), le moteur réinitialise `actor.system.spells.pact.value = actor.system.spells.pact.max`.
4. Le moteur retourne le nouvel état de l'`Actor`.

### 4.4 Contrat de `applyLongRest`

```typescript
export function applyLongRest(actor: Dnd5eActorData): Dnd5eActorData;
```

1. Restauration des points de vie :
   - Le moteur assigne `actor.system.attributes.hp.value = actor.system.attributes.hp.max`.
   - Le moteur assigne `actor.system.attributes.tempHp.value = 0`.
2. Restauration des dés de vie :
   - Le moteur calcule le nombre de dés de vie récupérés : `recoveredDice = Math.max(1, Math.floor(actor.system.attributes.hitDice.max / 2))`.
   - Le moteur met à jour `actor.system.attributes.hitDice.current = Math.min(actor.system.attributes.hitDice.max, actor.system.attributes.hitDice.current + recoveredDice)`.
3. Restauration des emplacements de sorts :
   - Pour chaque emplacement de sort de niveau 1 à 9 (`tier_1` à `tier_9`), le moteur assigne `slot.value = slot.max`.
   - Si l'`Actor` possède des emplacements de magie de pacte (`actor.system.spells.pact`), le moteur assigne `pact.value = pact.max`.
4. Récupération des réserves `LONG_REST` et `SHORT_REST` :
   - Pour toute ressource possédant l'attribut `recovery === 'LONG_REST'` ou `recovery === 'SHORT_REST'`, le moteur assigne `resource.value = resource.max`.
5. Réduction de l'épuisement :
   - Si `actor.system.attributes.exhaustion > 0`, le moteur décrémente `actor.system.attributes.exhaustion = actor.system.attributes.exhaustion - 1`.
6. Le moteur retourne le nouvel état de l'`Actor`.

---

## 5. Spécification des Composants d'Interface Utilisateur (UI)

### 5.1 Composant `LevelUpModal`

- **Emplacement** : `packages/web/src/components/modals/LevelUpModal.tsx`
- **Déclencheurs** : Bouton `[Monter de niveau (N -> N+1)]` présent sur le bandeau supérieur de la fiche d'un `Actor` dans `CampaignWorkspace` et dans le tiroir HUD `HudDrawers.tsx`.
- **Propriétés du composant** :
  ```typescript
  export interface LevelUpModalProps {
    readonly actor: Dnd5eActorData;
    readonly isOpen: boolean;
    readonly onClose: () => void;
    readonly onSave: (updatedActor: Dnd5eActorData) => Promise<void>;
    readonly diceRollService: DiceRollService;
  }
  ```

#### Workflow en 4 Étapes Guidées

1. **Étape 1 : Confirmation de Classe et Choix de Sous-classe**
   - Le composant affiche la classe actuelle de l'`Actor` et son niveau cible `N + 1`.
   - IF `N + 1` correspond au palier d'acquisition de sous-classe de la classe de l'`Actor` et `actor.system.details.subclass` est indéterminé, THEN le composant affiche un menu déroulant obligatoire alimenté par `SystemSRD.getSubclasses(actor.system.details.class)`.
   - IF le choix de sous-classe est requis et aucun choix n'est sélectionné, THEN le composant désactive le bouton `[Suivant]`.

2. **Étape 2 : Gain de Points de Vie (Moyenne Fixe vs Tirage Serveur)**
   - Le composant propose deux options mutuellement exclusives par boutons radio : `Moyenne fixe` ou `Tirer le dé de vie`.
   - IF l'utilisateur sélectionne `Moyenne fixe`, THEN le composant calcule et affiche la formule : `gain = floor(hitDieSize / 2) + 1 + conModifier`.
   - IF l'utilisateur sélectionne `Tirer le dé de vie`, THEN le composant affiche un bouton `[Lancer 1dX]`.
   - Le clic sur `[Lancer 1dX]` sollicite le service serveur selon le contrat de l'API de dés défini en Section 6.2.
   - Le composant affiche le résultat certifié du jet serveur et calcule le gain net : `max(1, roll + conModifier)`.
   - IF le mode `Tirer le dé de vie` est sélectionné et aucun tirage serveur n'a été validé, THEN le composant désactive le bouton `[Suivant]`.

3. **Étape 3 : Amélioration de Caractéristique (ASI) ou Don**
   - IF le niveau `N + 1` ne correspond pas à un palier d'ASI pour la classe de l'`Actor`, THEN le composant saute automatiquement cette étape ou affiche un récapitulatif sans saisie.
   - IF le niveau `N + 1` correspond à un palier d'ASI, THEN le composant propose un sélecteur à deux choix : `Amélioration de Caractéristique (+2 ou +1/+1)` et `Choisir un Don`.
   - Cas ASI : L'utilisateur alloue soit `+2` à une caractéristique, soit `+1` à deux caractéristiques différentes. Le composant désactive tout incrément qui porterait une caractéristique au-delà de 20.
   - Cas Don : Le composant affiche la liste déroulante des dons éligibles issus de `SystemSRD.getFeats()`. Le choix d'un don est requis.
   - IF la sélection ASI ou Don n'est pas complète et conforme, THEN le composant désactive le bouton `[Suivant]`.

4. **Étape 4 : Gestion des Sorts et Récapitulatif Final**
   - IF la classe de l'`Actor` n'est pas un lanceur de sorts, THEN le composant affiche uniquement l'écran de récapitulatif des modifications.
   - IF la classe de l'`Actor` est un lanceur de sorts, THEN le composant affiche la nouvelle grille d'emplacements de sorts dérivée de la progression SRD 5.1.
   - Limites déterministes d'apprentissage par niveau cible :
     - Magicien : L'interface impose la sélection d'exactement 2 nouveaux sorts de niveau inférieur ou égal au plus haut niveau d'emplacement débloqué.
     - Ensorceleur / Barde / Occultiste : L'interface autorise la sélection d'exactement 1 nouveau sort si le tableau de progression de la classe l'accorde au niveau `N + 1`.
     - Clerc / Druide / Paladin : L'interface informe l'utilisateur que l'ensemble des sorts de la liste de classe est débloqué pour la préparation quotidienne.
   - Le bouton `[Confirmer et Appliquer]` exécute la mutation locale via `applyLevelUp`, appelle `onSave(updatedActor)` puis ferme la modale.

### 5.2 Composant `RestModal`

- **Emplacement** : `packages/web/src/components/modals/RestModal.tsx`
- **Déclencheurs** : Boutons `[Repos Court]` et `[Repos Long]` présents sur le bandeau supérieur de la fiche d'un `Actor`.
- **Propriétés du composant** :
  ```typescript
  export interface RestModalProps {
    readonly actor: Dnd5eActorData;
    readonly restType: 'short' | 'long';
    readonly isOpen: boolean;
    readonly onClose: () => void;
    readonly onSave: (updatedActor: Dnd5eActorData) => Promise<void>;
    readonly diceRollService: DiceRollService;
  }
  ```

#### Workflow du Repos Court (`restType === 'short'`)
1. Le composant affiche le stock courant de dés de vie disponibles : `hitDice.current` / `hitDice.max`.
2. L'utilisateur sélectionne le nombre de dés de vie qu'il souhaite dépenser (entre 0 et `hitDice.current`).
3. IF le nombre sélectionné est supérieur à 0, THEN l'utilisateur clique sur `[Lancer les dés de récupération]`.
4. Le client expédie la requête de tirage au serveur selon le contrat de la Section 6.2 pour chaque dé sélectionné.
5. Le composant affiche le détail de chaque jet de dé, applique le modificateur de Constitution sur chaque dé, calcule les points de vie récupérés, et affiche les réserves `SHORT_REST` qui seront réinitialisées.
6. Le clic sur `[Terminer le Repos Court]` exécute `applyShortRest`, persiste l'`Actor` via `onSave` et consigne l'événement.

#### Workflow du Repos Long (`restType === 'long'`)
1. Le composant présente un écran récapitulatif des effets autoritaires du repos long :
   - Restauration intégrale des PV (`hp.value` passe à `hp.max`).
   - Récupération de `max(1, floor(hitDiceMax / 2))` dés de vie.
   - Remise à zéro des PV temporaires.
   - Restauration intégrale de tous les emplacements de sorts et des réserves `LONG_REST` / `SHORT_REST`.
   - Réduction de 1 niveau d'épuisement (si supérieur à 0).
2. Le clic sur `[Valider le Repos Long]` exécute `applyLongRest`, persiste l'`Actor` via `onSave` et ferme la modale.

---

## 6. Contrats d'Interface Réseau et Persistance

### 6.1 Persistance de l'Acteur

#### Hors Session Active (`CampaignWorkspace`)
- **Protocole** : HTTP REST
- **Méthode / Route** : `PUT /api/v1/campaigns/{campaign_id}/actors/{actor_id}`
- **Payload** :
  ```json
  {
    "system": { ... }
  }
  ```
- **Réponse HTTP 200** : Objet `Actor` mis à jour.

#### En Session Active (`HudDrawers.tsx`)
- **Protocole** : WebSocket via `TableRoomActor`
- **Commande CQRS expédiée** :
  ```json
  {
    "type": "UpdateActorData",
    "payload": {
      "actorId": "<ACTOR_ID>",
      "system": { ... }
    }
  }
  ```
- **Comportement** : Le `TableRoomActor` diffuse l'événement à tous les clients connectés pour synchroniser les signaux Preact et persiste l'état via `SqlxPostgresStore` (ADR-0010).

### 6.2 Service de Tirage de Dés Autoritaire (`ChaCha20Rng`)

#### Hors Session Active (REST)
- **Méthode / Route** : `POST /api/v1/campaigns/{campaign_id}/dice/roll`
- **Headers** : `Authorization: Bearer <JWT>`, `Content-Type: application/json`
- **Requête payload** :
  ```typescript
  export interface RestDiceRollRequest {
    readonly actorId: string;
    readonly formula: string; // Ex: "1d8", "2d6"
    readonly reason: 'level_up_hp' | 'short_rest_hit_dice';
  }
  ```
- **Réponse HTTP 200 payload** :
  ```typescript
  export interface RestDiceRollResponse {
    readonly formula: string;
    readonly rolls: readonly number[]; // Ex: [6]
    readonly total: number;
    readonly signature: string; // Signature HMAC ChaCha20 serveur
    readonly timestamp: number;
  }
  ```
- **Codes d'erreur** :
  - `400 Bad Request` : Formule invalide ou non supportée pour l'`Actor`.
  - `403 Forbidden` : Utilisateur non autorisé à modifier cet `Actor`.
  - `404 Not Found` : Campagne ou `Actor` introuvable.

#### En Session Active (WebSocket CQRS)
- **Commande émise** :
  ```typescript
  export interface WsDiceRollCommand {
    readonly type: 'RollDice';
    readonly payload: {
      readonly actorId: string;
      readonly formula: string;
      readonly reason: 'level_up_hp' | 'short_rest_hit_dice';
    };
  }
  ```
- **Événement `TrameEvent` diffusé en retour** :
  ```typescript
  export interface WsDiceRolledEvent {
    readonly type: 'DiceRolled';
    readonly payload: {
      readonly actorId: string;
      readonly formula: string;
      readonly rolls: readonly number[];
      readonly total: number;
      readonly signature: string;
      readonly reason: string;
    };
  }
  ```

---

## 7. Extension du Compendium SRD 5.1 (`compendium.ts`)

### 7.1 Schéma Bilingue et Compatibilité

Chaque entrée du compendium respecte l'interface unifiée suivante :

```typescript
export interface LocalizedDisplayMetadata {
  readonly name: string;
  readonly description: string;
}

export interface CompendiumEntryI18n {
  readonly en: LocalizedDisplayMetadata;
  readonly fr: LocalizedDisplayMetadata;
}

export interface BaseCompendiumEntry {
  readonly id: string; // Slugs canoniques ASCII universels: "srd:item:longsword"
  readonly type: 'weapon' | 'armor' | 'container' | 'spell' | 'feat' | 'monster';
  readonly i18n?: CompendiumEntryI18n;
}
```

### 7.2 Entrées Obligatoires à Intégrer

1. **Conteneurs** :
   - `srd:item:backpack` : Sac à dos standard (poids 5 lbs, capacité 30 lbs, `contentWeightMultiplier: 1`).
   - `srd:item:bag_of_holding` : Sac sans fond (poids 15 lbs, capacité 500 lbs, `contentWeightMultiplier: 0`).
2. **Armes et Armures de Référence** :
   - Dague, Épée longue, Épée à deux mains, Arc court, Arc long, Arbalète légère.
   - Armure de cuir, Armure d'écailles, Cotte de mailles, Harnois, Écu (bouclier).
3. **Sorts Emblématiques (Niveaux 0 à 5)** :
   - Niveau 0 : Trait de feu, Lumière, Main de mage, Réparation, Moquerie vicieuse.
   - Niveau 1 : Projectile magique, Soin des blessures, Bouclier, Vague tonnante, Bénédiction.
   - Niveau 2 : Rayon ardent, Invisibilité, Foulée brumeuse, Lévitation.
   - Niveau 3 : Boule de feu, Éclair, Hâte, Dissipation de la magie.
   - Niveau 4 : Invisibilité majeure, Métamorphose, Bouclier de feu.
   - Niveau 5 : Cône de froid, Téléportation de cercle, Rappel à la vie.
4. **Dons SRD** :
   - Tireur d'élite (`srd:feat:sharpshooter`), Cogneur lourd (`srd:feat:great_weapon_master`), Robuste (`srd:feat:tough`), Sentinelle (`srd:feat:sentinel`), Combattant à deux armes (`srd:feat:dual_wielder`).
5. **Gabarits de Monstres SRD 1-Click pour le GM** :
   - Gobelin (`srd:monster:goblin`, CR 1/4)
   - Bandit (`srd:monster:bandit`, CR 1/8)
   - Garde (`srd:monster:guard`, CR 1/8)
   - Squelette (`srd:monster:skeleton`, CR 1/4)
   - Loup (`srd:monster:wolf`, CR 1/4)
   - Ogre (`srd:monster:ogre`, CR 2)
   - Dragon rouge adulte (`srd:monster:adult_red_dragon`, CR 17)

---

## 8. Stratégie de Test et Critères d'Acceptation

### 8.1 Tests Paramétrés `@trame/game-system-dnd5e`
- **Fichier** : `packages/game-systems/dnd5e/tests/progression.test.ts`
  - Tester l'élévation du niveau 1 au niveau 20 pour chaque classe de base.
  - Valider que le gain de PV en mode fixe applique strictement `floor(hitDie / 2) + 1 + conMod` avec plancher de 1.
  - Valider que le gain de PV en mode tiré rejette les valeurs négatives, nulles ou supérieures à la taille du dé.
  - Valider que les niveaux d'ASI attribuent correctement `+2` ou `+1/+1` et lèvent une exception si un score dépasse 20.
  - Valider la sous-classe obligatoire au niveau requis (1, 2 ou 3 selon la classe).
  - Valider l'ajustement exact des emplacements de sorts pour un Magicien (Full), Paladin (Half) et Occultiste (Pact).
- **Fichier** : `packages/game-systems/dnd5e/tests/rest.test.ts`
  - Tester `applyShortRest` avec 0, 1 et plusieurs dés de vie dépensés.
  - Valider que `applyShortRest` rejette toute dépense de dés supérieure à `hitDice.current`.
  - Valider la restauration des réserves `SHORT_REST` et des emplacements Warlock Pact.
  - Tester `applyLongRest` et valider la restauration à 100% des points de vie et la remise à 0 de `tempHp`.
  - Valider la récupération de dés de vie `Math.max(1, Math.floor(hitDiceMax / 2))` sans dépasser `hitDiceMax`.
  - Valider la réduction de 1 point d'épuisement lors d'un `LongRest`.

### 8.2 Tests d'Intégration UI Preact `@trame/web`
- **Fichier** : `packages/web/tests/modals/LevelUpModal.test.tsx`
  - Simuler la montée de niveau 3 -> 4 : vérifier le verrouillage de l'étape ASI tant qu'une sélection valide n'a pas été faite.
  - Simuler le tirage de dés serveur : vérifier l'appel de l'API de dés et la mise à jour autoritaire sans appel à `Math.random()`.
  - Vérifier la persistance via `onSave` lors du clic final.
- **Fichier** : `packages/web/tests/modals/RestModal.test.tsx`
  - Simuler un repos court avec dépense de 2 dés de vie et vérifier l'affichage des nouveaux points de vie.
  - Simuler un repos long et vérifier l'application des réinitialisations de sorts et de points de vie.
