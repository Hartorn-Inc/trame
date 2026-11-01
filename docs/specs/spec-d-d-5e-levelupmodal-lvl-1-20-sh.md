# Technical & Functional Specification: D&D 5e LevelUpModal (Lvl 1-20), ShortRest/LongRest UI & Expanded SRD 5.1 Compendium

> **Rules baseline superseded:** the pack now targets SRD 5.2.1 (2024 rules), see [ADR-0038](../adr/0038-srd-521-rules-baseline.md). SRD 5.1 content, subclass levels, feats and attribution text below are historical.

- **Identifier**: `spec-d-d-5e-levelupmodal-lvl-1-20-sh`
- **Title**: Technical specification of level-up (levels 1-20), the rest interface and the SRD 5.1 compendium expansion
- **Status**: Ready for implementation
- **Compliance**: ASD-STE100 controlled technical writing (EPURE governance ADR-0031, upstream; not an ADR of this repository)
- **Related ADRs**: ADR-0001, ADR-0036, ADR-0037

---

## 1. Context & Business Goals

TRAME currently has no user interface that lets a player or a game master raise an `Actor`'s level from 1 to 20. The existing `applyLevelUp` function in `@trame/game-system-dnd5e` does not accept a subclass choice, an Ability Score Improvement (ASI) vs Feat choice, or spell learning. In addition, there is no interface to trigger a `ShortRest` or a `LongRest`. Finally, the `compendium.ts` compendium contains only a minimal item set with no magic containers, feats, complete spells or reference monster templates.

This specification defines the complete implementation of the business rules, the user interfaces and the reference data needed to remove these blockers.

---

## 2. Model Invariants and SRD 5.1 Business Rules

### 2.1 Actor Integrity Invariants
1. An `Actor`'s total level is an integer between 1 and 20 inclusive (`1 <= level <= 20`).
2. `ProficiencyBonus` is a derived value determined only by the `Actor`'s total level (one shared `calculateProficiencyBonus` function):
   - Levels 1 to 4: `+2`
   - Levels 5 to 8: `+3`
   - Levels 9 to 12: `+4`
   - Levels 13 to 16: `+5`
   - Levels 17 to 20: `+6`
3. No `AbilityScore` can exceed 20 through an Ability Score Improvement (ASI) choice.
4. The maximum hit point gain (`maxHp`) at each level respects a strict floor of 1 hit point (`max(1, hitDieGain + constitutionModifier)`).
5. An `Actor`'s total hit dice (`hitDiceCurrent`) can never exceed the ceiling `hitDiceMax`, which equals the `Actor`'s total level.
6. Raising the Constitution modifier (through an ASI or a feat) increases `hp.max` retroactively by the modifier change times the `Actor`'s total level. The *Tough* feat adds `+2` HP per level, retroactively.
7. The `Actor` sheet interface locks direct editing of core abilities outside the `LevelUpModal` component, according to `CoreBuildLock` (see also `PadlockEditMode`).

---

## 3. Data Architecture and TypeScript Signatures

### 3.1 Level-Up Types (`packages/game-systems/dnd5e/src/progression.ts`)

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

### 3.2 Rest Types (`packages/game-systems/dnd5e/src/rest.ts`)

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

## 4. Business Execution Contracts

### 4.1 `applyLevelUp` Contract

```typescript
export function applyLevelUp(actor: Dnd5eActorData, options: LevelUpOptions): Dnd5eActorData;
```

