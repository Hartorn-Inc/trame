# Specification: Declarative Character Sheet UI, Guided Character Builder & Compendium Drag-and-Drop

## 1. Architectural Overview & Design Goals

### 1.1 System Architecture & Responsibilities
The character sheet subsystem renders Actor data declaratively inside `packages/web` without hardcoding game system rules or layouts.
- `packages/game-systems/dnd5e` provides the `SheetLayoutTree` in its `system.json` manifest.
- `packages/web/src/sheet` parses the layout tree, resolves data bindings, and renders atomic widgets.
- `packages/web/src/builder` manages transient character creation drafts.
- `packages/web/src/dnd` handles drag-and-drop payload validation, container cycle detection, and container weight evaluation.
- `trame-engine` maintains authoritative game state and computes derived stats via the 5-phase `ActiveEffect` pipeline.

### 1.2 Command Dispatch Pipeline
Atomic widgets and drag-and-drop handlers do not mutate Actor records directly. Every user interaction constructs and dispatches a canonical `TrameCommand` payload through an injected `CommandDispatcher` callback:
- `TrameCommand.RollDice`: Dispatched when triggering an attack, ability check, saving throw, hit die spend, or spell cast.
- `TrameCommand.ProjectAoE`: Dispatched when triggering an area-of-effect spell or action.
- `TrameCommand.UpdateActorSheet`: Dispatched when toggling resource counters, spell slot pips, death save counters, or moving items between containers.
- `TrameCommand.DropCompendiumEntry`: Dispatched when dropping an item, feat, or spell from the compendium onto the character sheet.
- `TrameCommand.CreateActor`: Dispatched when the user finalizes the `CharacterBuilderWizard`.

### 1.3 Test Framework Contract
In accordance with ADR-0037 and the project architecture, `packages/web` uses the native Node 24 test runner (`node:test` and `node:assert/strict`) with native TypeScript support. No browser mock libraries (`@testing-library/react`, Vitest, jsdom) are permitted. All unit and integration tests execute headlessly through `npm test`.

---

## 2. Layout AST & Schema Specification

### 2.1 `SheetLayoutTree` Schema & Typing
A character sheet layout is defined as a hierarchical tree of nodes:

```typescript
export type LayoutNodeKind = 'section' | 'column' | 'row' | 'tabs' | 'widget';

export type VisibilityTier = 'PUBLIC' | 'OWNER_ONLY' | 'GM_ONLY';

export interface BaseLayoutNode {
  id: string;
  kind: LayoutNodeKind;
  visibilityTier?: VisibilityTier;
  cssClass?: string;
}

export interface ContainerLayoutNode extends BaseLayoutNode {
  kind: 'section' | 'column' | 'row';
  title?: string;
  children: SheetLayoutNode[];
}

export interface TabsLayoutNode extends BaseLayoutNode {
  kind: 'tabs';
  defaultTabId: string;
  tabs: Array<{
    id: string;
    label: string;
    icon?: string;
    children: SheetLayoutNode[];
  }>;
}

export interface WidgetLayoutNode extends BaseLayoutNode {
  kind: 'widget';
  widgetType: string;
  bindings: Record<string, string>;
  options?: Record<string, unknown>;
}

export type SheetLayoutNode = ContainerLayoutNode | TabsLayoutNode | WidgetLayoutNode;

export interface SheetLayoutTree {
  systemId: string;
  version: string;
  root: SheetLayoutNode;
}
```

### 2.2 Container Layout Nodes
- `section`: Groups related elements under an optional header.
- `column`: Arranges child nodes vertically.
- `row`: Arranges child nodes horizontally.
- `tabs`: Organizes child nodes into switchable tabs.

### 2.3 Duplicate ID Detection & Validation
`DeclarativeSheetRenderer` validates node identity uniqueness before rendering.
- WHEN `DeclarativeSheetRenderer.parse(tree)` processes a `SheetLayoutTree`, THEN it collects all node IDs into a tracking set.
- IF a node ID appears more than once in the tree, THEN `DeclarativeSheetRenderer` throws a `DuplicateNodeIdError` containing the duplicate ID.

