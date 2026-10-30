# Glossaire EPURE & TRAME V1

Ce glossaire établit la terminologie canonique et bijective pour le projet TRAME, le moteur `trame-engine` et le GameSystemPack `packages/game-systems/dnd5e`. Conformément à la norme ASD-STE100 (ADR-0031), chaque concept possède un terme unique. Les synonymes listés sous _Avoid_ sont strictement interdits.

---

### AbilityModifier
- **Definition**: Valeur numérique entière dérivée du score de caractéristique d'un acteur selon la formule standard : `Math.floor((score - 10) / 2)`.
- **Allowed**: `AbilityModifier`, `modificateur de caractéristique`
- **Avoid**: `bonus de carac`, `stat mod`, `carac bonus`

### AbilityScore
- **Definition**: Valeur numérique entière représentant le score de base ou effectif d'un acteur pour une caractéristique parmi `str`, `dex`, `con`, `int`, `wis`, `cha`.
- **Allowed**: `AbilityScore`, `score de caractéristique`
- **Avoid**: `stat`, `statistique`, `caractéristique brute`

### ActiveEffect
- **Definition**: Mutation déclarative appliquée à une propriété numérique ou textuelle d'un acteur selon l'ordre strict des 5 phases (`BASE_FORMULA` -> `ADD` -> `OVERRIDE_CONDITIONAL` -> `MULTIPLY` -> `FINAL_CLAMP`).
- **Allowed**: `ActiveEffect`, `effet actif`
- **Avoid**: `buff`, `debuff`, `stat modifier`, `status effect`

### Actor
- **Definition**: Entité du monde de jeu (personnage-joueur, PNJ ou monstre) possédant un état persistant, des caractéristiques, un inventaire et des effets actifs.
- **Allowed**: `Actor`, `acteur`
- **Avoid**: `personnage`, `entité`, `token`

### CampaignHomebrew
- **Definition**: Niveau supérieur de persistance du compendium stockant les entités personnalisées et les surcharges spécifiques à une campagne de jeu, prioritaire sur `INSTANCE_LIBRARY` et `SYSTEM_SRD`.
- **Allowed**: `CampaignHomebrew`, `compendium de campagne`
- **Avoid**: `homebrew local`, `custom campaign data`

### CompendiumResolver
- **Definition**: Composant déterministe résolvant les requêtes de recherche et d'accès aux entités de jeu selon la cascade prioritaire immuable `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD`.
- **Allowed**: `CompendiumResolver`, `résolveur de compendium`
- **Avoid**: `compendium service`, `entity fetcher`

### CompendiumTier
- **Definition**: Couche de stockage hiérarchique au sein du compendium identifiée par l'une des valeurs : `SYSTEM_SRD`, `INSTANCE_LIBRARY` ou `CAMPAIGN_HOMEBREW`.
- **Allowed**: `CompendiumTier`, `niveau de compendium`
- **Avoid**: `compendium layer`, `compendium level`

### ConcentrationCheckPrompt
- **Definition**: Intention interactive générée par le pipeline de dégâts lorsqu'un acteur subit des dégâts alors qu'il maintient un sort sous concentration, avec un Degré de Difficulté (DD) égal à `Math.max(10, Math.floor(damageTaken / 2))`.
- **Allowed**: `ConcentrationCheckPrompt`, `invite de jet de concentration`
- **Avoid**: `concentration check`, `concentration save prompt`, `concentration DC`

### Condition
- **Definition**: État standardisé affectant un acteur (ex: `blinded`, `charmed`, `unconscious`) associé à une durée en rounds et à un déclencheur d'expiration.
- **Allowed**: `Condition`, `état`
- **Avoid**: `statut`, `altération d'état`, `affliction`

### DamageMitigation
- **Definition**: Application ordonnée des modificateurs de réduction et d'amplification de dégâts selon la séquence stricte : `IMMUNE` (multiplicateur 0), puis `RESISTANT` (multiplicateur 0.5 avec arrondi inférieur), puis `VULNERABLE` (multiplicateur 2).
- **Allowed**: `DamageMitigation`, `atténuation de dégâts`
- **Avoid**: `mitigation`, `damage reduction`, `resistance pipeline`

### DamageType
- **Definition**: Catégorie de dégâts normalisée du SRD 5.1 (`acid`, `bludgeoning`, `cold`, `fire`, `force`, `lightning`, `necrotic`, `piercing`, `poison`, `psychic`, `radiant`, `slashing`, `thunder`).
- **Allowed**: `DamageType`, `type de dégâts`
- **Avoid**: `élément`, `damage category`