1. The engine validates the level condition: `options.targetLevel` must equal `actor.system.level + 1`. Otherwise the engine throws `Error('Invalid level increment')`.
2. The engine validates the level cap: `options.targetLevel` cannot exceed 20. If `options.targetLevel > 20`, the engine throws `Error('Max level is 20')`.
3. Hit point gain:
   - The engine identifies the hit die size `hitDieSize` of the `Actor`'s class (6 for Sorcerer/Wizard; 8 for Bard/Cleric/Druid/Monk/Rogue/Warlock; 10 for Fighter/Paladin/Ranger; 12 for Barbarian).
   - The engine computes the Constitution modifier `conMod = floor((actor.system.abilities.constitution.value - 10) / 2)`.
   - If `options.hitPointsMode === 'fixed'`, the engine computes `baseGain = floor(hitDieSize / 2) + 1`.
   - If `options.hitPointsMode === 'rolled'`, the engine requires `options.rolledHp`. If `options.rolledHp` is missing, below 1 or above `hitDieSize`, the engine throws `Error('Invalid rolledHp value')`. The engine sets `baseGain = options.rolledHp`.
   - The engine computes the net hit point increase: `hpIncrease = Math.max(1, baseGain + conMod)`.
   - The engine increments `actor.system.attributes.hp.max` and `actor.system.attributes.hp.value` by `hpIncrease`.
   - The engine increments `actor.system.attributes.hitDice.max` by 1 and `actor.system.attributes.hitDice.current` by 1.
4. Subclass assignment:
   - The engine checks whether the `Actor`'s class gains its subclass at the target level (`targetLevel === 1` for Cleric, Sorcerer and Warlock; `targetLevel === 2` for Druid and Wizard; `targetLevel === 3` for Barbarian, Bard, Fighter, Monk, Paladin, Ranger and Rogue).
   - If the level matches the required tier and `options.subclassId` is provided, the engine sets `actor.system.details.subclass = options.subclassId`.
   - If the level matches the required tier and `options.subclassId` is missing, the engine throws `Error('Subclass selection required at this level')`.
5. ASI or Feat assignment:
   - The engine identifies the class's ASI levels:
     - Fighter: levels 4, 6, 8, 12, 14, 16, 19.
     - Rogue: levels 4, 8, 10, 12, 16, 19.
     - Other classes: levels 4, 8, 12, 16, 19.
   - If `targetLevel` is an ASI level, the engine requires `options.asiOrFeat`.
   - If `options.asiOrFeat.mode === 'asi'`:
     - The engine checks that the bonuses sum to 2 (either `+2` on one ability, or `+1` on exactly two distinct abilities).
     - For each targeted ability, the engine checks that `actor.system.abilities[key].value + bonus <= 20`. If a score would exceed 20, the engine throws `Error('Ability score cannot exceed 20')`.
     - The engine applies the bonuses to the targeted scores. If the Constitution modifier increases, the engine adds the modifier change times the new total level to `hp.max` and `hp.value` (retroactive HP).
   - If `options.asiOrFeat.mode === 'feat'`:
     - The engine checks that `featId` exists in `SystemSRD`.
     - The engine adds the feat identifier to `actor.system.features`. For *Tough* (`srd:feat:tough`), the engine adds `+2` HP per level, retroactively.
6. Spell progression and reconciliation:
   - The engine identifies the class's caster category:
     - `FULL_CASTER`: Bard, Cleric, Druid, Sorcerer, Wizard.
     - `HALF_CASTER`: Paladin, Ranger.
     - `PACT_MAGIC`: Warlock.
     - `NONE`: Barbarian, Fighter (outside a spellcasting subclass), Monk, Rogue.
   - The engine calls `reconcileSlots(actor: Dnd5eActorData, targetSlots: readonly number[]): void`:
     - The engine updates the maximum capacity of spell slots levels 1 to 9 to match the matching table.
     - The engine adjusts the current pool of each slot without exceeding the new maximum.
   - If `options.newSpellIds` is provided, the engine adds the valid spell identifiers to `actor.system.spells` without duplicates.
7. Derived value recomputation:
   - The engine recomputes the `Actor`'s `ProficiencyBonus`.
   - The engine recomputes the saving throw and skill modifiers from the new ability values and the `ProficiencyBonus`. Derived formulas are evaluated by the single WASM `derivedDAG` evaluator (ADR-0001 amendment).
8. The engine sets `actor.system.level = options.targetLevel` and returns the updated `Dnd5eActorData` immutably.

### 4.2 `reconcileSlots` Contract

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

