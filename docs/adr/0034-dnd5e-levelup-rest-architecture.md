# ADR 0034 : Architecture de la Montée de Niveau (Lvl 1-20), des Repos (Short/Long) et de l'Expansion SRD 5.1

- **Statut** : Accepté
- **Date** : 2025-05-20
- **Décideurs** : Architecte EPURE, Core Team TRAME
- **Branche** : `plan/77-spec-d-d-5e-levelupmodal-lvl-1-20-sh`

## 1. Contexte
Le système de jeu `@trame/game-system-dnd5e` possède une fonction `applyLevelUp` embryonnaire dans `packages/game-systems/dnd5e/src/progression.ts`. Cette fonction ne gère pas le choix de sous-classes, le dilemme ASI (`+2` ou `+1/+1`) versus Dons, l'apprentissage de sorts ni la progression multiclasses/magie de pacte. De plus, aucune fonction de repos (`ShortRest`, `LongRest`) n'est définie dans le moteur. Dans l'interface utilisateur web (`@trame/web`), aucun dialogue n'est exposé pour exécuter la montée de niveau ou les repos depuis la fiche d'un `Actor` (`CampaignWorkspace` ou `HudDrawers.tsx`). Enfin, le compendium embarqué `compendium.ts` ne contient qu'une fraction minimale des objets et monstres du SRD 5.1 et ne prend pas en charge la localisation bilingue (`en`/`fr`).

## 2. Décisions

### 2.1 Découpage Modulaire dans `@trame/game-system-dnd5e`
- Le module `packages/game-systems/dnd5e/src/rest.ts` regroupe les fonctions pures et synchrones `applyShortRest(actor: Dnd5eActorData, options: ShortRestOptions): Dnd5eActorData` et `applyLongRest(actor: Dnd5eActorData): Dnd5eActorData`.
- Le module `packages/game-systems/dnd5e/src/progression.ts` étend `applyLevelUp(actor: Dnd5eActorData, options: LevelUpOptions): Dnd5eActorData` avec validation stricte du niveau maximum (20), du plafonnement des caractéristiques à 20 lors des ASI, et des tables de sorts canoniques.
- Les tables d'emplacements de sorts `FULL_CASTER_SPELL_SLOTS`, `HALF_CASTER_SPELL_SLOTS` et `PACT_MAGIC_SPELL_SLOTS` sont exportées de `packages/game-systems/dnd5e/src/progression.ts`.

### 2.2 Autorité des Tirages de Dés
- Aucun composant d'interface utilisateur n'utilise `Math.random()`.
- Les tirages de points de vie et de dés de vie pendant le repos sollicitent le service autoritaire serveur basé sur `ChaCha20Rng` via la route REST `POST /api/v1/campaigns/{id}/dice/roll` (hors session active) ou via la commande CQRS WebSocket `TrameCommand::RollDice` (sur table active).
- Chaque jet génère un `TrameEvent` consigné dans le journal public de session avec sa signature autoritaire avant application de la mutation sur l'`Actor`.

### 2.3 Double Canal de Persistance (CQRS / REST)
- Lorsque l'utilisateur déclenche une montée de niveau ou un repos depuis le HUD de table en direct (`HudDrawers.tsx`), le client expédie la commande CQRS `TrameCommand::UpdateActorData` via WebSocket. Le `TableRoomActor` traite la commande, diffuse la mise à jour aux abonnés et la persiste via `SqlxPostgresStore`.
- Lorsque l'utilisateur déclenche l'action depuis `CampaignWorkspace` hors session active, le client expédie une requête REST `PUT /api/v1/campaigns/{id}/actors/{actor_id}`.

### 2.4 Format Compendium et Internationalisation
- Les clés d'identification des entrées du compendium conservent des slugs canoniques ASCII universels non traduits (`srd:spell:fireball`, `srd:item:bag_of_holding`).
- Chaque entrée de `compendium.ts` supporte un bloc optionnel bilingue `i18n?: { en: { name: string, description: string }, fr: { name: string, description: string } }`.
- Les conteneurs magiques utilisent la propriété `contentWeightMultiplier: 0` pour annuler le poids de leur contenu.

## 3. Conséquences

### 3.1 Conséquences Positives
- Intégrité stricte des règles SRD 5.1 garantie par des fonctions pures et testables unitairement sans dépendance réseau.
- Traçabilité et impossibilité de triche sur les tirages de dés de vie grâce au générateur `ChaCha20Rng` côté serveur.
- Expérience utilisateur unifiée entre la préparation hors session (`CampaignWorkspace`) et le jeu en direct (`HudDrawers.tsx`).

### 3.2 Conséquences Négatives et Risques Atténués
- Nécessité de maintenir deux canaux d'application (REST et CQRS) : le code UI partage le même modèle de présentation et délègue la persistance à un adaptateur d'environnement injecté.
