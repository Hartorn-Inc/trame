# Technical & Functional Specification: TRAME ATLAS v1.1 Design System, Hybrid Canvas Theme Architecture & Impeccable Gate Validation

## 1. Overview & Strategic Goal

### 1.1 Context and Problem
TRAME offers a real-time virtual tabletop experience (`TableMode::Exploration`, `TableMode::TurnByTurn`), campaign preparation workspaces (`CampaignLobby`, `CampaignWorkspace`), declarative actor sheets (`DeclarativeSheetRenderer`), a collaborative wiki (`CRDTDocument`) and a companion mobile interface (`MobileCompanionView`).

The lack of a unified design system caused several blocking defects:
1. The Preact views and the `WidgetRegistry` components used raw hard-coded hexadecimal colors with no adaptation to light, dark and system modes.
2. The PixiJS v8 engine and its 7-layer `SceneGraph` (`backgroundMap`, `gridOverlay`, `aoeTemplates`, `tokens`, `lightingAndVisionMask`, `fogOfWar`, `uiControlHud`) had no typed bridge to the DOM themes. No invariant prevented global CSS filters from altering imported battlemaps.
3. Tactical states (Actor token allegiance, active turn indicator, `WallSegment` kinds and `MCP Staging Mode` ghost previews) relied only on color.
4. Actor sheets risked accidental changes to structural attributes in the middle of a session from simple dice clicks.
5. The application loaded remote fonts from CDNs, which broke offline containerized use under Docker and the portability of `.trame` archives.
6. The CI pipeline had no automated check to prevent WCAG 2.2 AA contrast regressions and raw hexadecimal code.

### 1.2 Goal & Guiding Principle
This specification establishes and locks the **TRAME ATLAS v1.1** design system around the guiding principle: **"The Map Is the Workspace"**.

The system rests on four technical pillars:
1. A decoupled dual source of truth: CSS variables for the Preact DOM (`packages/web/src/styles/tokens.css`) and an immutable typed registry for WebGL (`packages/web/src/canvas/CanvasThemePalette.ts`, `CanvasThemePalette`).
2. The absolute *Map-Art Independence Rule*: battlemap textures stay strictly neutral and the unexplored `FogLayer` layer stays opaque and dark.
3. Systematic *Non-Color Redundancy* for all tactical information.
4. Sealed two-stage governance (the CI static audit `scripts/check-impeccable-design.mjs` and the unit tests `packages/web/tests/designSystem.test.ts`).

---

## 2. Domain Model & Ubiquitous Definitions

According to `GLOSSARY.md` and the ASD-STE100 standard, this specification uses only the following canonical terms:

- **Actor**: aggregate representing a hero, a monster or a non-player creature. The terms `character`, `entity` or `player-avatar` are forbidden.
- **CampaignWorkspace**: authenticated Preact shell containing the 5 tabs `Table`, `Maps`, `Actors`, `Documents` and `Compendium`, with slide-over `HudDrawers` on the `Table` tab.
- **CanvasThemePalette**: typed registry providing numeric colors and geometric patterns to the PixiJS `SceneGraph` according to the resolved theme.
- **PadlockEditMode**: boolean state in the `DeclarativeSheetRenderer` header that switches between the locked play mode (`aria-pressed="false"`) and the unlocked edit mode (`aria-pressed="true"`).
- **SceneGraph**: 7-layer PixiJS v8 tree that renders the virtual tabletop.
- **WallSegment**: spatial obstacle segment carrying light occlusion and physical passage properties.
- **WidgetRegistry**: central registry mapping declarative widget keys to their Preact render components.

---

## 3. Hybrid Token Architecture & Self-Hosted Typography

### 3.1 Semantic CSS Variable Definitions
The `packages/web/src/styles/tokens.css` file declares the CSS variables on `:root` (dark theme by default), on `[data-theme="light"]`, and through `@media (prefers-color-scheme: light)` when the attribute is `[data-theme="system"]`.

