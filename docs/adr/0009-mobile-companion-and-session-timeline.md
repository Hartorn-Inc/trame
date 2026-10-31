# ADR-0009: Mobile Companion Mode Viewport Decoupling, Reactive i18n, and Append-Only Session Timeline

## Status
Accepted

## Context
1. **Mobile Companion Mode**: TRAME's desktop table view mounts a `PixiJS v8` WebGL2/WebGPU canvas with dynamic lighting and 2.5D raycasting (`TableCanvas`). On mobile phones (`< 768px` viewport width), allocating WebGL framebuffers drains battery and GPU memory when players at a physical or hybrid table only need their Character Sheet, Dice Tray, Inventory, and Party Journal. Previously, `MobileCompanionLayout` was unmounted from the Preact root (`App.tsx`).
2. **Append-Only Session Timeline**: Players, Game Masters, and MCP AI assistants (`get_session_timeline`) need an immutable, strictly ordered chronological log of session events (`DiceRolled`, `HandoutRevealed`, combat transitions) with cursor-based pagination.
3. **Presentation Layer i18n and Tactical Unit Conversion**: Tables require localized interfaces (`EN` / `FR`) and dynamic tactical measurement conversion (`5 ft` <-> `1.5 m (1 case)`). Presentation localization must never alter underlying Rust engine rule calculations or canonical network protocol identifiers.

## Decision
1. **Deterministic Viewport Threshold and Reactive `MobileCompanionView` Lifecycle**:
   - `App.tsx` controls canvas mounting via a computed signal:
     `shouldMountCanvas = computed(() => !mobileCompanionOverrideSignal.value && windowWidthSignal.value >= 768)`.
   - When `shouldMountCanvas.value === false`:
     1. The client unmounts `TableCanvas` and destroys the PixiJS application via `app.destroy(true, { children: true, texture: false })`, releasing GPU textures and framebuffers.
     2. Preact mounts `MobileCompanionView` (`[data-testid="mobile-companion-view"]`) with 5 bottom navigation tabs: `Sheet`, `Dice`, `Inventory`, `Tracker`, and `Journal`.
   - When viewport width reaches 768px or greater with override disabled, the client cleanly re-instantiates `TableCanvas`.
2. **Append-Only Session Timeline (`TimelineStorage`)**:
   - Every session event is assigned a strictly sequential, contiguous 64-bit `seq_id` per `(campaign_id, session_num)`.
   - The timeline is exposed via `GET /api/v1/campaigns/{campaign_id}/sessions/{session_num}/timeline?after_seq={seq_id}&limit={limit}` and formatted for MCP consumption via `format_mcp_timeline` (`campaign://{campaign_id}/sessions/{session_num}/timeline`).
3. **Reactive Presentation Layer for i18n and Metric Unit Conversion**:
   - The module `packages/web/src/i18n/` operates strictly as a reactive presentation layer using `@preact/signals`.
   - Two global reactive signals are exposed: `localeSignal` (`'en' | 'fr'`) and `unitSystemSignal` (`'imperial_ft' | 'metric_m'`).
   - Distance conversion executes via the pure function `formatDistanceFt(feet)`:
     - Imperial system: `${feet} ft`.
     - Metric system: `${feet * 0.3} m (${squares} ${squares <= 1 ? 'case' : 'cases'})` where `squares = Math.round(feet / 5)`.
   - All network protocols (`ClientEnvelope` / `ServerEnvelope`), Rust structures, and engine rule slugs remain exclusively in canonical English and imperial feet.
   - Compendium search incorporates a bidirectional bilingual lexicon mapping translated query terms to canonical English keys.

## Consequences
### Positive
- Minimal memory and battery footprint on mobile devices (`< 768px`) with 60 FPS HTML/CSS navigation.
- Zero GPU memory leak on mobile devices due to explicit PixiJS instance destruction.
- Strictly ordered, race-free chronological timeline for human review and MCP recaps.
- Dynamic localized presentation and unit conversion without compromising engine calculation integrity.

### Negative
- Dynamic switching between desktop and mobile companion mode triggers a full WebGL canvas reconstruction.
- Mobile users on `< 768px` screens must toggle the override signal or expand their viewport to view the tactical battlemap canvas.
