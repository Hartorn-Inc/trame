# TRAME Ubiquitous Domain Glossary

Controlled domain vocabulary and technical term definitions adhering to ASD-STE100 and ADR-0011.

### ActiveEffect
- **Definition**: A data modifier that adjusts Actor statistics, combat rolls, or conditions through the five-phase engine evaluation pipeline.
- **Allowed Context**: Game engine rules, status conditions, stat calculations, and spell modifiers.
- **_Avoid_**: Buff, Debuff, StatusEffect, StatBonus.

### Actor
- **Definition**: The authoritative domain entity representing a player character, non-player character, or monster on the virtual tabletop.
- **Allowed Context**: Entity state management, permissions, token spawning, and sheet layouts.
- **_Avoid_**: Character, Entity, PlayerAvatar, Creature.

### AoETemplate
- **Definition**: A geometric shape projected onto the tactical canvas to represent the area of effect of a spell or hazard.
- **Allowed Context**: Spell targeting, spatial queries, canvas overlays, and token overlap detection.
- **_Avoid_**: SpellTemplate, AreaOverlay, BlastRadius.

### CampaignWorkspace
- **Definition**: The authenticated Preact application workspace container providing tabbed access to the live table, actors, journal, compendium, and settings.
- **Allowed Context**: Top-level application routing, view coordination, and campaign management.
- **_Avoid_**: AppShell, Dashboard, GameLobby, TabletopContainer.

### CanvasThemePalette
- **Definition**: The typed numeric registry providing WebGL colors, alpha values, and geometric stroke styles to the PixiJS scene graph across light and dark themes.
- **Allowed Context**: WebGL rendering, PixiJS scene graph layers, and tactical canvas styling.
- **_Avoid_**: CanvasColors, WebGlTheme, MapPalette.

### CharacterBuilderWizard
- **Definition**: The client-side state machine guiding players through a sequential five-step character creation workflow before atomic persistence.
- **Allowed Context**: Character generation, ability score allocation, ancestry selection, and class setup.
- **_Avoid_**: CharacterCreator, GuidedSetup, StepWizard.

### CombatTracker
- **Definition**: The tactical HUD component managing initiative order, active turn indicators, and combat round sequencing.
- **Allowed Context**: Turn-by-turn combat mode, initiative sorting, and combatant disposition display.
- **_Avoid_**: InitiativeList, TurnOrderView, BattleHUD.

### CompendiumDragDropManager
- **Definition**: The client-side coordinator validating and processing drag-and-drop operations between the compendium and character sheets.
- **Allowed Context**: Compendium interactions, container hierarchies, and item dropping.
- **_Avoid_**: DragDropHandler, CompendiumTransfer, DndController.

### CRDTDocument
- **Definition**: A conflict-free replicated data type document powering collaborative real-time campaign wiki notes.
- **Allowed Context**: Wiki note editing, collaborative synchronization, and handout drafting.
- **_Avoid_**: SharedNote, LiveDoc, CollaborativeText.

### DeclarativeSheetRenderer
- **Definition**: The component engine that parses layout trees, evaluates data bindings, and renders atomic character sheet widgets.
- **Allowed Context**: Character sheet rendering, widget layouts, and dynamic system sheets.
- **_Avoid_**: SheetView, CharacterRenderer, FormBuilder.

### DirectiveBlock
- **Definition**: A fenced Markdown directive block providing role-based visibility filtering for secret GM content or party handouts.
- **Allowed Context**: Note parsing, handout reveals, and role-based access filtering.
- **_Avoid_**: SecretBlock, RoleFence, CustomMarkdownTag.

### FogLayer
- **Definition**: The dedicated scene graph layer rendering explored and unexplored fog of war on the tactical canvas.
- **Allowed Context**: Tactical scene rendering, vision calculation, and fog polygons.
- **_Avoid_**: ShadowLayer, ShroudLayer, DarknessMask.

### GmOverrideToolbar
- **Definition**: The authoritative toolbar enabling Game Masters to override combat turns, adjust ambient lighting, and execute emergency roll corrections.
- **Allowed Context**: Game Master controls, session administration, and table moderation.
- **_Avoid_**: AdminBar, DmToolbar, GodTools.

### MobileCompanionLayout
- **Definition**: The responsive layout mounted on mobile viewports under 768 pixels to bypass WebGL canvas creation and provide touch-first tabs.
- **Allowed Context**: Responsive mobile screens, smartphone viewports, and touch navigation.
- **_Avoid_**: MobileView, PhoneShell, ResponsiveDrawer.

### NotesMarkdownPane
- **Definition**: The character sheet widget that renders Markdown biography and notes with sanitized HTML output.
- **Allowed Context**: Character sheet notes, actor background text, and lore rendering.
- **_Avoid_**: BioPane, MarkdownArea, TextNotesWidget.

### PadlockEditMode
- **Definition**: The security state toggle in the character sheet header that switches between locked play mode and unlocked edit mode.
- **Allowed Context**: Character sheet editing, combat protection, and input field gating.
- **_Avoid_**: LockMode, EditToggle, SheetStateLock.

### ReactionBanner
- **Definition**: The synchronized HUD banner displaying active five-second reaction interruption countdowns across connected clients.
- **Allowed Context**: Combat interruptions, opportunity attacks, and timed reaction windows.
- **_Avoid_**: InterruptAlert, PromptBanner, CountdownPopup.

### SceneGraph
- **Definition**: The authoritative seven-layer PixiJS rendering hierarchy managing battlemap art, lighting, tokens, fog, and HUD overlays.
- **Allowed Context**: Tactical canvas rendering, PixiJS containers, and visual layer ordering.
- **_Avoid_**: RenderTree, CanvasHierarchy, PixiLayers.

### TableCanvas
- **Definition**: The desktop WebGL2 and WebGPU canvas element mounting the PixiJS tactical scene graph for interactive play.
- **Allowed Context**: Desktop table view, tactical battlemap rendering, and token interaction.
- **_Avoid_**: MapCanvas, TableView, GameBoard.

### ThreatReach
- **Definition**: The spatial threat perimeter surrounding a hostile token that triggers opportunity attacks when vacated.
- **Allowed Context**: Combat movement, reaction interruptions, and grid distance evaluation.
- **_Avoid_**: AttackRange, DangerZone, ProximityArea.

### TimelineStorage
- **Definition**: The append-only storage engine recording immutable sequential session events for audit logs and timeline queries.
- **Allowed Context**: Session history, event streaming, audit logs, and MCP timeline queries.
- **_Avoid_**: EventLog, SessionHistoryDb, AuditStorage.

### TrameCommand
- **Definition**: An authoritative command envelope dispatched by client components to mutate campaign state, roll dice, or project templates.
- **Allowed Context**: Client-to-server messaging, CQRS pipeline, and action dispatch.
- **_Avoid_**: ActionPayload, WebSocketMessage, ClientEvent.

### UndoDrawer
- **Definition**: The slide-out interface drawer allowing Game Masters to inspect the bounded history ring buffer and revert state mutations.
- **Allowed Context**: State rollback, history management, and 1-click state undo.
- **_Avoid_**: HistoryDrawer, RollbackPanel, RevertView.

### WallSegment
- **Definition**: A spatial line segment defining physical obstruction, light occlusion, and sound blocking properties between two endpoints.
- **Allowed Context**: Map building, line of sight raycasting, wall tools, and ambient lighting.
- **_Avoid_**: Obstacle, BarrierLine, WallVector.