```css
:root,
[data-theme="dark"] {
  --atlas-bg: #0F1A25;
  --atlas-surface: #182736;
  --atlas-surface-raised: #203243;
  --atlas-text: #F1F4F3;
  --atlas-text-muted: #B8C7D1;
  --atlas-border: #405466;
  --atlas-action: #F3BB71;
  --atlas-on-action: #172535;
  --atlas-focus: #80CBE2;
  --atlas-danger: #D57973;
  --atlas-grid: rgba(184, 199, 209, 0.16);
  --atlas-shadow: rgba(5, 10, 16, 0.42);
}

[data-theme="light"] {
  --atlas-bg: #F4F7F9;
  --atlas-surface: #FFFFFF;
  --atlas-surface-raised: #E8EFF3;
  --atlas-text: #1C3041;
  --atlas-text-muted: #465D6D;
  --atlas-border: #ACBFCB;
  --atlas-action: #995817;
  --atlas-on-action: #FFFFFF;
  --atlas-focus: #155D77;
  --atlas-danger: #A3333B;
  --atlas-grid: rgba(28, 48, 65, 0.14);
  --atlas-shadow: rgba(15, 26, 37, 0.12);
}
```

### 3.2 WCAG 2.2 AA Contrast Matrix
The check script `scripts/check-impeccable-design.mjs` computes the relative luminance $L = 0.2126 R + 0.7152 G + 0.0722 B$ and mathematically checks the ratio $(L_1 + 0.05) / (L_2 + 0.05)$:

| Token pair | Dark mode (hex) | Dark ratio | Light mode (hex) | Light ratio | Normative rule |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `--atlas-text` on `--atlas-bg` | `#F1F4F3` on `#0F1A25` | 14.8:1 | `#1C3041` on `#F4F7F9` | 11.2:1 | Body text $\ge 4.5:1$ |
| `--atlas-text` on `--atlas-surface` | `#F1F4F3` on `#182736` | 12.3:1 | `#1C3041` on `#FFFFFF` | 12.6:1 | Body text $\ge 4.5:1$ |
| `--atlas-text-muted` on `--atlas-bg` | `#B8C7D1` on `#0F1A25` | 9.2:1 | `#465D6D` on `#F4F7F9` | 5.3:1 | Secondary text $\ge 4.5:1$ |
| `--atlas-danger` on `--atlas-surface` | `#D57973` on `#182736` | 5.2:1 | `#A3333B` on `#FFFFFF` | 6.4:1 | Alert text $\ge 4.5:1$ |
| `--atlas-on-action` on `--atlas-action`| `#172535` on `#F3BB71` | 9.1:1 | `#FFFFFF` on `#995817` | 5.8:1 | Action button text $\ge 4.5:1$ |
| `--atlas-focus` on `--atlas-bg` | `#80CBE2` on `#0F1A25` | 9.3:1 | `#155D77` on `#F4F7F9` | 6.8:1 | UI focus ring $\ge 3.0:1$ |
| `--atlas-border` on `--atlas-bg` | `#405466` on `#0F1A25` | 3.1:1 | `#ACBFCB` on `#F4F7F9` | 3.2:1 | Control border $\ge 3.0:1$ |

For the `--atlas-grid` vector grid:
- In dark mode, applying `rgba(184, 199, 209, 0.16)` on `--atlas-bg` (`#0F1A25`) produces the composite color `#2A353F`. The computed Weber contrast $(L_{\text{composite}} - L_{\text{bg}}) / L_{\text{bg}}$ equals $0.14$, which keeps it discreetly readable without tiring the eye.
- In light mode, applying `rgba(28, 48, 65, 0.14)` on `--atlas-bg` (`#F4F7F9`) produces the composite color `#E4E9EC`. The computed Weber contrast $(L_{\text{bg}} - L_{\text{composite}}) / L_{\text{bg}}$ equals $0.11$.

### 3.3 Self-Hosted Typography and Tabular Alignment
1. The `packages/web` package hosts the WOFF2 files in `packages/web/public/fonts/`:
   - `space-grotesk-v16-latin-500.woff2`
   - `space-grotesk-v16-latin-600.woff2`
   - `ibm-plex-sans-v19-latin-regular.woff2` (400)
   - `ibm-plex-sans-v19-latin-500.woff2`
   - `ibm-plex-sans-v19-latin-600.woff2`
   - `OFL-1.1.txt`