### 4.3 `applyShortRest` Contract

```typescript
export function applyShortRest(actor: Dnd5eActorData, options: ShortRestOptions): Dnd5eActorData;
```

1. Hit die spending:
   - If `options.hitDieSpend` is provided:
     - The engine checks that `options.hitDieSpend.count <= actor.system.attributes.hitDice.current`. If the count exceeds the remaining dice, the engine throws `Error('Insufficient hit dice')`.
     - The engine checks that the length of `options.hitDieSpend.rollResults` equals `options.hitDieSpend.count`.
     - The Constitution modifier `conMod = floor((actor.system.abilities.constitution.value - 10) / 2)` is computed.
     - For each `roll` in `options.hitDieSpend.rollResults`, the HP gain is `hpGain = Math.max(1, roll + conMod)`.
     - The engine adds the sum of the `hpGain` values to `actor.system.attributes.hp.value` without exceeding `actor.system.attributes.hp.max`.
     - The engine decrements `actor.system.attributes.hitDice.current` by `options.hitDieSpend.count`.
2. `SHORT_REST` pool recovery:
   - The engine iterates over every `ResourcePool` of the `Actor`.
   - For every resource with `recovery === 'SHORT_REST'`, the engine sets `resource.value = resource.max`.
3. Pact Magic recovery (Warlock):
   - If the `Actor` has Pact Magic slots (`actor.system.spells.pact`), the engine resets `actor.system.spells.pact.value = actor.system.spells.pact.max`.
4. The engine returns the new `Actor` state.

### 4.4 `applyLongRest` Contract

```typescript
export function applyLongRest(actor: Dnd5eActorData): Dnd5eActorData;
```

0. A dead `Actor` (`isDead === true`) stays dead: a long rest never revives it and never resets its death state.
1. Hit point restoration:
   - The engine sets `actor.system.attributes.hp.value = actor.system.attributes.hp.max`.
   - The engine sets `actor.system.attributes.tempHp.value = 0`.
2. Hit dice restoration:
   - The engine computes the recovered hit dice: `recoveredDice = Math.max(1, Math.floor(actor.system.attributes.hitDice.max / 2))`.
   - The engine sets `actor.system.attributes.hitDice.current = Math.min(actor.system.attributes.hitDice.max, actor.system.attributes.hitDice.current + recoveredDice)`.
3. Spell slot restoration:
   - For each spell slot level 1 to 9 (`tier_1` to `tier_9`), the engine sets `slot.value = slot.max`.
   - If the `Actor` has Pact Magic slots (`actor.system.spells.pact`), the engine sets `pact.value = pact.max`.
4. `LONG_REST` and `SHORT_REST` pool recovery:
   - For every resource with `recovery === 'LONG_REST'` or `recovery === 'SHORT_REST'`, the engine sets `resource.value = resource.max`.
5. Exhaustion reduction:
   - If `actor.system.attributes.exhaustion > 0`, the engine decrements `actor.system.attributes.exhaustion = actor.system.attributes.exhaustion - 1`.
6. The engine returns the new `Actor` state.

---

## 5. User Interface (UI) Component Specification

### 5.1 `LevelUpModal` Component

- **Location**: `packages/web/src/components/modals/LevelUpModal.tsx`
- **Triggers**: a `[Level up (N -> N+1)]` button in the top banner of an `Actor` sheet in `CampaignWorkspace` and in the `HudDrawers.tsx` HUD drawer.
- **Component properties**:
  ```typescript
  export interface LevelUpModalProps {
    readonly actor: Dnd5eActorData;
    readonly isOpen: boolean;
    readonly onClose: () => void;
    readonly onSave: (updatedActor: Dnd5eActorData) => Promise<void>;
    readonly diceRollService: DiceRollService;
  }
  ```

#### 4-Step Guided Workflow