### 2.4 Permission & Visibility Tiers
- `PUBLIC`: Rendered for all connected clients.
- `OWNER_ONLY`: Rendered only for the player owning the Actor and GMs.
- `GM_ONLY`: Rendered exclusively for GM clients.
- IF a client lacks required permissions for a node, THEN `DeclarativeSheetRenderer` omits that node and all its child nodes from the rendered output.

---

## 3. The 12 Canonical Atomic Widgets

### 3.1 `StatBlock6`
- **Description**: Displays the six primary ability scores (Strength, Dexterity, Constitution, Intelligence, Wisdom, Charisma) with scores and calculated modifiers.
- **Required Bindings**:
  - `abilities`: Path resolving to `Record<string, { score: number; modifier: number }>`.
- **Options**:
  - `displayOrder`: Optional array of ability keys (default: `['str', 'dex', 'con', 'int', 'wis', 'cha']`).
- **Interactions**:
  - WHEN a user clicks an ability card, THEN `StatBlock6` dispatches a `TrameCommand.RollDice` command for `1d20 + {modifier}`.

### 3.2 `ResourceBar`
- **Description**: Displays a bounded numeric resource bar with current, maximum, and temporary values.
- **Required Bindings**:
  - `current`: Path resolving to `number`.
  - `max`: Path resolving to `number`.
  - `temp`: Optional path resolving to `number`.
- **Options**:
  - `label`: String title (for example, `Hit Points`).
  - `color`: CSS color token or hex string.
- **Interactions**:
  - WHEN a user adjusts the resource input, THEN `ResourceBar` dispatches a `TrameCommand.UpdateActorSheet` command setting the new numeric value.

### 3.3 `SavingThrowList`
- **Description**: Displays saving throw modifiers and proficiency toggles for each ability.
- **Required Bindings**:
  - `saves`: Path resolving to `Record<string, { modifier: number; proficient: boolean }>`.
- **Interactions**:
  - WHEN a user clicks a saving throw row, THEN `SavingThrowList` dispatches a `TrameCommand.RollDice` command for `1d20 + {modifier}`.

### 3.4 `SkillCheckList`
- **Description**: Displays skill checks with proficiency level indicators (none, proficient, expertise) and passive scores.
- **Required Bindings**:
  - `skills`: Path resolving to `Record<string, { modifier: number; proficiencyLevel: string; passive: number }>`.
- **Interactions**:
  - WHEN a user clicks a skill row, THEN `SkillCheckList` dispatches a `TrameCommand.RollDice` command for `1d20 + {modifier}`.

### 3.5 `ArmorInitiativeSpeed`
- **Description**: Displays armor class, initiative modifier, and movement speeds in a three-card layout.
- **Required Bindings**:
  - `armorClass`: Path resolving to `number`.
  - `initiative`: Path resolving to `number`.
  - `speed`: Path resolving to `string` or `Record<string, number>`.
- **Interactions**:
  - WHEN a user clicks the initiative card, THEN `ArmorInitiativeSpeed` dispatches a `TrameCommand.RollDice` command for `1d20 + {initiative}`.

### 3.6 `HitDiceAndDeathSaves`
- **Description**: Renders hit dice counts, recovery roll buttons, and death save trackers.
- **Required Bindings**:
  - `hitDiceCurrent`: Path resolving to `number`.
  - `hitDiceMax`: Path resolving to `number`.
  - `hitDieSides`: Path resolving to `number`.
  - `conModifier`: Path resolving to `number`.
  - `deathSuccesses`: Path resolving to `number` (range: 0 to 3).
  - `deathFailures`: Path resolving to `number` (range: 0 to 3).
- **Interactions**:
  - WHEN a user clicks 'Spend Hit Die', THEN `HitDiceAndDeathSaves` dispatches a `TrameCommand.RollDice` command for `1d{hitDieSides} + {conModifier}` AND dispatches a `TrameCommand.UpdateActorSheet` command decrementing `hitDiceCurrent` by 1.
  - WHEN a user clicks 'Roll Death Save', THEN `HitDiceAndDeathSaves` dispatches a `TrameCommand.RollDice` command for `1d20`.
  - IF the death save roll result equals 1, THEN `HitDiceAndDeathSaves` increments `deathFailures` by 2 via `TrameCommand.UpdateActorSheet`.
  - IF the death save roll result is between 2 and 9 inclusive, THEN `HitDiceAndDeathSaves` increments `deathFailures` by 1 via `TrameCommand.UpdateActorSheet`.
  - IF the death save roll result is between 10 and 19 inclusive, THEN `HitDiceAndDeathSaves` increments `deathSuccesses` by 1 via `TrameCommand.UpdateActorSheet`.
  - IF the death save roll result equals 20, THEN `HitDiceAndDeathSaves` resets `deathSuccesses` and `deathFailures` to 0 AND increments current hit points by 1 via `TrameCommand.UpdateActorSheet`.