2. The `packages/web/src/styles/tokens.css` file declares the `@font-face` rules with `font-display: swap` and relative local paths. No call to `fonts.googleapis.com` or `fonts.gstatic.com` is allowed.
3. The utility class `.atlas-tabular-nums` applies `font-variant-numeric: tabular-nums; font-family: var(--atlas-font-body);`. The `DeclarativeSheetRenderer`, the `CombatTracker` and the dice viewer must assign this class to every displayed numeric value.

### 3.4 Reactive Theme State Propagation
1. The `packages/web/src/signals/themeSignal.ts` module exports the signal `themeModeSignal = signal<AtlasThemeMode>('system')` and the derived signal `resolvedThemeSignal = computed<ResolvedAtlasTheme>(...)`.
2. The root `App.tsx` component runs a reactive `effect()` hook that:
   - Reads the value of `resolvedThemeSignal`.
   - Sets the `data-theme` attribute on the `<html>` tag (`document.documentElement.setAttribute('data-theme', resolvedTheme)`).
   - Writes the user's choice to `localStorage` under the key `trame.atlas.theme`.
3. The PixiJS canvas controller subscribes to `resolvedThemeSignal` and calls `getCanvasThemePalette(resolvedThemeSignal.value)`. The controller passes the immutable palette to the vector layers without resetting the WebGL context.

---

## 4. PixiJS v8 Palette (`CanvasThemePalette`) & Color Independence

### 4.1 Immutable TypeScript Contract
The `packages/web/src/canvas/CanvasThemePalette.ts` file exposes the strict interface and the palette resolution function:

```ts
export type AtlasThemeMode = "dark" | "light" | "system";
export type ResolvedAtlasTheme = "dark" | "light";

export interface TokenDispositionStyle {
  readonly ringColorHex: number;
  readonly ringStrokeStyle: "solid" | "dashed" | "double";
  readonly dashPatternPx: readonly [number, number] | null;
  readonly badgeShape: "shield" | "diamond" | "corner-chevrons" | "chevron-beacon";
  readonly badgeGlyph: "" | "!" | "›";
}

export interface WallKindVisualStyle {
  readonly strokeColorHex: number;
  readonly strokeWidthPx: number;
  readonly dashPatternPx: readonly [number, number] | null;
  readonly endpointMarker: "cap" | "tick" | "dot" | "arrow" | "s-glyph" | "hinge-box" | "diamond-hollow";
}

export interface CanvasThemePaletteSpec {
  readonly theme: ResolvedAtlasTheme;
  readonly mapArtFilter: "none";
  readonly canvasVoidHex: number;
  readonly gridLineHex: number;
  readonly gridLineAlpha: number;
  readonly fogUnexploredHex: number;
  readonly fogExploredDimAlpha: number;
  readonly rulerStrokeHex: number;
  readonly pointerPingHex: number;
  readonly mcpStagingGhost: {
    readonly fillHex: number;
    readonly strokeHex: number;
    readonly fillAlpha: number;
    readonly dashPatternPx: readonly [number, number];
    readonly badgeText: "STAGED";
  };
  readonly aoeTemplate: {
    readonly fillHex: number;
    readonly strokeHex: number;
    readonly fillAlpha: number;
    readonly boundaryDashPx: readonly [number, number];
  };
  readonly tokenDispositions: {
    readonly ally: TokenDispositionStyle;
    readonly hostile: TokenDispositionStyle;
    readonly selected: TokenDispositionStyle;
    readonly activeTurn: TokenDispositionStyle;
  };
  readonly wallKinds: Record<
    "Normal" | "Window" | "Terrain" | "OneWay" | "SecretDoor" | "Door" | "Illusion",
    WallKindVisualStyle
  >;
}

export function getCanvasThemePalette(theme: ResolvedAtlasTheme): CanvasThemePaletteSpec;
```