### DeathSavingThrow
- **Definition**: Jet de sauvegarde d20 sans caractéristique exécuté par un acteur inconscient à 0 PV au début de son tour, cumulant succès (seuil >= 10) et échecs (seuil < 10, double échec sur 1 naturel, reprise à 1 PV sur 20 naturel).
- **Allowed**: `DeathSavingThrow`, `jet de sauvegarde contre la mort`
- **Avoid**: `death save`, `jet de mort`

### DerivedDAG
- **Definition**: Graphe orienté acyclique d'expressions mathématiques déclaratives évaluant les propriétés calculées de l'acteur sans cycle ni effet de bord.
- **Allowed**: `derivedDAG`, `DAG dérivé`
- **Avoid**: `formule de calcul`, `stat tree`, `dependency graph`

### GameSystemPack
- **Definition**: Ensemble standardisé de manifestes déclaratifs, de schémas de données, de helpers métier et de compendiums encapsulant les règles d'un système de jeu de rôle spécifique.
- **Allowed**: `GameSystemPack`, `pack système`
- **Avoid**: `system plugin`, `game module`, `ruleset`

### InstantDeath
- **Definition**: Règle du SRD 5.1 déclenchant la mort définitive et irréversible d'un acteur lorsque le surplus de dégâts subis après passage à 0 PV est supérieur ou égal à ses PV maximaux (`hp.max`).
- **Allowed**: `InstantDeath`, `mort instantanée`
- **Avoid**: `massive damage death`, `overkill death`

### InstanceLibrary
- **Definition**: Niveau intermédiaire de compendium stockant les données de jeu partagées entre les campagnes hébergées sur une même instance TRAME.
- **Allowed**: `InstanceLibrary`, `bibliothèque d'instance`
- **Avoid**: `instance compendium`, `shared library`

### LongRest
- **Definition**: Période de repos prolongée d'au moins 8 heures restaurant tous les PV, réinitialisant les PV temporaires à 0, restaurant `Math.max(1, Math.floor(hitDiceMax / 2))` dés de vie, réduisant l'épuisement d'un niveau et réinitialisant tous les emplacements de sorts et réserves de ressources.
- **Allowed**: `LongRest`, `repos long`
- **Avoid**: `extended rest`, `full rest`

### ProficiencyBonus
- **Definition**: Bonus numérique entier déterminé par le niveau global du personnage selon la formule déclarative : `Math.floor((level - 1) / 4) + 2`.
- **Allowed**: `ProficiencyBonus`, `bonus de maîtrise`
- **Avoid**: `prof bonus`, `mastery bonus`

### ProficiencyRank
- **Definition**: Multiplicateur numérique entier valant 0 (non maîtrisé), 1 (maîtrisé) ou 2 (expertise) appliqué au bonus de maîtrise pour une compétence ou un jet de sauvegarde.
- **Allowed**: `ProficiencyRank`, `rang de maîtrise`
- **Avoid**: `proficiency level`, `mastery rank`

### ResourcePool
- **Definition**: Compteur numérique borné (`current`, `max`) associé à une fréquence de réinitialisation (`SHORT_REST` ou `LONG_REST`) gérant les capacités limitées d'un acteur.
- **Allowed**: `ResourcePool`, `réserve de ressource`
- **Avoid**: `feature counter`, `ability charge`, `resource tracker`

### ShortRest
- **Definition**: Période de repos court d'au moins 1 heure permettant la dépense interactive de dés de vie pour regagner des PV, la récupération des emplacements de magie de pacte et la réinitialisation des réserves de ressources configurées sur `SHORT_REST`.
- **Allowed**: `ShortRest`, `repos court`
- **Avoid**: `quick rest`, `brief rest`

### SystemSRD
- **Definition**: Données de référence de base du système de jeu issues du System Reference Document 5.1 sous licence CC-BY-4.0, distribuées en lecture seule et intégrées au pack système.
- **Allowed**: `SystemSRD`, `SRD système`
- **Avoid**: `core compendium`, `builtin srd`

### TempHP
- **Definition**: Points de vie temporaires non cumulatifs servant de réserve d'absorption prioritaire avant déduction des dégâts sur les points de vie courants de l'acteur.
- **Allowed**: `TempHP`, `PV temporaires`
- **Avoid**: `temporary hit points`, `bouclier de PV`

### TurnTrigger
- **Definition**: Moment d'évaluation temporelle lors de la phase de combat (`ROUNDS`, `TURNS_START`, `TURNS_END`) déterminant la décrémentation de la durée des conditions actives.
- **Allowed**: `TurnTrigger`, `déclencheur de tour`
- **Avoid**: `phase d'initiative`, `round tick`
