# GLOSSARY

This glossary defines the authoritative domain vocabulary for the TRAME tabletop role-playing platform. All architecture decision records, specifications, code artifacts, and issue tickets must use these terms with bijective precision.

### AbilityScore
- **Definition**: The quantitative integer attribute of an Actor (Strength, Dexterity, Constitution, Intelligence, Wisdom, Charisma) ranging from 1 to 30 that dictates mechanical modifiers and derived statistics in the game rules.
- **Avoid**: stat, attribute score, char_stat, token stat.

### ActiveEffect
- **Definition**: A declarative mutation applied to an Actor or Token within the five-phase derivedDAG execution pipeline (Base, Modifier, Override, Temp, Deferred).
- **Avoid**: status buff, debuff, aura effect, condition modifier.

### Actor
- **Definition**: The authoritative game domain entity representing a player character, non-player character, or monster, possessing an identity, sheet layout, and inventory.
- **Avoid**: character, mob, npc, monster, token-sheet.

### CampaignRoomState
- **Definition**: The in-memory authoritative aggregate root maintained by the TableRoomActor containing active scene entities, tokens, fog-of-war bitmasks, spatial BVH structures, and turn tracker state.
- **Avoid**: table state, room aggregate, live game session.

### DrawingOverlay
- **Definition**: The rendering layer and data structure storing collaborative freehand drawings, geometric shapes, and text markers placed directly on a battlemap by players or the Game Master.
- **Avoid**: annotation layer, drawing canvas, whiteboard layer.

### DualBufferFogOfWar
- **Definition**: The dynamic lighting subsystem maintaining an authoritative server-side visibility bitmask and a client-side interpolated GPU texture for revealed and currently visible map regions.
- **Avoid**: fog mask, vision buffer, sight layer.

### FilteredNoteDocument
- **Definition**: A campaign wiki Markdown document containing security annotations (such as `:::gm` or `:::handout`) that the server filters based on the caller campaign role before transmission.
- **Avoid**: role note, secret note, redacted journal.

### GmOverrideToolbar
- **Definition**: The Game Master tabletop user interface control bar providing administrative controls for table mode toggling, ambient lighting presets, starter dungeon seeding, map imports, active effect injection, and action undo.
- **Avoid**: admin panel, gm toolbar, host controls.

### HeadlessCanvasMock
- **Definition**: The deterministic software viewport abstraction used in headless test environments lacking WebGL to record rendering calls, token interactions, and event subscriptions without GPU hardware.
- **Avoid**: dummy canvas, fake pixi, virtual viewport.

### MagicLink
- **Definition**: An asymmetric or HMAC-signed single-use cryptographic invitation uniform resource locator allowing an unauthenticated user or guest player to join a campaign with a designated role.
- **Avoid**: invite link, guest token, join url.

### PreactSignalState
- **Definition**: The reactive state management graph constructed with `@preact/signals` where discrete atomic signals update user interface widgets without full-tree Virtual DOM reconciliation.
- **Avoid**: global store, redux store, react context state.

### SceneGraph
- **Definition**: The hierarchical display tree managed by PixiJS v8 containing background battlemap textures, grid lines, token containers, dynamic lighting meshes, and drawing overlays.
- **Avoid**: pixi tree, render hierarchy, display list.

### SessionTimelineEvent
- **Definition**: An immutable chronological record of a key game event (such as combat initiation, critical hit, actor rest, or handout reveal) logged during a campaign play session.
- **Avoid**: history entry, audit log item, timeline row.

### SqlxPostgresStore
- **Definition**: The persistent storage implementation backed by PostgreSQL 18 and SQLx providing transactional persistence for users, sessions, campaigns, write-ahead logs, and assets.
- **Avoid**: postgres repo, sql backend, database manager.

### TableCanvas
- **Definition**: The browser client component hosting the interactive PixiJS v8 rendering surface, pointer event handlers, viewport controls, and spatial engine bridge.
- **Avoid**: map view, board component, game canvas.

### TableRoomActor
- **Definition**: The stateful server-side actor managing the authoritative campaign room lifecycle, WebSocket connection registry, command processing, and write-ahead log sequencing.
- **Avoid**: room manager, table controller, ws server room.

### TrameArchive
- **Definition**: The self-contained portable campaign export file (`.trame`) containing manifest metadata, write-ahead log events, actor definitions, notes, and compressed binary assets.
- **Avoid**: backup zip, export bundle, world archive.

### TrameCommand
- **Definition**: The strongly typed client-to-server mutation envelope dispatched over WebSocket or HTTP requesting state transitions on a campaign room or domain entity.
- **Avoid**: client action, ws message, mutation request.

### TrameEvent
- **Definition**: The authoritative immutable state delta emitted by the server to connected clients following successful command execution and write-ahead log persistence.
- **Avoid**: server push, room broadcast, change packet.

### UvttMap
- **Definition**: The Universal Virtual Tabletop file format (`.uvtt` / `.dd2vtt`) containing battlemap raster imagery, wall collision vectors, portal definitions, and ambient light placements.
- **Avoid**: dungeondraft map, vtt file, map export.

### WasmSpatialEngine
- **Definition**: The WebAssembly module compiled from `trame-engine` executing 2.5D bounding volume hierarchy raycasting, line-of-sight visibility polygon calculation, and area-of-effect target evaluations.
- **Avoid**: spatial wasm, physics engine, raycast worker.