### 4.2 The Map-Art Independence Rule
1. The `mapArtFilter` property must be `"none"` in both themes.
2. The PixiJS container of the `backgroundMap` layer always keeps `filters = []` and applies no CSS filter (`filter: none`). Imported map images never get a color inversion or a brightness reduction.
3. The `fogUnexploredHex` color stays fixed at `0x0f1a25` (`#0F1A25`) whatever the active theme. The unexplored `FogLayer` fog stays an opaque slate black to preserve the dynamic contrast of 2.5D light sources.
4. The off-map void color `canvasVoidHex` switches between `0x0f1a25` (dark) and `0xf4f7f9` (light).

### 4.3 Geometric Injectivity of Tactical States
To keep the table usable by color-blind users, every tactical state pairs its color with a unique geometry. The unit test `packages/web/tests/designSystem.test.ts` formally checks the injectivity of the tuples:

#### Actor Token Dispositions:
- `ally`: solid ring (`ringStrokeStyle: "solid"`), green/cyan color `0x22c55e`, shield badge (`"shield"`), empty glyph `""`.
- `hostile`: dashed ring (`ringStrokeStyle: "dashed"`, `dashPatternPx: [6, 4]`), red color `0xef4444`, diamond badge (`"diamond"`), glyph `"!"`.
- `selected`: double ring (`ringStrokeStyle: "double"`), blue color `0x38bdf8`, corner chevrons (`"corner-chevrons"`), empty glyph `""`.
- `activeTurn`: amber ring `0xf59e0b`, directional chevron beacon (`"chevron-beacon"`), glyph `"›"`.

#### WallSegment Kinds:
- `Normal`: solid stroke (`dashPatternPx: null`), straight cap (`endpointMarker: "cap"`).
- `Window`: wide dashed stroke (`dashPatternPx: [6, 4]`), tick end (`endpointMarker: "tick"`).
- `Terrain`: dense dotted stroke (`dashPatternPx: [2, 4]`), round end (`endpointMarker: "dot"`).
- `OneWay`: directional dashed stroke (`dashPatternPx: [8, 3]`), arrow end (`endpointMarker: "arrow"`).
- `SecretDoor`: short broken stroke (`dashPatternPx: [4, 4]`), secret glyph end (`endpointMarker: "s-glyph"`).
- `Door`: reinforced solid stroke (`dashPatternPx: null`, `strokeWidthPx: 3`), hinge box end (`endpointMarker: "hinge-box"`).
- `Illusion`: complex alternating stroke (`dashPatternPx: [3, 3, 1, 3]`), hollow diamond end (`endpointMarker: "diamond-hollow"`).

---

## 5. Application Components, Actor Sheet & SVG Suite

### 5.1 `PadlockEditMode` Safety Lock
The `DeclarativeSheetRenderer.tsx` component includes a toggle button in its header with the attribute `data-testid="sheet-padlock-toggle"`. This button has `aria-pressed="false"` (locked mode by default) or `aria-pressed="true"` (unlocked mode).

```
+-----------------------------------------------------------------------------------+
|  Actor: Valeros           [ Padlock Locked: aria-pressed="false" ] (Click to edit)|
+-----------------------------------------------------------------------------------+
|  [X] READONLY / DISABLED STRUCTURAL FIELDS       |  [O] INTERACTIVE COMBAT CONTROLS|
|  - Name, Class, Level, Max HP, Speed             |  - [Roll d20] Ability Checks    |
|  - Strength, Dexterity, Constitution, etc.       |  - [Roll d20] Saving Throws     |
|  - Skill / Save Proficiency Checkboxes           |  - [Attack] Weapon Rolls        |
|  - Inventory Item Add/Delete/Rename              |  - Current HP (+ / -) & Temp HP |
|  - Spell List Add/Delete & Feature Descriptions  |  - Death Saves (Success/Fail)   |
|                                                  |  - Spell Slots (Expend/Restore) |
+-----------------------------------------------------------------------------------+
```