### 3.7 `AttackActionTable`
- **Description**: Displays weapon attacks and action items with attack bonus, damage formula, and range.
- **Required Bindings**:
  - `attacks`: Path resolving to an array of attack objects (`{ id, name, attackBonus, damageFormula, damageType, range }`).
- **Interactions**:
  - WHEN a user clicks an attack roll button, THEN `AttackActionTable` dispatches a `TrameCommand.RollDice` command for `1d20 + {attackBonus}`.
  - WHEN a user clicks a damage roll button, THEN `AttackActionTable` dispatches a `TrameCommand.RollDice` command for `{damageFormula}`.

### 3.8 `SpellbookAccordion`
- **Description**: Displays spells grouped by spell level, available spell slot pips, spell save DC, and spell attack bonus.
- **Required Bindings**:
  - `slots`: Path resolving to `Record<string, { current: number; max: number }>`.
  - `spells`: Path resolving to an array of spell objects (`{ id, name, level, school, range, castingTime, requiresAoE, aoeShape }`).
  - `spellSaveDc`: Path resolving to `number`.
  - `spellAttackBonus`: Path resolving to `number`.
- **Options**:
  - `autoDeductSlots`: Boolean (default: `true`).
- **Interactions**:
  - WHEN a user clicks a spell slot pip, THEN `SpellbookAccordion` dispatches a `TrameCommand.UpdateActorSheet` command toggling the slot count.
  - WHEN a user clicks 'Cast Spell' on a non-AoE spell, THEN `SpellbookAccordion` dispatches a `TrameCommand.RollDice` command.
  - WHEN a user clicks 'Cast Spell' on an AoE spell, THEN `SpellbookAccordion` dispatches a `TrameCommand.ProjectAoE` command.
  - IF `options.autoDeductSlots` equals `true` AND the spell level is greater than 0, THEN `SpellbookAccordion` dispatches a `TrameCommand.UpdateActorSheet` command decrementing the corresponding spell level slot by 1.

### 3.9 `InventoryContainerTree`
- **Description**: Renders nested containers and inventory items with quantities, weights, and container tare.
- **Required Bindings**:
  - `items`: Path resolving to an array of inventory items (`{ id, name, quantity, unitWeight, containerId, isContainer, weightMultiplier }`).
  - `currency`: Path resolving to currency denomination map (`{ cp: number; sp: number; ep: number; gp: number; pp: number }`).
- **Interactions**:
  - WHEN a user drags an item into another container, THEN `InventoryContainerTree` dispatches a `TrameCommand.UpdateActorSheet` command updating the item `containerId`.
  - WHEN a user clicks an item delete trigger, THEN `InventoryContainerTree` dispatches a `TrameCommand.UpdateActorSheet` command removing the item.

### 3.10 `FeatureTraitList`
- **Description**: Displays passive traits, racial abilities, and class features grouped by source category.
- **Required Bindings**:
  - `features`: Path resolving to an array of feature objects (`{ id, name, source, description }`).
- **Interactions**:
  - WHEN a user clicks a feature header, THEN `FeatureTraitList` toggles description expansion.

### 3.11 `ConditionBadgeStrip`
- **Description**: Displays active condition badges (e.g., Poisoned, Stunned, Blinded).
- **Required Bindings**:
  - `conditions`: Path resolving to an array of condition strings or objects (`{ id, name, icon }`).
- **Interactions**:
  - WHEN a user clicks the remove badge icon, THEN `ConditionBadgeStrip` dispatches a `TrameCommand.UpdateActorSheet` command removing that condition from the Actor.

