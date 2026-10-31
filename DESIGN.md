---
name: "TRAME"
description: "System-agnostic virtual tabletop with a sober cartographic visual identity (ATLAS v1.1)"
colors:
  navy: "#0F1A25"
  slate: "#182736"
  raised: "#203243"
  parchment: "#F4F7F9"
  surface-light: "#FFFFFF"
  raised-light: "#E8EFF3"
  dark-text: "#F1F4F3"
  dark-text-muted: "#B8C7D1"
  light-text: "#1C3041"
  light-text-muted: "#465D6D"
  dark-border: "#405466"
  light-border: "#ACBFCB"
  amber: "#F3BB71"
  amber-deep: "#995817"
  on-amber-dark: "#172535"
  on-amber-light: "#FFFFFF"
  cyan-focus: "#80CBE2"
  cyan-focus-light: "#155D77"
  danger-dark: "#D57973"
  danger-light: "#A3333B"
typography:
  display:
    font: "Space Grotesk, sans-serif"
    size: "28px"
    weight: "600"
    lineHeight: "1.15"
    letterSpacing: "-0.02em"
  headline:
    font: "Space Grotesk, sans-serif"
    size: "20px"
    weight: "600"
    lineHeight: "1.2"
    letterSpacing: "-0.015em"
  body:
    font: "IBM Plex Sans, sans-serif"
    size: "16px"
    weight: "400"
    lineHeight: "1.5"
  label:
    font: "IBM Plex Sans, sans-serif"
    size: "14px"
    weight: "500"
    lineHeight: "1.45"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  - button-primary
  - button-secondary
  - input-field
  - panel-surface
---

# TRAME Design System (ATLAS v1.1)

## Overview

**Creative North Star — "The Map Is the Workspace"**: TRAME is a system-agnostic virtual tabletop where players and Game Masters spend 3-to-5-hour sessions reading maps, moving tokens, resolving combat turns, and consulting character sheets or campaign lore. Because every campaign brings its own map art—from high-contrast black-and-white OSR dungeons to vibrant hand-painted fantasy wilderness—the TRAME interface (`CampaignLobby`, `CampaignWorkspace`, `CombatTracker`, `GmOverrideToolbar`, `DeclarativeSheetRenderer`, and `MobileCompanionLayout`) acts as a calibrated cartographic instrument: quiet, structural, high-contrast, and visually receding behind the battlemap.

TRAME operates across three distinct Impeccable surface modes:
- **Operate (Primary — Live Tabletop, Tool Rail, CombatTracker, Character Sheets, MobileCompanionLayout)**: High-density, zero-distraction tactical execution (`>= 75%` unobstructed canvas on `1440x900` desktop viewports; maximum one dominant contextual drawer open at a time).
- **Read (Secondary — CampaignLobby, PartyJournal, CRDTDocument Wiki Notes, Compendium)**: Scannable, daylight-ready long-form reading (`60ch–72ch` measure) with clean hierarchy between public handouts (`:::handout`) and GM-only lore (`:::dm`).
- **Persuade (Documentation — README & Showcase Assets)**: Sober architectural and cartographic clarity without marketing hype or decorative fantasy chrome.

## Colors

TRAME ships a first-class dual-theme palette (`dark` default for dimly lit evening sessions, `light` for daytime preparation and bright rooms, and `system` tracking `prefers-color-scheme`). All DOM chrome consumes `--atlas-*` CSS custom properties from `packages/web/src/styles/tokens.css`, while the 7-layer PixiJS v8 `SceneGraph` consumes `packages/web/src/canvas/CanvasThemePalette.ts`.

