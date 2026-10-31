# Glossaire Technique TRAME

Ce glossaire établit les définitions faisant autorité pour l'ensemble du projet TRAME.
Tous les termes métier doivent être utilisés de manière univoque dans le code, les spécifications et la documentation.

---

## Termes Métier (Core & Rules Engine)

### Actor
Entité vivante ou artificielle représentée dans une scène de jeu (personnage joueur, créature non-joueur, monstre, invocation).
- *Synonymes / Éviter* : Character, Entity, Pawn, Unit, Mob

### AbilityScore
Score fondamental parmi les six caractéristiques de base de D&D 5e (`strength`, `dexterity`, `constitution`, `intelligence`, `wisdom`, `charisma`).
- *Synonymes / Éviter* : Stat, Attribute, Caractéristique

### AbilityModifier
Valeur entière dérivée d'un `AbilityScore` selon la formule standard SRD 5.1 `floor((score - 10) / 2)`.
- *Synonymes / Éviter* : Mod, Bonus de stat

### ProficiencyBonus
Bonus d'aptitude croissant avec le niveau total d'un `Actor` (`+2` aux niveaux 1-4, `+3` aux niveaux 5-8, `+4` aux niveaux 9-12, `+5` aux niveaux 13-16, `+6` aux niveaux 17-20).
- *Synonymes / Éviter* : Aptitude, Maîtrise, CompetenceBonus

### ResourcePool
Réserve de points ou de charges consommables attachée à un `Actor` (ex: points de vie, dés de vie, emplacements de sorts, charges d'objets magiques).
- *Synonymes / Éviter* : StatPool, Counter, Bar, Gauge

### ShortRest
Période de repos de l'univers de jeu durant au minimum 1 heure, permettant à un `Actor` de dépenser des dés de vie pour regagner des points de vie et de réinitialiser ses réserves marquées `SHORT_REST`.
- *Synonymes / Éviter* : Repos court, Petite pause, QuickRest

### LongRest
Période de repos de l'univers de jeu durant au minimum 8 heures, réinitialisant les points de vie au maximum, restaurant les dés de vie à hauteur de `floor(hitDiceMax / 2)` (minimum 1), réinitialisant les réserves marquées `LONG_REST` et réduisant le niveau d'épuisement de 1.
- *Synonymes / Éviter* : Repos long, Nuit de sommeil, FullRest

### LevelUpModal
Composant d'interface utilisateur guidant un utilisateur à travers les étapes successives d'attribution de niveau, de points de vie, de dons ou scores de caractéristiques, et de sorts pour un `Actor`.
- *Synonymes / Éviter* : WizardLevelUp, LevelUpDialog, ProgressionScreen

### RestModal
Composant d'interface utilisateur permettant de configurer et d'appliquer un `ShortRest` ou un `LongRest` pour un `Actor`.
- *Synonymes / Éviter* : RestDialog, CampModal

### SystemSRD
Compendium de données et règles sous licence Creative Commons SRD 5.1 embarqué dans le paquet `@trame/game-system-dnd5e`.
- *Synonymes / Éviter* : SRD, Rulebook, CompendiumData

### CoreBuildLock
Invariant d'intégrité interdisant toute modification manuelle directe des statistiques fondamentales d'un `Actor` en dehors des workflows autoritaires (`LevelUpModal`, création guidée).
- *Synonymes / Éviter* : StatLock, ReadOnlyMode, BuildProtection

### ChaCha20Rng
Générateur cryptographiquement sécurisé côté serveur produisant les tirages d'aléa autoritaires pour les dés de vie et points de vie.
- *Synonymes / Éviter* : ServerRNG, DiceEngine, RandomService

### TrameCommand
Message formel émis par un client vers le serveur pour ordonner une mutation dans l'espace d'une campagne ou d'une table active.
- *Synonymes / Éviter* : Action, Message, MutationRequest

### TrameEvent
Événement immuable persisté et diffusé consignant toute modification autoritaire ou tirage de dé survenu lors d'une session.
- *Synonymes / Éviter* : LogEntry, AuditEvent, TimelineEvent