### 3.12 `NotesMarkdownPane`
- **Description**: Displays Markdown biography and notes.
- **Required Bindings**:
  - `bio`: Path resolving to `string`.
  - `notes`: Path resolving to `string`.
- **Interactions**:
  - WHEN a user edits the notes text area, THEN `NotesMarkdownPane` dispatches a `TrameCommand.UpdateActorSheet` command saving the updated text.

---

## 4. Reactive Data Binding Engine

### 4.1 Binding Path Resolution Algorithm
1. Let `path` be a dot-separated `DataBindingPath` (e.g., `sheet.attributes.hp.current` or `derived.spellSaveDc`).
2. `BindingResolver` splits `path` by `.`.
3. `BindingResolver` traverses the combined state object `{ sheet: actorSheet, derived: derivedStats }`.
4. IF the path evaluates to `undefined` OR an intermediate key is missing, THEN `BindingResolver` returns `null`.
5. `BindingResolver` throws zero runtime exceptions on missing intermediate keys.

### 4.2 Immutability and State Subscription
`DeclarativeSheetRenderer` treats Actor state as immutable. Changes in Actor state produce new object references. `DeclarativeSheetRenderer` re-evaluates bound widget properties only when the resolved value changes by reference or value equality.

---

## 5. Interactive Compendium & Container Drag-and-Drop

### 5.1 Drag-and-Drop Protocol
`CompendiumDragDropManager` standardizes data transfer payloads for HTML5 drag-and-drop:

```typescript
export interface CompendiumDragPayload {
  type: 'item' | 'spell' | 'feat';
  systemId: string;
  entryRef: string;
  data: Record<string, unknown>;
}

export interface InventoryMoveDragPayload {
  type: 'inventory_move';
  itemId: string;
  sourceContainerId: string | null;
}
```

### 5.2 Hierarchy Validation & Cycle Prevention
When moving an inventory item or dropping a compendium item into a container:
1. Let `sourceItemId` be the identifier of the item being moved.
2. Let `targetContainerId` be the identifier of the target container (`null` represents the top-level inventory).
3. IF `sourceItemId === targetContainerId`, THEN `CompendiumDragDropManager` rejects the drop and returns `false`.
4. IF `targetContainerId` is a descendant of `sourceItemId` within the container tree, THEN `CompendiumDragDropManager` rejects the drop and returns `false`.
5. IF the validation succeeds, THEN `CompendiumDragDropManager` returns `true` and dispatches `TrameCommand.UpdateActorSheet` with the updated `containerId`.

### 5.3 Container Weight Calculation
`ContainerWeightCalculator` evaluates total container weight deterministically without floating point drift:

```typescript
export function calculateContainerWeight(
  containerId: string | null,
  items: InventoryItemNode[]
): number {
  const directChildren = items.filter(item => item.containerId === containerId);
  let total = 0;
  for (const child of directChildren) {
    const unitWeight = child.unitWeight ?? 0;
    const quantity = child.quantity ?? 1;
    const ownWeight = unitWeight * quantity;
    if (child.isContainer) {
      const childContentWeight = calculateContainerWeight(child.id, items);
      const multiplier = child.weightMultiplier ?? 1.0;
      total += ownWeight + (childContentWeight * multiplier);
    } else {
      total += ownWeight;
    }
  }
  return Math.round(total * 100) / 100;
}
```

- WHEN a container has `weightMultiplier: 0.0` (such as a *Bag of Holding*), THEN the content weight added to the outer container equals `0`.
- The client computes container weights for visual display only. The central `trame-engine` computes authoritative encumbrance.

### 5.4 Compendium Drop Handling
- WHEN a user drops a `CompendiumDragPayload` onto the character sheet, THEN `CompendiumDragDropManager` validates that `payload.systemId` matches the Actor `systemId`.
- IF `payload.systemId` does not match, THEN `CompendiumDragDropManager` rejects the drop and displays a system mismatch warning.
- IF valid, THEN `CompendiumDragDropManager` dispatches a `TrameCommand.DropCompendiumEntry` payload containing `{ actorId, entryRef, targetContainerId }`.
- `trame-engine` processes the command, creates the item or feature on the Actor, attaches declared `ActiveEffect` entities, and recomputes derived statistics.

---

