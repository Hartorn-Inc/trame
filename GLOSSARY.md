# GLOSSARY / GLOSSAIRE TR-AME & EPURE

## Domain Terminology / Terminologie Métier

| Term (EN) | Terme (FR) | Définition Normative (ASD-STE100) | Statut | Termes Proscrits (_Avoid_) |
|---|---|---|---|---|
| `DeclarativeSheetView` | Vue Déclarative de Fiche | Interactive Preact component that consumes an AST sheet layout and renders registered declarative widgets. | Ubiquitous | SheetView, HardcodedSheet, HudSheet |
| `WidgetRegistry` | Registre de Widgets | Central registry mapping declarative widget layout types to their corresponding Preact component implementations. | Ubiquitous | ComponentMap, WidgetMap, ElementRegistry |
| `CoreBuildLock` | Verrou de Construction Fondamentale | Hierarchical security mechanism governing whether actor core build scores render as 1-click roll triggers or editable controls. | Ubiquitous | StatLock, SheetLock, BuildFreeze |
| `coreStatsLocked` | Verrou Local Joueur | Client-side boolean signal toggled by the player using a padlock icon to switch between roll mode and edit mode. | Ubiquitous | localLock, playerPadlock, editToggle |
| `gm_core_locked` | Verrou Autoritaire MJ | Server-authoritative boolean flag set by the Game Master to force actor core build scores into locked roll mode. | Ubiquitous | masterLock, serverFreeze, gmLock |
| `AbilityScore` | Valeur de Caractéristique | One of the six core attributes (Strength, Dexterity, Constitution, Intelligence, Wisdom, Charisma) defining an actor. | Ubiquitous | character build stats, raw stats, stat scores |
| `ProficiencyRank` | Rang de Maîtrise | Integer scale defining proficiency tier: 0 for unproficient, 1 for proficient, and 2 for expertise. | Ubiquitous | proficiency level, skill rank, mastery rank |
| `DeathSavingThrow` | Jet de Sauvegarde contre la Mort | Authoritative saving throw rolled when an actor current HP is 0 to determine stabilization or death. | Ubiquitous | Death Saves, Death save roll, [ Roll Death Save ] |
| `ActiveEffect` | Effet Actif | Reactive modifier applied to an actor that alters statistics, proficiencies, or status conditions. | Ubiquitous | Buff, Debuff, StatusModifier |
| `AttackActionTable` | Tableau des Actions d'Attaque | Declarative widget rendering weapon and spell attacks with ammunition linkages and roll execution. | Ubiquitous | AttackList, WeaponTable, ActionGrid |
| `SpellbookAccordion` | Accordéon de Grimoire | Declarative widget organizing spells by spell level, managing spell slot pips, and triggering AoE projections. | Ubiquitous | SpellList, MagicBook, SpellRoster |
| `InventoryContainerTree` | Arbre de Conteneurs d'Inventaire | Declarative widget managing hierarchical containers, equipment, items, currencies, and encumbrance calculations. | Ubiquitous | BagList, ItemTree, InventoryView |
| `CompendiumDrawer` | Tiroir de Compendium | Searchable sidebar drawer interface exposing items, spells, and features across compendium libraries. | Ubiquitous | CompendiumPanel, LibraryDrawer, SpellsItemsDrawer |
| `CompendiumDragDropManager` | Gestionnaire de Glisser-Déposer de Compendium | Stateless client service coordinating drag-and-drop actions from the compendium to character sheet drop targets. | Ubiquitous | DragManager, DropCoordinator, CompendiumDnD |
| `RollDice` | Lancer de Dé Autoritaire | Authoritative CQRS command requesting server-side pseudorandom roll evaluation via ChaCha20Rng. | Ubiquitous | DiceRoll, RollRequest, ThrowDice |
| `ChaCha20Rng` | Générateur ChaCha20 | Cryptographically secure deterministic pseudorandom number generator used for authoritative dice rolls. | Ubiquitous | CryptoRng, RandomSource, MathRandom |
| `derivedDAG` | Graphe Acyclique Dirigé Dérivé | Reactive dependency graph computing derived actor statistics from base attributes and active modifiers. | Ubiquitous | ComputedStats, StatGraph, DerivedValues |
| `TableCanvas` | Canevas de Table Virtuelle | Tabletop interactive canvas rendering the map, grid, tokens, measurements, and AoE template projections. | Ubiquitous | BoardView, CanvasGrid, VTTCanvas |
| `AoEProjection` | Projection de Zone d'Effet | Interactive geometric shape projected onto TableCanvas to preview and confirm spell area of effect placement. | Ubiquitous | SpellTemplate, BlastZone, ShapeOverlay |