| Semantic Token | Dark Mode (`[data-theme="dark"]`) | Light Mode (`[data-theme="light"]`) | Role & WCAG 2.2 AA Contrast Guarantee |
| :--- | :--- | :--- | :--- |
| `--atlas-bg` | `#0F1A25` (Deep Cartographic Navy) | `#F4F7F9` (Daylight Parchment) | Root workspace background and PixiJS empty canvas void (`mapArtFilter: "none"`). |
| `--atlas-surface` | `#182736` (Tactical Slate) | `#FFFFFF` (Paper Surface) | Primary panels, drawers, `CampaignLobby` cards, and `DeclarativeSheetRenderer`. |
| `--atlas-surface-raised` | `#203243` (Raised Slate) | `#E8EFF3` (Raised Mist) | Hover/active rows, table headers, input backgrounds, and sticky toolbars. |
| `--atlas-text` | `#F1F4F3` (Chalk Ink) | `#1C3041` (Deep Slate Ink) | Primary text (`>= 13.8:1` on dark surface, `>= 13.1:1` on light surface). |
| `--atlas-text-muted` | `#B8C7D1` (Muted Steel) | `#465D6D` (Muted Slate) | Secondary labels and metadata (`>= 7.5:1` on dark, `>= 6.1:1` on light; `>= 4.5:1` on raised surfaces). |
| `--atlas-border` | `#405466` (Structural Hairline) | `#ACBFCB` (Structural Rule) | `1px solid` structural dividers and control borders (`>= 3.0:1` UI contrast). |
| `--atlas-action` | `#F3BB71` (Signal Amber) | `#995817` (Deep Amber Ochre) | Primary CTAs, active tool indicator, active turn accent, and unlocked `PadlockEditMode`. |
| `--atlas-on-action` | `#172535` (Dark Slate Ink) | `#FFFFFF` (Crisp White) | Text/icon foreground on `--atlas-action` fills (`>= 8.9:1` dark, `>= 5.4:1` light). |
| `--atlas-focus` | `#80CBE2` (Instrument Cyan) | `#155D77` (Deep Instrument Cyan) | `:focus-visible` keyboard ring (`2px solid`, `outline-offset: 2px`), ruler/LoS ray highlight (`>= 3.0:1`). |
| `--atlas-danger` | `#D57973` (Coral Alert) | `#A3333B` (Crimson Alert) | Destructive actions, `InstantDeath` / failure alerts, and hostile accents (`>= 4.8:1` text contrast). |
| `--atlas-grid` | `rgba(184, 199, 209, 0.16)` | `rgba(28, 48, 65, 0.14)` | Subtle cartographic grid lines on canvas and empty states. |
| `--atlas-shadow` | `rgba(5, 10, 16, 0.42)` | `rgba(15, 26, 37, 0.12)` | Elevation shadow reserved strictly for floating overlays above the map canvas. |

### Named Color Rules
1. **The Map-Art Independence Rule**: Switching between `dark`, `light`, and `system` themes updates DOM chrome (`--atlas-*`) and the PixiJS empty canvas void / grid lines via `CanvasThemePalette`, but **NEVER** applies CSS filters (`invert`, `brightness`, `hue-rotate`, `contrast`) to uploaded battlemap artwork on the `backgroundMap` layer (`mapArtFilter: "none"`), and **ALWAYS** keeps `FogLayer` Layer 0 (`Unexplored`) opaque dark (`#0F1A25`).
2. **The Single-Signal Amber Rule**: `--atlas-action` is reserved for the single primary call-to-action per view, the currently selected tool in the Map Tool Rail, the active combatant turn marker in `CombatTracker`, and the unlocked `PadlockEditMode` indicator. Never dilute it across decorative borders or passive badges.
3. **The Non-Color Redundancy Rule**: No tactical or UI state may be communicated by color alone. Token dispositions (`ally`, `hostile`, `selected`, `activeTurn`), `WallSegment` kinds (`Normal`, `Window`, `Terrain`, `OneWay`, `SecretDoor`, `Door`, `Illusion`), `AoETemplate` footprints, and `MCP Staging Mode` translucent purple ghost previews must always pair color with a distinct geometric shape, badge glyph (`!`, `›`), or stroke dash pattern.

## Typography

TRAME pairs a geometric, compact display face with a technical, high-legibility humanist sans:
- **Display & Short Structural Headings (`--atlas-font-display`)**: `'Space Grotesk', system-ui, -apple-system, sans-serif` (weights `500` and `600`), bundled as self-hosted WOFF2 in `packages/web/public/fonts/` (`OFL-1.1`). Used exclusively for view titles, campaign headers, drawer titles, and modal headings (`<= 60` characters).
- **UI Controls, Long-Form Lore & Tabular Numerics (`--atlas-font-sans`)**: `'IBM Plex Sans', system-ui, -apple-system, sans-serif` (weights `400`, `500`, `600`), bundled as self-hosted WOFF2 in `packages/web/public/fonts/` (`OFL-1.1`).

| Scale Token | Font Family | Size / Line-Height | Weight | Tracking | Usage |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `display` | `Space Grotesk` | `28px` / `1.15` | `600` | `-0.02em` | `CampaignLobby` title, primary campaign header. |
| `headline` | `Space Grotesk` | `20px` / `1.20` | `600` | `-0.015em` | Drawer headers (`DeclarativeSheetRenderer`, `UndoDrawer`), modal titles. |
| `section-title` | `Space Grotesk` | `16px` / `1.30` | `600` | `-0.01em` | Character sheet section headers, compendium group headers. |
| `body` | `IBM Plex Sans` | `16px` / `1.50` | `400` | `0` | `CRDTDocument` wiki notes, spell descriptions, handout prose (`60ch–72ch` max width). |
| `ui` | `IBM Plex Sans` | `14px` / `1.45` | `500` | `0` | Buttons, inputs, tabs, `CombatTracker` rows, inventory items. |
| `meta` | `IBM Plex Sans` | `12px` / `1.35` | `500` | `+0.01em` | Shortcut hints (`Kbd`), coordinates, distance badges, timestamps (never `< 12px`). |