## 6. Dual Character Creation Pipeline

### 6.1 Pipeline Architecture: Wizard vs Freeform
The character creation module supports two explicit workflows:
1. **`CharacterBuilderWizard`**: A 5-step guided wizard for players.
2. **Freeform Mode**: Immediate, unrestricted editing of all sheet fields for GM fast NPC creation.

### 6.2 `CharacterBuilderWizard` State Machine
The wizard transitions sequentially through 5 distinct steps:
`ancestry` -> `class` -> `abilityScores` -> `equipment` -> `review`.

```typescript
export type BuilderStep = 'ancestry' | 'class' | 'abilityScores' | 'equipment' | 'review';

export interface BuilderDraftState {
  actorId: string;
  currentStep: BuilderStep;
  ancestryId: string | null;
  classId: string | null;
  abilityGenerationMethod: 'standardArray' | 'pointBuy';
  abilityScores: Record<string, number>;
  pointBuyRemaining: number;
  selectedEquipmentIds: string[];
}
```

#### 6.2.1 Step 1: Ancestry
- The user selects an Ancestry from the compendium.
- IF `ancestryId` is `null`, THEN the wizard disables progression to the next step.

#### 6.2.2 Step 2: Class
- The user selects a primary Class from the compendium.
- IF `classId` is `null`, THEN the wizard disables progression to the next step.

#### 6.2.3 Step 3: Ability Scores
The wizard reads rules from `GameSystemPack.characterCreation.abilityGeneration` with fallback defaults for D&D 5e:
- **Standard Array**: The user assigns scores from `[15, 14, 13, 12, 10, 8]` without duplication.
- **Point Buy Budget**: The user allocates 27 total points.
- **Point Buy Cost Table**:
  - Score 8: 0 points
  - Score 9: 1 point
  - Score 10: 2 points
  - Score 11: 3 points
  - Score 12: 4 points
  - Score 13: 5 points
  - Score 14: 7 points
  - Score 15: 9 points
- IF the allocated points exceed 27 points, THEN the wizard disables progression to the next step.

#### 6.2.4 Step 4: Equipment Selection
- The user selects starting equipment packages defined by the chosen Class and Ancestry.

#### 6.2.5 Step 5: Review & Final Dispatch
- The wizard displays a consolidated summary of choices.
- WHEN the user clicks 'Create Character', THEN `CharacterBuilderWizard` dispatches exactly one `TrameCommand.CreateActor` payload containing the finalized character configuration.
- WHEN the dispatch succeeds, THEN `CharacterBuilderWizard` resets the draft store to `null`.

### 6.3 `BuilderDraftStore` Local Draft Store
- `BuilderDraftStore` maintains wizard state exclusively in local memory.
- The wizard dispatches zero WebSocket messages and writes zero CRDT operations during steps 1 through 4.
- WHEN the user clicks 'Cancel', THEN `BuilderDraftStore` resets the active draft to `null` and dispatches zero commands.

### 6.4 Freeform Mode
In Freeform Mode, `CharacterBuilderWizard` is bypassed. The client directly renders `DeclarativeSheetRenderer` with an empty actor template, allowing immediate entry of attributes and inventory.

---

## 7. Integration with `@trame/dnd5e-game-system`

### 7.1 Schema Consumption
`packages/web` imports layout definitions from `@trame/dnd5e-game-system`:

```typescript
import { DND5E_SHEET_LAYOUT } from '@trame/dnd5e-game-system';
```

No D&D 5e class names, attribute keys, or proficiency multipliers are hardcoded in `packages/web`. All widget configurations are driven by `DND5E_SHEET_LAYOUT`.

---

## 8. Verification & TDD Test Harness

### 8.1 Execution Harness
All test suites run natively under Node 24 via `node --test`:
```bash
node --test packages/web/tests/**/*.test.ts
```

### 8.2 Test Suites (ASD-STE100 Compliant)

#### Suite 1: Declarative Sheet Layout & AST Resolution (`packages/web/tests/sheet/DeclarativeSheetRenderer.test.ts`)
- Test 1: Parses a valid `SheetLayoutTree` fixture and asserts that the returned AST contains all declared nodes.
- Test 2: Throws a `DuplicateNodeIdError` when `SheetLayoutTree` contains identical IDs across distinct nodes.
- Test 3: Filters out nodes where `visibilityTier === 'GM_ONLY'` when evaluated with player permissions.
- Test 4: Resolves dot-separated data bindings to matching values and returns `null` when keys do not exist.
- Test 5: Dispatches a `RollDice` command when a user triggers an ability score card click.