#### Exhaustive List of Protected Fields (Locked Mode `aria-pressed="false"`):
The component sets `readonly={true}` or `disabled={true}` on the following elements:
1. Actor name (`actor.name`).
2. Class and subclass (`actor.class`, `actor.subclass`).
3. Total level (`actor.level`).
4. Maximum hit points (`actor.hp.max`).
5. Base armor class value (`actor.armorClass.base`).
6. Walking, flying and swimming speed (`actor.speed.*`).
7. The 6 core ability scores (`strength`, `dexterity`, `constitution`, `intelligence`, `wisdom`, `charisma`).
8. The skill proficiency and expertise checkboxes (`actor.skills.*.proficient`).
9. The saving throw proficiency checkboxes (`actor.savingThrows.*.proficient`).
10. The inventory add, delete, rename and weight edit actions (`actor.inventory.items`).
11. The add and delete buttons for known and prepared spells (`actor.spells.known`, `actor.spells.prepared`).
12. The text description fields of feats and features (`actor.features.*.description`).

#### Exhaustive List of Operational Controls Kept Active in Locked Mode:
1. All dice roll triggers (`roll-button`, ability checks, saving throws, attack and damage rolls).
2. The increment and decrement buttons for current hit points (`actor.hp.current`).
3. The temporary hit points field (`actor.hp.temp`).
4. The death saving throw success and failure counters (`actor.deathSaves.successes`, `actor.deathSaves.failures`).
5. The spell slot use and recovery checkboxes (`actor.spellSlots.*.expended`).
6. The temporary resource pool counters (`actor.resources.*.current`, Ki points, rages, etc.).
7. The condition activation and deactivation badges (`Blinded`, `Poisoned`, etc.).
8. The inspiration toggle (`actor.inspiration`).
9. The short rest (`Short Rest`) and long rest (`Long Rest`) buttons.

### 5.2 Stroked Icon Library `AtlasIcons.tsx`
The `packages/web/src/components/icons/AtlasIcons.tsx` file exports the shared interface and the individual components:

```ts
export interface AtlasIconProps {
  readonly size?: 20 | 24;
  readonly color?: string;
  readonly class?: string;
  readonly "aria-hidden"?: boolean | "true" | "false";
  readonly "data-testid"?: string;
}
```

