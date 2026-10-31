# ADR-0009: Mobile Companion Viewport Decoupling, Append-Only Session Timeline, and Reactive i18n

## Status
Accepted

## Context
1. **Mobile Companion Mode**: TRAME's desktop table view mounts a `PixiJS v8` WebGL2/WebGPU canvas with dynamic lighting and 2.5D raycasting (`TableCanvas`). On mobile phones (`< 768px` viewport width), allocating WebGL framebuffers drains battery and GPU memory when players at a physical or hybrid table only need their Character Sheet, Dice Tray, Inventory, and Party Journal. Viewports `< 768px` require deterministic WebGL context teardown without leaving orphaned layout controllers.
2. **Append-Only Session Timeline**: Players, Game Masters, and MCP AI assistants (`get_session_timeline`) need an immutable, strictly ordered chronological log of session events (`DiceRolled`, `HandoutRevealed`, combat transitions) with cursor-based pagination.
3. **Multilingual and Metric Presentation**: Tabletops require bilingual support (`FR` / `EN`) and metric tactical conversion (`5 ft` <-> `1.5 m (1 case)`) without altering canonical geometric calculations, WebSocket envelopes, or Rust engine slugs.

## Decision
1. **Deterministic Viewport Threshold and WebGL Lifecycle Teardown (`< 768px`)**:
   - `App.tsx` controls viewport rendering via a reactive computed signal:
     `shouldMountCanvas = computed(() => !mobileCompanionOverrideSignal.value && windowWidthSignal.value >= 768)`.
   - WHEN `shouldMountCanvas.value === false`:
     1. The canvas `TableCanvas` unmounts and the application destroys the PixiJS instance via `app.destroy(true, { children: true, texture: false })`, releasing GPU textures and framebuffers.
     2. Preact mounts `MobileCompanionView` with 5 touch tabs (`Sheet`, `Dice`, `Inventory`, `Tracker`, `Journal`).
   - WHEN the viewport width reaches 768 pixels or higher and `mobileCompanionOverrideSignal` is false, `App.tsx` re-instantiates `TableCanvas` cleanly.
2. **Append-Only Session Timeline (`TimelineStorage`)**:
   - Every session event is assigned a strictly sequential, contiguous 64-bit `seq_id` per `(campaign_id, session_num)`.
   - The timeline is exposed via `GET /api/v1/campaigns/{campaign_id}/sessions/{session_num}/timeline?after_seq={seq_id}&limit={limit}` and formatted for MCP consumption via `format_mcp_timeline` (`campaign://{campaign_id}/sessions/{session_num}/timeline`).
3. **Reactive Presentation Layer for i18n and Metric Unit Conversion**:
   - Module `packages/web/src/i18n/` operates strictly as a reactive presentation layer using `@preact/signals`.
   - Exposes global reactive signals: `localeSignal` (`'en' | 'fr'`) and `unitSystemSignal` (`'imperial_ft' | 'metric_m'`).
   - Formats distances via pure function `formatDistanceFt(feet)`:
     - Imperial: `${feet} ft`.
     - Metric: `${feet * 0.3} m (${squares} ${squares <= 1 ? 'case' : 'cases'})` with `squares = Math.round(feet / 5)`.
   - Network protocols (`ClientEnvelope`, `ServerEnvelope`), Rust engine types, and rule slugs remain strictly in canonical English and feet units.
   - Compendium search integrates a bidirectional lexicon (`compendiumLexicon.ts`) resolving translated terms (*Furtivité*, *Boule de feu*) to canonical underlying keys (*stealth*, *fireball*).

## Consequences
### Positive
- Minimal memory and battery footprint on mobile devices (`< 768px`) with 60 FPS HTML/CSS navigation.
- Zero GPU memory leaks on mobile devices via explicit PixiJS instance destruction.
- Strictly ordered, race-free chronological timeline for both human review and MCP session recaps.
- Reactive UI localization and tactical metric conversion with zero alteration to engine calculations or network wire formats.

### Negative
- Mobile users on `< 768px` screens must toggle desktop mode or rotate/expand their viewport to view the tactical battlemap canvas.
- Dynamic mobile/desktop switching requires full WebGL canvas re-initialization.
- Touch UI components must consume `formatDistanceFt` and translation helper `t(key)`.