1. **Step 1: Class confirmation and subclass choice**
   - The component shows the `Actor`'s current class and its target level `N + 1`.
   - IF `N + 1` is the subclass tier of the `Actor`'s class and `actor.system.details.subclass` is unset, THEN the component shows a required drop-down fed by `SystemSRD.getSubclasses(actor.system.details.class)`.
   - IF a subclass choice is required and none is selected, THEN the component disables the `[Next]` button.

2. **Step 2: Hit point gain (fixed average vs server roll)**
   - The component offers two mutually exclusive radio buttons: `Fixed average` or `Roll the hit die`.
   - IF the user selects `Fixed average`, THEN the component computes and shows the formula: `gain = floor(hitDieSize / 2) + 1 + conModifier`.
   - IF the user selects `Roll the hit die`, THEN the component shows a `[Roll 1dX]` button.
   - Clicking `[Roll 1dX]` calls the server according to the dice API contract in section 6.2.
   - The component shows the server's certified roll result and computes the net gain: `max(1, roll + conModifier)`.
   - IF `Roll the hit die` is selected and no server roll has been confirmed, THEN the component disables the `[Next]` button.

3. **Step 3: Ability Score Improvement (ASI) or Feat**
   - IF level `N + 1` is not an ASI tier for the `Actor`'s class, THEN the component skips this step automatically or shows a summary without input.
   - IF level `N + 1` is an ASI tier, THEN the component offers a two-way selector: `Ability Score Improvement (+2 or +1/+1)` and `Choose a Feat`.
   - ASI case: the user allocates either `+2` to one ability or `+1` to two different abilities. The component disables any increment that would raise an ability above 20.
   - Feat case: the component shows the drop-down list of eligible feats from `SystemSRD.getFeats()`. A feat choice is required.
   - IF the ASI or Feat selection is incomplete or invalid, THEN the component disables the `[Next]` button.

4. **Step 4: Spell management and final summary**
   - IF the `Actor`'s class is not a spellcaster, THEN the component shows only the summary screen.
   - IF the `Actor`'s class is a spellcaster, THEN the component shows the new spell slot grid derived from the SRD 5.1 progression.
   - Deterministic learning limits per target level:
     - Wizard: the interface requires exactly 2 new spells of a level lower than or equal to the highest unlocked slot level.
     - Sorcerer / Bard / Warlock: the interface allows exactly 1 new spell if the class progression table grants one at level `N + 1`.
     - Cleric / Druid / Paladin: the interface tells the user that the whole class spell list is unlocked for daily preparation.
     - At every level, the list offers spells at every spell level the caster can cast (casters at level 11+ always have spells to choose), so level-up is never blocked.
   - The `[Confirm and apply]` button runs the local mutation through `applyLevelUp`, calls `onSave(updatedActor)` and closes the modal.

### 5.2 `RestModal` Component

- **Location**: `packages/web/src/components/modals/RestModal.tsx`
- **Triggers**: `[Short rest]` and `[Long rest]` buttons in the top banner of an `Actor` sheet.
- **Component properties**:
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

#### Short Rest Workflow (`restType === 'short'`)
1. The component shows the current hit dice available: `hitDice.current` / `hitDice.max`.
2. The user selects how many hit dice to spend (between 0 and `hitDice.current`).
3. IF the selected number is greater than 0, THEN the user clicks `[Roll recovery dice]`.
4. The client sends the roll request to the server according to the contract in section 6.2 for each selected die.
5. The component shows each die roll, applies the Constitution modifier to each die, computes the hit points recovered, and shows the `SHORT_REST` pools that will be reset.
6. Clicking `[Finish short rest]` runs `applyShortRest`, persists the `Actor` through `onSave` and records the event.

#### Long Rest Workflow (`restType === 'long'`)
1. The component shows a summary of the long rest's authoritative effects:
   - Full HP restoration (`hp.value` becomes `hp.max`).
   - Recovery of `max(1, floor(hitDiceMax / 2))` hit dice.
   - Temporary HP reset to zero.
   - Full restoration of every spell slot and of the `LONG_REST` / `SHORT_REST` pools.
   - Exhaustion reduced by 1 level (if above 0).
   - A dead character stays dead.
