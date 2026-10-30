# GLOSSARY: Declarative Sheet UI, Character Builder & Compendium Drag-Drop

| Term | Category | Definition | Allowed Context | Prohibited Synonyms (_Avoid_) |
| :--- | :--- | :--- | :--- | :--- |
| `ActiveEffect` | Engine Entity | Data structure that modifies an Actor property across five deterministic calculation phases. | System rules, engine pipeline. | buff, debuff, status bonus, modifier rule |
| `ArmorInitiativeSpeed` | Atomic Widget | Widget that renders armor class, initiative modifier, and movement speeds. | Character sheet layout. | AC widget, defense box, mobility block |
| `AttackActionTable` | Atomic Widget | Widget that displays weapon attacks, unarmed strikes, and combat action triggers. | Action layout, combat view. | attack list, weapons panel, strike grid |
| `AtomicWidget` | UI Architecture | Self-contained, system-agnostic UI component that renders domain data and dispatches commands. | Declarative sheet layouts. | subcomponent, leaf widget, UI control |
| `BuilderDraftStore` | State Management | In-memory store that holds transient character wizard form state until commit. | Character creation wizard. | form cache, session storage, draft state |
| `CharacterBuilderWizard` | Component | Multi-step guided wizard that steps through Ancestry, Class, Ability Scores, and Equipment. | Character creation flow. | creation stepper, character creator, guided onboarding |
| `CompendiumDragDropManager` | UI Subsystem | Service that handles HTML5 drag-and-drop transfers of compendium entries and inventory items. | Sheet drag-and-drop. | drop listener, drag handler, DndService |
| `ConditionBadgeStrip` | Atomic Widget | Widget that displays active status conditions and toggles condition removal commands. | Status section, character header. | condition pills, status bar, debuff strip |
| `ContainerWeightCalculator` | Utility | Deterministic algorithm that computes total container weight including tare and multiplier rules. | Inventory calculations. | encumbrance engine, bag weigher |
| `DataBindingPath` | Data Schema | Dot-separated string that resolves to a property in the Actor state or derived stats record. | Widget data bindings. | property path, key path, binding selector |
| `DeclarativeSheetRenderer` | Core Component | Recursive component that resolves a `SheetLayoutTree` into container nodes and widgets. | Sheet rendering pipeline. | dynamic sheet, template renderer, layout engine |
| `FeatureTraitList` | Atomic Widget | Widget that displays passive traits, racial abilities, and class features grouped by source. | Feature view, trait sheet. | trait list, feats container, perk box |
| `GameSystemPack` | Manifest | JSON manifest that defines system attributes, layouts, and creation rules. | Game system package. | system definition, ruleset bundle, rules config |
| `HitDiceAndDeathSaves` | Atomic Widget | Widget that renders hit dice counts, recovery triggers, and death save success/failure pips. | Health panel, sheet vital box. | death tracker, recovery widget, HD panel |
| `InventoryContainerTree` | Atomic Widget | Widget that renders nested inventory items, containers, quantities, and encumbrance stats. | Inventory tab, equipment tree. | bag viewer, gear grid, item list |
| `LayoutNodeKind` | Type Enum | Discriminator string for layout nodes: `section`, `column`, `row`, `tabs`, or `widget`. | Sheet layout AST. | container type, layout tag, branch kind |
| `NotesMarkdownPane` | Atomic Widget | Widget that renders rich text or Markdown actor biography and personal notes. | Bio tab, notes section. | bio editor, text area, notes markdown |
| `ResourceBar` | Atomic Widget | Widget that renders a bounded numeric resource with current, maximum, and temporary values. | Health block, mana bar, resource gauge. | progress bar, stat meter, tracker bar |
| `SavingThrowList` | Atomic Widget | Widget that displays saving throw modifiers and dispatches d20 saving throw roll commands. | Ability overview, defense panel. | saves block, saving throws grid |
| `SheetLayoutTree` | Data Schema | Hierarchical JSON tree describing the container hierarchy and widget nodes of a sheet. | Declarative layout definitions. | sheet AST, layout schema, UI blueprint |
| `SheetNode` | Data Schema | Single node within a `SheetLayoutTree`, either a container or an atomic widget reference. | Layout tree definitions. | layout element, UI tree node |
| `SkillCheckList` | Atomic Widget | Widget that displays skill modifiers, proficiency indicators, and passive check values. | Skills panel, proficiencies list. | skill table, check list, skills grid |
| `SpellbookAccordion` | Atomic Widget | Widget that renders spells grouped by level, spell slot pips, spell DC, and attack bonus. | Spellbook tab, magic pane. | spells manager, magic list, grimoire accordion |
| `StatBlock6` | Atomic Widget | Widget that renders the six primary ability scores and modifiers in a standardized grid. | Abilities panel, top sheet bar. | attributes widget, core stats, ability grid |
| `TrameCommand` | Domain Command | Discrete command payload dispatched to modify engine state or trigger rolls. | Network protocol, engine interface. | action packet, state event, mutation message |
| `WidgetRegistry` | Registry | Immutable dictionary mapping widget type names to their component implementations. | Sheet renderer initialization. | component map, widget factory, registry table |