#### Suite 2: Character Builder State Machine (`packages/web/tests/builder/CharacterBuilderWizard.test.ts`)
- Test 1: Initializes draft with `ancestry` step and rejects step increment until `ancestryId` is non-null.
- Test 2: Rejects step progression when total point buy cost exceeds 27 points.
- Test 3: Transitions across all steps without dispatching WebSocket messages.
- Test 4: Dispatches exactly one `TrameCommand.CreateActor` payload upon submission of the `review` step.
- Test 5: Resets `builderDraftStore.getDraft()` to `null` when a user cancels the wizard.

#### Suite 3: Interactive Compendium & Inventory Drag-and-Drop (`packages/web/tests/dnd/CompendiumDragDropManager.test.ts`)
- Test 1: Computes total container weight as `tareWeight + sum(child.unitWeight * child.quantity)`.
- Test 2: Computes child weight as `0` when parent container has `weightMultiplier: 0.0`.
- Test 3: Returns `false` and rejects drop when `sourceItem.id === targetContainerId`.
- Test 4: Returns `false` and rejects drop when `targetContainerId` is a descendant of `sourceItem.id`.
- Test 5: Dispatches `TrameCommand.DropCompendiumEntry` when a compendium spell payload drops onto the sheet.

#### Suite 4: Canonical Atomic Widgets Contract (`packages/web/tests/sheet/widgets.test.ts`)
- Test 1: `StatBlock6` dispatches `RollDice` for `1d20 + modifier` on click.
- Test 2: `ResourceBar` dispatches `UpdateActorSheet` on value change.
- Test 3: `SavingThrowList` dispatches `RollDice` for `1d20 + saveModifier` on click.
- Test 4: `SkillCheckList` dispatches `RollDice` for `1d20 + skillModifier` on click.
- Test 5: `ArmorInitiativeSpeed` dispatches `RollDice` for `1d20 + initiativeModifier` on click.
- Test 6: `HitDiceAndDeathSaves` dispatches `RollDice` for `1d{hitDieSides} + {conModifier}` and decrements `hitDiceCurrent` by 1.
- Test 7: `HitDiceAndDeathSaves` evaluates death save roll results and dispatches correct counters.
- Test 8: `AttackActionTable` dispatches `RollDice` for attack roll and damage formula.
- Test 9: `SpellbookAccordion` dispatches `RollDice` (or `ProjectAoE` for area spells) and decrements spell slot by 1 when `options.autoDeductSlots` is `true`.
- Test 10: `InventoryContainerTree` dispatches `UpdateActorSheet` when item container changes.
- Test 11: `ConditionBadgeStrip` dispatches `UpdateActorSheet` to remove condition.
- Test 12: `NotesMarkdownPane` dispatches `UpdateActorSheet` when notes text is modified.

---

## 9. Security, Invariants & Anti-Patterns

### 9.1 Input Sanitization
- `NotesMarkdownPane` must sanitize Markdown HTML rendering to prevent cross-site scripting (XSS).
- Node IDs in `SheetLayoutTree` must match the regex `^[a-zA-Z0-9_-]+$`.

### 9.2 Invariants
1. **Zero System Hardcoding**: No game-specific logic or formulas may exist in `packages/web/src/sheet` or `packages/web/src/builder`.
2. **Acyclic Containers**: An inventory container cannot contain itself or any of its ancestors.
3. **Atomic Wizard Persistence**: Partial character builder state must never be shared across the network.
4. **Authoritative Engine Pipeline**: The web client never evaluates the 5-phase `ActiveEffect` pipeline; all derived Actor state originates from `trame-engine`.

### 9.3 Prohibited Anti-Patterns
- Do not import `@testing-library/react` or `jsdom`.
- Do not dispatch `TrameCommand.CreateActor` before step 5 of the wizard.
- Do not duplicate `ActiveEffect` IDs on client-side inventory items.