### Mandatory Numeric Discipline (`tabular-nums`)
Every element displaying `AbilityScore`, `AbilityModifier`, `ProficiencyBonus`, `TempHP`, `ResourcePool`, `DeathSaveCounters`, `ElevationFt`, initiative scores, `RulerMetric` distances, container weights, countdown timers (`ReactionBanner`), or dice roll results **MUST** apply `font-variant-numeric: tabular-nums` (`.atlas-tabular-nums`).

## Layout

1. **Canvas Primacy Budget**: On desktop viewports (`1440x900`), the unobstructed tactical battlemap (`TableCanvas`) must occupy `>= 75%` of the viewport area during live play.
2. **Single-Drawer Rule**: At most **one** primary contextual right-hand drawer (`360px–420px` width: `DeclarativeSheetRenderer`, `PartyJournal`, `Compendium`, or `UndoDrawer`) may be open over the canvas at a time. Opening a second workspace tab switches the active drawer rather than stacking multiple sidebars.
3. **4px Spatial Grid**: All padding, gaps, and layout rhythms use multiples of `4px`: `4px` (`--atlas-space-xs`), `8px` (`--atlas-space-sm`), `16px` (`--atlas-space-md`), `24px` (`--atlas-space-lg`), and `32px` (`--atlas-space-xl`).
4. **Responsive Breakpoints & `MobileCompanionLayout`**:
   - **Desktop (`>= 1024px`, reference `1440x900`)**: Top bar (`48px` height), left Map Tool Rail (`48px` width), full PixiJS canvas, and optional right contextual drawer (`380px`).
   - **Tablet (`768px–1023px`)**: Compact top bar, collapsible tool rail, slide-over sheet/journal drawer.
   - **Mobile Companion (`< 768px`, reference `390x844`, `ADR-0009`)**: Automatically bypasses PixiJS WebGL context creation (`isMobileCompanionMode(width) === true`) and mounts `MobileCompanionLayout` with a persistent bottom navigation bar (`Sheet`, `Dice`, `Inventory`, `Journal`) using `>= 44x44px` touch targets.
   - **200% Browser Zoom**: All layouts in `CampaignLobby` and `DeclarativeSheetRenderer` reflow without horizontal scrollbars or clipped labels at `200%` zoom.

## Elevation & Depth

**The Flat-By-Default Rule**:
- **Level 0 (Canvas & Workspace Root)**: `--atlas-bg`, flat (`0` shadow).
- **Level 1 (Structural Panels, Cards & Sheet Sections)**: `--atlas-surface` framed strictly by a `1px solid var(--atlas-border)` hairline and `0` box-shadow. Never nest bordered cards inside bordered cards; separate internal groups with `1px` hairlines or `16px` spacing.
- **Level 2 (Raised Interactive Controls & Sticky Headers)**: `--atlas-surface-raised` with `1px solid var(--atlas-border)`.
- **Level 3 (Floating Overlays Above the Map Canvas, Modals & Context Menus)**: `--atlas-surface` with `1px solid var(--atlas-border)` and `--atlas-elevation-overlay: 0 10px 30px var(--atlas-shadow)`.
- **Prohibited Effects**: Zero colored/amber glow shadows (`0 0 20px`), zero neon halos, zero backdrop-blur glassmorphism over combat stats, and zero hard brutalist offset shadows (`4px 4px 0`).

## Shapes

- **Border Radii**: Utilitarian, architectural corners—`4px` (`--atlas-radius-sm`) for buttons, badges, and tool rail icons; `6px` (`--atlas-radius-md`) for inputs, select fields, and stat boxes; `8px` (`--atlas-radius-lg`) for drawers, modals, and `CampaignLobby` cards. Pill shapes (`9999px`) are forbidden on buttons and cards.
- **Stroked Cartographic Iconography (`AtlasIcons`)**: All UI and tabletop tool icons use a `20x20px` or `24x24px` viewBox with `1.75px` uniform stroke width, `stroke-linecap="round"`, `stroke-linejoin="round"`, `fill="none"`, `stroke="currentColor"`, and `aria-hidden="true"`.
- **Non-Color Tactical Shapes (`CanvasThemePalette`)**:
  - **Ally Token**: Solid ring + solid circle/square badge.
  - **Hostile Token**: Dashed ring (`[6, 4]`) + hexagon badge containing `!`.
  - **Selected Token**: Double ring / corner bracket reticle in `--atlas-focus`.
  - **Active Turn Token**: Solid `--atlas-action` ring + directional chevron (`›`) marker.