2. Clicking `[Confirm long rest]` runs `applyLongRest`, persists the `Actor` through `onSave` and closes the modal.

---

## 6. Network Interface and Persistence Contracts

### 6.1 Actor Persistence (ADR-0037)

Every sheet change — in `CampaignWorkspace` or from the live table HUD (`HudDrawers.tsx`) — uses the same REST route. There is no WebSocket `UpdateActorData` command (superseded by ADR-0037).

- **Protocol**: HTTP REST
- **Method / route**: `PUT /api/v1/campaigns/{campaign_id}/actors/{actor_id}`
- **Payload**:
  ```json
  {
    "expected_version": 7,
    "system": { ... }
  }
  ```
- **HTTP 200 response**: the updated `Actor` object with its new `version`.
- **HTTP 409 Conflict**: `expected_version` is stale; the client reloads the `Actor` and retries.
- **Behavior**: after the commit in `SqlxPostgresStore`, the server notifies the active `TableRoomActor` (if loaded), which broadcasts `ServerEnvelope::ActorUpdated` to synchronize the Preact signals and resynchronizes only the `LinkedActorToken`s of that `Actor`. No `UndoEntry` is pushed.

### 6.2 Authoritative Dice Service (`ChaCha20Rng`)

#### Sheet-Driven Rolls (REST, always)
Level-up HP rolls and rest hit dice always use REST, so they work while the table room is hibernated. When the room is awake, the result is also appended to the table roll log and the session timeline.

- **Method / route**: `POST /api/v1/campaigns/{campaign_id}/dice/roll`
- **Headers**: session cookie (`trame_session`), `Content-Type: application/json`
- **Request payload**:
  ```typescript
  export interface RestDiceRollRequest {
    readonly actorId: string;
    readonly formula: string; // e.g. "1d8", "2d6"
    readonly reason: 'level_up_hp' | 'short_rest_hit_dice';
  }
  ```
- **HTTP 200 response payload**:
  ```typescript
  export interface RestDiceRollResponse {
    readonly formula: string;
    readonly rolls: readonly number[]; // e.g. [6]
    readonly total: number;
    readonly signature: string; // server HMAC signature of the roll
    readonly timestamp: number;
  }
  ```
- **Error codes**:
  - `400 Bad Request`: invalid or unsupported formula for the `Actor` (expression length and term count are bounded).
  - `403 Forbidden`: the user is not allowed to change this `Actor`.
  - `404 Not Found`: campaign or `Actor` not found.

#### Table Tray Rolls (WebSocket)
Rolls from the live table dice tray use the WebSocket `RollDice` envelope:
- **Command sent**:
  ```typescript
  export interface WsDiceRollCommand {
    readonly type: 'RollDice';
    readonly payload: {
      readonly expression: string;
      readonly visibility: 'Public' | 'GmOnly' | 'BlindGm';
      readonly reason: string;
    };
  }
  ```
- **Event broadcast in return** (`ServerEnvelope::DiceRolled`):
  ```typescript
  export interface WsDiceRolledEvent {
    readonly type: 'DiceRolled';
    readonly payload: {
      readonly expression: string;
      readonly rolls: readonly number[];
      readonly total: number;
      readonly reason: string;
    };
  }
  ```

---

## 7. SRD 5.1 Compendium Extension (`compendium.ts`)

### 7.1 Bilingual Schema and Compatibility