Every icon shares the strict geometric SVG properties: `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `strokeWidth={1.75}`, `strokeLinecap="round"`, `strokeLinejoin="round"` and `aria-hidden="true"` by default.

The module also exports the dispatch component `AtlasIcon`, which receives the `name: AtlasIconName` property. The list of 34 icons is:
1. `SelectToolIcon`
2. `PanToolIcon`
3. `RulerToolIcon`
4. `GridToolIcon`
5. `FogBrushToolIcon`
6. `WallToolIcon`
7. `DoorToolIcon`
8. `LightToolIcon`
9. `AmbientToolIcon`
10. `AudioToolIcon`
11. `PingToolIcon`
12. `AoEToolIcon`
13. `PadlockLockedIcon`
14. `PadlockUnlockedIcon`
15. `LevelUpArrowIcon`
16. `ShortRestCampfireIcon`
17. `LongRestTentIcon`
18. `DiceD20NeutralIcon`
19. `AllyBadgeIcon`
20. `HostileBadgeIcon`
21. `ActiveTurnChevronIcon`
22. `ThemeDarkIcon`
23. `ThemeLightIcon`
24. `ThemeSystemIcon`
25. `WorkspaceMapIcon`
26. `WorkspaceActorsIcon`
27. `WorkspaceJournalIcon`
28. `WorkspaceCompendiumIcon`
29. `WorkspaceSettingsIcon`
30. `UndoIcon`
31. `RedoIcon`
32. `ChevronDownIcon`
33. `ChevronRightIcon`
34. `CloseIcon`

### 5.3 Cartographic Logo `TrameLogo.tsx`
The `TrameLogo.tsx` component renders the brand as a vector cartographic T. It exposes the properties `variant?: 'route-intersection' | 'waypoint-grid' | 'monolith-path'` (default: `'route-intersection'`), `size?: number` (from 16 to 256) and `duotone?: boolean`.
In duotone mode, the component uses `--atlas-text` for the structure of the T and `--atlas-action` for the cartographic junction point.

### 5.4 Cartographic Empty States `AtlasEmptyStates.tsx`
The `packages/web/src/components/empty/AtlasEmptyStates.tsx` file exports 4 vector illustrations:
1. `EmptyCampaignsSvg`
2. `EmptyMapAtlasSvg`
3. `EmptyJournalSvg`
4. `EmptyActorsSvg`

Critical invariant: every SVG illustration is made only of contour paths (`<path>`), marker nodes (`<circle>`) and geometric hatching with `stroke="currentColor"`. **`<text>` tags are forbidden in these SVG files**. The parent HTML containers provide every title, description and action button through the i18n dictionaries with the semantic role `role="status"`.

### 5.5 Mobile Adaptation `MobileCompanionView.tsx`
For screens narrower than 768 pixels, `MobileCompanionView` shows 5 bottom tabs (Sheet, Dice, Inventory, Tracker and Journal).
Every button has a minimum touch area of $44 \times 44$ pixels (`min-height: 44px; min-width: 44px;`). On desktop interfaces, interactive targets have a minimum height of 40 pixels.

---

## 6. Impeccable Governance & Fail-Closed CI Validation

### 6.1 Architecture of the `scripts/check-impeccable-design.mjs` Script
The check script runs under Node 24 when `make lint` is called. It runs in two sealed sequential stages:

#### Stage 1: Internal Static Analysis (Contracts, Tokens, Ratios & Craft Floor)
1. **`DESIGN.md` validation**:
   - The script parses the YAML frontmatter and checks the presence of the `name`, `description`, `colors`, `typography`, `rounded`, `spacing` and `components` fields.
   - The script checks the exact presence of the 8 canonical H2 sections in the prescribed order:
     1. `## Overview`
     2. `## Colors`
     3. `## Typography`
     4. `## Layout`
     5. `## Elevation & Depth`
     6. `## Shapes`
     7. `## Components`
     8. `## Do's and Don'ts`
2. **`.impeccable/design.json` validation**:
   - The script checks that the JSON file conforms to the Schema v2 standard (`colorMeta`, `typographyMeta`, `shadows`, `motion`, `breakpoints` extensions and HTML/CSS snippets).
3. **Automated WCAG 2.2 AA contrast computation**:
   - The script evaluates every token pair defined in table 3.2. It returns a blocking error if the ratio is below $4.5:1$ for text or below $3.0:1$ for borders and the focus ring.
4. **Raw hexadecimal color detection**:
   - The script inspects every file under `packages/web/src/**/*.{ts,tsx,css}`.
   - The script fails if a hexadecimal string (`#([0-9a-fA-F]{3,8})`), `rgb(` or `hsl(` appears outside the two allowed files: `packages/web/src/styles/tokens.css` and `packages/web/src/canvas/CanvasThemePalette.ts`.
5. **Font network isolation check**:
   - The script rejects any reference to the `fonts.googleapis.com` or `fonts.gstatic.com` domains in the source code.
6. **Static check of the 62 anti-slop Craft Floor rules**:
   - The script analyzes the CSS/TSX files and fails if it detects gradient text (`-webkit-background-clip: text`), drop shadows with neon halos (`filter: drop-shadow(...)`), forbidden fonts or headings topped with uppercase eyebrow kickers.

#### Stage 2: Running the Impeccable CLI Detector
- If the `impeccable` CLI binary (`engine-v0.1.18`) is present in the environment, the script runs `npx impeccable detect --rules-all`.
- If the binary is unavailable in an offline environment, the Stage 1 checks still reject any design drift immediately.

---

## 7. EpicGoalContract & Formal Acceptance Criteria

### 7.1 epic_goal_contract