## Components

1. **Buttons (`.ds-btn`, `.ds-btn-primary`, `.ds-btn-secondary`, `.ds-btn-danger`)**:
   - Minimum height `40px` on desktop (`>= 44x44px` on touch / `< 768px`), horizontal padding `12px–16px`, radius `4px`, `IBM Plex Sans` `14px` weight `500`.
   - Primary (`button-primary`): `background: var(--atlas-action)`, `color: var(--atlas-on-action)`, `border: 1px solid transparent`.
   - Secondary (`button-secondary`): `background: var(--atlas-surface-raised)`, `color: var(--atlas-text)`, `border: 1px solid var(--atlas-border)`.
   - Danger (`button-danger`): `background: transparent`, `color: var(--atlas-danger)`, `border: 1px solid var(--atlas-danger)`.
2. **Inputs & Form Controls (`.ds-input`)**:
   - Height `40px` (`44px` on touch), `padding: 8px 12px`, `border-radius: 6px`, `background: var(--atlas-surface-raised)`, `color: var(--atlas-text)`, `border: 1px solid var(--atlas-border)`. Every input requires a visible `<label>` or explicit `aria-label`.
3. **Map Tool Rail (`GmOverrideToolbar` / Tool Rail)**:
   - Vertical rail (`48px` wide) of `40x40px` icon buttons (`role="toolbar"`), displaying `aria-pressed="true|false"` and a `2px` `--atlas-action` left bar on the active tool.
4. **Declarative Character Sheet (`DeclarativeSheetRenderer`) & `PadlockEditMode` Header**:
   - Sticky header displaying actor name (`Space Grotesk` `20px`), level/class summary, and the `PadlockEditMode` toggle button (`data-testid="sheet-padlock-toggle"`, `aria-pressed="true|false"`).
   - When `locked` (`aria-pressed="false"`, default during play): displays `PadlockLockedIcon`; structural inputs are read-only while `roll-button` widgets remain 1-click interactive.
   - When `unlocked` (`aria-pressed="true"`): displays `PadlockUnlockedIcon` and a `1px solid var(--atlas-action)` header accent; structural inputs and level-up/equipment edits are enabled.
5. **CombatTracker & ReactionBanner**:
   - Compact horizontal/vertical strip displaying turn order with `.atlas-tabular-nums` initiative badges, non-color disposition icons (`AllyBadgeIcon` / `HostileBadgeIcon`), and a server-synchronized 5-second `ReactionBanner` countdown.

## Do's and Don'ts

### Do's
- **DO** use `var(--atlas-*)` CSS custom properties for all DOM styles and `CanvasThemePalette` for all PixiJS v8 `SceneGraph` colors and stroke dash patterns.
- **DO** verify `>= 4.5:1` contrast for all body/muted/alert text and `>= 3.0:1` for borders, focus rings, and active indicators in both `dark` and `light` themes.
- **DO** apply `.atlas-tabular-nums` (`font-variant-numeric: tabular-nums`) to every stat block, HP counter, initiative value, ruler measurement, and dice roll total.
- **DO** provide non-color-only geometric/iconographic redundancy (`!` hostile badge, dashed strokes, padlock open/closed icons, `aria-pressed`) for every state.
- **DO** use the inline cartographic SVG empty states (`AtlasEmptyStates` with zero baked-in SVG `<text>`) paired with localized HTML headings and primary action buttons.

### Don'ts (Impeccable Craft Floor Anti-Slop Bans)
- **DON'T** use raw hex (`#...`), `rgb(...)`, or `hsl(...)` literals in `.tsx`, `.ts`, or `.css` files outside `packages/web/src/styles/tokens.css` and `packages/web/src/canvas/CanvasThemePalette.ts`.
- **DON'T** apply CSS theme filters (`invert`, `brightness`, `sepia`, `contrast`) to the `backgroundMap` layer or user-uploaded token/map artwork.
- **DON'T** use gradient text (`background-clip: text`), neon/amber glow halos (`box-shadow: 0 0 20px ...`), glassmorphism over dense stats, or nested bordered cards inside bordered cards.
- **DON'T** place uppercase tracked-out eyebrow/kicker labels (`font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em`) above headings.
- **DON'T** fetch fonts from external CDNs (`fonts.googleapis.com` / `fonts.gstatic.com`); always use the self-hosted WOFF2 assets in `packages/web/public/fonts/`.