Every compendium entry follows this unified interface:

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
  readonly id: string; // Universal canonical ASCII slugs: "srd:item:longsword"
  readonly type: 'weapon' | 'armor' | 'container' | 'spell' | 'feat' | 'monster';
  readonly i18n?: CompendiumEntryI18n;
}
```

### 7.2 Required Entries

1. **Containers**:
   - `srd:item:backpack`: standard backpack (weight 5 lb, capacity 30 lb, `contentWeightMultiplier: 1`).
   - `srd:item:bag_of_holding`: Bag of Holding (weight 15 lb, capacity 500 lb, `contentWeightMultiplier: 0`).
2. **Reference weapons and armor**:
   - Dagger, Longsword, Greatsword, Shortbow, Longbow, Light Crossbow.
   - Leather Armor, Scale Mail, Chain Mail, Plate, Shield.
3. **Signature spells (levels 0 to 5)**:
   - Level 0: Fire Bolt, Light, Mage Hand, Mending, Vicious Mockery.
   - Level 1: Magic Missile, Cure Wounds, Shield, Thunderwave, Bless.
   - Level 2: Scorching Ray, Invisibility, Misty Step, Levitate.
   - Level 3: Fireball, Lightning Bolt, Haste, Dispel Magic.
   - Level 4: Greater Invisibility, Polymorph, Fire Shield.
   - Level 5: Cone of Cold, Teleportation Circle, Raise Dead.
4. **SRD feats**:
   - Sharpshooter (`srd:feat:sharpshooter`), Great Weapon Master (`srd:feat:great_weapon_master`), Tough (`srd:feat:tough`), Sentinel (`srd:feat:sentinel`), Dual Wielder (`srd:feat:dual_wielder`).
5. **1-click SRD monster templates for the GM**:
   - Goblin (`srd:monster:goblin`, CR 1/4)
   - Bandit (`srd:monster:bandit`, CR 1/8)
   - Guard (`srd:monster:guard`, CR 1/8)
   - Skeleton (`srd:monster:skeleton`, CR 1/4)
   - Wolf (`srd:monster:wolf`, CR 1/4)
   - Ogre (`srd:monster:ogre`, CR 2)
   - Adult Red Dragon (`srd:monster:adult_red_dragon`, CR 17)

The convergence spec (`spec-playable-dnd5e-campaign-convergence.md`) extends this minimum to the curated ~160-entry `SystemSRD`.

---

## 8. Test Strategy and Acceptance Criteria

### 8.1 Parametrized `@trame/game-system-dnd5e` Tests
- **File**: `packages/game-systems/dnd5e/tests/progression.test.ts`
  - Level every base class from 1 to 20.
  - Check that the fixed-mode HP gain strictly applies `floor(hitDie / 2) + 1 + conMod` with a floor of 1.
  - Check that the rolled-mode HP gain rejects negative, zero or above-die-size values.
  - Check that ASI levels correctly apply `+2` or `+1/+1` and throw if a score would exceed 20.
  - Check the required subclass at the right level (1, 2 or 3 depending on the class; Warlock at 1).
  - Check that a CON-raising ASI and the *Tough* feat add HP retroactively for every earlier level.
  - Check that casters at level 11+ always have spells to choose.
  - Check the exact spell slot adjustment for a Wizard (full), a Paladin (half) and a Warlock (pact).
- **File**: `packages/game-systems/dnd5e/tests/rest.test.ts`
  - Test `applyShortRest` with 0, 1 and several hit dice spent.
  - Check that `applyShortRest` rejects spending more dice than `hitDice.current`.
  - Check the restoration of `SHORT_REST` pools and Warlock Pact Magic slots.
  - Test `applyLongRest` and check full hit point restoration and `tempHp` reset to 0.
  - Check hit dice recovery `Math.max(1, Math.floor(hitDiceMax / 2))` without exceeding `hitDiceMax`.
  - Check the 1-point exhaustion reduction on a `LongRest`.
  - Check that a `LongRest` does not revive a dead `Actor`.

### 8.2 Preact UI Integration Tests (`@trame/web`)
- **File**: `packages/web/tests/modals/LevelUpModal.test.tsx`
  - Simulate level-up 3 -> 4: check that the ASI step stays locked until a valid selection is made.
  - Simulate the server dice roll: check the dice API call and the authoritative update without any call to `Math.random()`.
  - Check persistence through `onSave` on the final click.
- **File**: `packages/web/tests/modals/RestModal.test.tsx`
  - Simulate a short rest spending 2 hit dice and check the new hit points shown.
  - Simulate a long rest and check that spells and hit points are reset.
