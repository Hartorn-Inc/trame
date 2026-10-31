# Surface Contract: Live Tabletop & Tactical HUD (`Operate` Mode)

- **Primary Mode**: `Operate`
- **Target Components**: `TableCanvas`, `GmOverrideToolbar`, `CombatTracker`, `ReactionBanner`, `UndoDrawer`, `DeclarativeSheetRenderer`, `MobileCompanionLayout` (`< 768px`).
- **Surface Rules**:
  1. **Canvas Primacy (`>= 75%` Viewport)**: On `1440x900` desktop viewports, HUD chrome must leave at least 75% of the battlemap unobstructed. At most one contextual right-hand drawer (`360px–420px`) may be open at a time.
  2. **Hybrid Token Ownership**: Preact DOM chrome uses `--atlas-*` CSS variables (`tokens.css`); PixiJS v8 `SceneGraph` layers use `CanvasThemePalette.ts`. Uploaded map art on `backgroundMap` is never filtered (`mapArtFilter: "none"`).
  3. **Non-Color Tactical Redundancy**: Ally vs. hostile tokens, active turn markers, `WallSegment` kinds, `AoETemplate` footprints, and `MCP Staging Mode` ghost previews must pair color with distinct stroke dash patterns or badge shapes (`!`, `›`).
  4. **PadlockEditMode & Tabular Numerics**: `DeclarativeSheetRenderer` defaults to locked `PadlockEditMode` (`aria-pressed="false"`) during play and enforces `.atlas-tabular-nums` (`font-variant-numeric: tabular-nums`) on all numeric counters.
  5. **Touch & Keyboard Ergonomics**: Interactive buttons and tools enforce `>= 40x40px` on desktop (`>= 44x44px` on `< 768px` `MobileCompanionLayout`) and a `2px solid var(--atlas-focus)` focus ring on `:focus-visible`.
