# ADR-0009: Mobile Companion Mode Viewport Decoupling and Append-Only Session Timeline

## Status
Accepted

## Context
1. **Mobile Companion Mode**: TRAME's desktop table view mounts a `PixiJS v8` WebGL2/WebGPU canvas with dynamic lighting and 2.5D raycasting (`TableCanvas`). On mobile phones (`< 768px` viewport width), allocating WebGL framebuffers drains battery and GPU memory when players at a physical or hybrid table only need their Character Sheet, Dice Tray, Inventory, and Party Journal.
2. **Append-Only Session Timeline**: Players, Game Masters, and MCP AI assistants (`get_session_timeline`) need an immutable, strictly ordered chronological log of session events (`DiceRolled`, `HandoutRevealed`, combat transitions) with cursor-based pagination.

## Decision
1. **Deterministic Viewport Threshold (`< 768px`)**:
   - Viewports strictly narrower than 768 pixels (`width < 768`) switch into Mobile Companion Mode (`shouldMountPixiCanvas(viewport) === false`), skipping `PixiJS v8` WebGL context creation and exposing bottom-tab navigation across `Sheet`, `Dice`, `Inventory`, and `Journal` (`PartyJournal` + `SessionTimeline`).
2. **Append-Only Session Timeline (`TimelineStorage`)**:
   - Every session event is assigned a strictly sequential, contiguous 64-bit `seq_id` per `(campaign_id, session_num)`.
   - The timeline is exposed via `GET /api/v1/campaigns/{campaign_id}/sessions/{session_num}/timeline?after_seq={seq_id}&limit={limit}` and formatted for MCP consumption via `format_mcp_timeline` (`campaign://{campaign_id}/sessions/{session_num}/timeline`).

## Consequences
### Positive
- Minimal memory and battery footprint on mobile devices (`< 768px`) with 60 FPS HTML/CSS navigation.
- Strictly ordered, race-free chronological timeline for both human review and MCP session recaps.

### Negative
- Mobile users on `< 768px` screens must toggle desktop mode or rotate/expand their viewport to view the tactical battlemap canvas.