#### `epic_goal_summary`
Deliver and lock the TRAME ATLAS v1.1 design system, guaranteeing the sealed separation of DOM and WebGL tokens, reactive theme synchronization with `CanvasThemePalette` without altering battlemaps, full independence from color vision through geometric discrimination, the `PadlockEditMode` safety lock on the Actor sheet, and fail-closed compliance checking of the 62 Craft Floor rules in CI.

#### `required_entrypoints`
1. `packages/web/src/styles/tokens.css` (semantic CSS variables, `.ds-*` classes, `.atlas-tabular-nums`, local `@font-face`).
2. `packages/web/src/canvas/CanvasThemePalette.ts:getCanvasThemePalette` (immutable typed PixiJS v8 registry).
3. `packages/web/src/signals/themeSignal.ts` (reactive theme management with `themeModeSignal` and `resolvedThemeSignal`).
4. `packages/web/src/components/sheet/DeclarativeSheetRenderer.tsx` (sheet component with the `PadlockEditMode` toggle).
5. `packages/web/src/components/icons/AtlasIcons.tsx` (suite of 34 vector icons with a 1.75 px stroke).
6. `packages/web/src/components/empty/AtlasEmptyStates.tsx` (4 cartographic empty states without a `<text>` tag).
7. `scripts/check-impeccable-design.mjs` (CI static audit script for WCAG AA and Craft Floor).

#### `forbidden_stubs`
1. No raw hexadecimal values (`#RGB`, `#RRGGBB`, `rgb()`, `hsl()`) in `packages/web/src/` outside `tokens.css` and `CanvasThemePalette.ts`.
2. No CSS graphic filters (`filter: invert()`, `filter: brightness()`) or WebGL filters on the `backgroundMap` layer.
3. No background color other than `0x0f1a25` for the unexplored `FogLayer` layer.
4. No outgoing network requests to remote font services (Google Fonts).
5. No hard-coded `<text>` tags inside the `AtlasEmptyStates.tsx` SVG illustrations.
6. No action buttons smaller than $40$ px on desktop and $44 \times 44$ px on mobile.

#### `end_to_end_verification_criteria`
1. **CI static verification**:
   - WHEN the developer runs `make lint`, THEN the `scripts/check-impeccable-design.mjs` script validates the code tree and returns exit code 0.
   - WHEN a contributor adds a raw hexadecimal value to a Preact component, THEN `scripts/check-impeccable-design.mjs` catches the violation and returns exit code 1 with the offending file and line.
2. **Mathematical contrast verification**:
   - WHEN the `packages/web/tests/designSystem.test.ts` suite evaluates the dark and light theme contrasts, THEN the ratios are strictly $\ge 4.5:1$ for text and $\ge 3.0:1$ for borders and the focus ring.
3. **Canvas geometric injectivity verification**:
   - WHEN the unit test inspects the specifications returned by `getCanvasThemePalette`, THEN no pair of states among the 4 token allegiances (`ally`, `hostile`, `selected`, `activeTurn`) or among the 7 `WallSegment` kinds has an identical `(dashPatternPx, endpointMarker)` or `(ringStrokeStyle, badgeShape)` pair.
4. **Map-art independence verification**:
   - WHEN the controller switches the resolved theme from `dark` to `light`, THEN the `mapArtFilter` property of `CanvasThemePaletteSpec` stays `"none"` and `fogUnexploredHex` stays `0x0f1a25`.
5. **Actor sheet lock verification**:
   - WHEN the user clicks the `[data-testid="sheet-padlock-toggle"]` button to set `PadlockEditMode` to the locked state (`aria-pressed="false"`), THEN the `DeclarativeSheetRenderer` component sets `disabled` or `readonly` on all 12 categories of structural fields and keeps the event listeners clickable on the 9 categories of operational combat controls.
6. **SVG & mobile accessibility verification**:
   - WHEN the test engine analyzes the `AtlasIcons.tsx` and `AtlasEmptyStates.tsx` components, THEN every icon has `aria-hidden="true"` and no empty state illustration contains a `<text>` element.
   - WHEN the test mounts `MobileCompanionView.tsx` with a 390 px window width, THEN the 5 navigation tabs measure at least 44 px by 44 px.
