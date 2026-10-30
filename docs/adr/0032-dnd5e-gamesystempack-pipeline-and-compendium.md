# 32. Architecture du GameSystemPack D&D 5e : Pipeline de dégâts multi-types, repos déterministes et compendium hiérarchique à 3 niveaux

- **Statut** : Accepté
- **Date** : 2025-05-18
- **Auteurs** : Équipe TRAME & Architecte EPURE
- **Contexte** : Issue #7 ([E1] Built-in D&D 5e GameSystemPack (SRD 5.1))

## Contexte et Problématique

L'épopée TRAME V1 requiert un pack de système de jeu complet et prêt à l'emploi pour Dungeons & Dragons 5e (SRD 5.1 sous licence Creative Commons CC-BY-4.0).
Le moteur central `crates/trame-engine` (Rust/WASM) fournit les fondations mathématiques génériques : l'évaluateur déclaratif `derivedDAG`, le gestionnaire d'effets actifs en 5 phases et la fonction d'atténuation mono-instance `resolve_damage_application`.

Cependant, les règles complètes de combat et d'évolution du SRD 5.1 introduisent des exigences spécifiques à D&D 5e :
1. Le calcul de multiples instances de dégâts simultanées aux types distincts (par exemple, arme contondante + dégâts radiants).
2. La séquence stricte d'absorption : absorption par les PV temporaires (`hp.temp`), puis par les points de vie courants (`hp.current`).
3. Les règles de mort instantanée (`InstantDeath`) si le surplus de dégâts atteint ou dépasse les PV maximaux (`hp.max`), et l'attribution automatique d'échecs de jets de sauvegarde contre la mort (`DeathSavingThrow`) lorsqu'un acteur à 0 PV subit des dégâts (avec 2 échecs sur un coup critique).
4. L'émission déterministe d'un prompt d'invitation au jet de concentration (`ConcentrationCheckPrompt`) avec un Degré de Difficulté (DD) calculé par `Math.max(10, Math.floor(damageTaken / 2))` lorsqu'un acteur maintenant une concentration subit des dégâts.
5. La gestion déterministe des repos courts et longs incluant la dépense de dés de vie, la réinitialisation des réserves de ressources (`ResourcePool`), la récupération de la moitié des dés de vie au repos long et le traitement différencié des emplacements de sorts (magie classique vs pacte du Démoniste).
6. L'expiration temporelle ordonnée des conditions actives selon trois déclencheurs (`ROUNDS`, `TURNS_START`, `TURNS_END`) corrélée à l'acteur actif du tour.
7. La mise à disposition d'un compendium à 3 niveaux hiérarchiques (`SYSTEM_SRD` lecture seule, `INSTANCE_LIBRARY` partagée, `CAMPAIGN_HOMEBREW` surcharge prioritaire) conforme à la licence CC-BY-4.0.

## Décision d'Architecture

### 1. Frontière d'Exécution Rust/WASM vs TypeScript
Le crate Rust `crates/trame-engine` demeure 100 % agnostique à D&D 5e. Il fournit le moteur de graphe acyclique générique et la primitive d'atténuation élémentaire.
Toute la logique applicative D&D 5e est encapsulée dans `packages/game-systems/dnd5e` en modules TypeScript purs et typés sans état externe ni dépendance UI :
- `system.json` : manifeste système déclarant les types d'acteurs, caractéristiques, compétences et formules de calcul `derivedDAG`.
- `manifest.ts` : interfaces TypeScript, types d'identifiants stricts et schéma de l'acteur `Dnd5eActorData`.
- `pipeline.ts` : fonctions pures `resolveDamagePipeline`, `rollDeathSavingThrow`, `applyShortRest`, `applyLongRest` et `decrementConditionDurations`.
- `progression.ts` : tables et fonctions de progression des niveaux 1 à 20 (bonus de maîtrise, matrices d'emplacements de sorts pleins/demi/pacte et montée de niveau).
- `compendium.ts` : classe `CompendiumResolver` implémentant la recherche hiérarchique et la mention de licence légale CC-BY-4.0.

### 2. Pipeline de Dégâts Déterministe Multi-Types
La fonction `resolveDamagePipeline(actor, damageInstances, options)` s'exécute comme une fonction pure synchrone sans effet de bord :
1. Elle calcule l'atténuation pour chaque instance selon la règle : `IMMUNE` (0x) -> `RESISTANT` (`Math.floor(amount * 0.5)`) -> `VULNERABLE` (2x) -> neutre (1x).
2. Elle totalise les dégâts effectifs dans `totalDamage`.
3. Si `actor.attributes.hp.current === 0` :
   - Si `totalDamage >= actor.attributes.hp.max`, elle applique `instantDeath = true` et `failures = 3`.
   - Sinon, elle incrémente `failures` de 2 si `options.isCritical === true`, ou de 1 dans le cas contraire.
4. Si `actor.attributes.hp.current > 0` :
   - Elle déduit prioritairement les dégâts de `hp.temp`.
   - Elle applique le reliquat à `hp.current`.
   - Si `hp.current` atteint 0 et que le surplus de dégâts non absorbé atteint ou dépasse `hp.max`, elle déclenche `instantDeath = true`.
5. Si `actor.concentratingOnSpellId` est défini et que des dégâts effectifs ont été absorbés (`totalDamage > 0`), elle inclut dans le résultat un `concentrationPrompt` avec `dc = Math.max(10, Math.floor(totalDamage / 2))`.

### 3. Modélisation Déterministe des Réserves de Ressources et Repos
Le type `Dnd5eActorData` intègre le champ optionnel `resources: Record<string, ResourcePool>` où chaque réserve définit `{ current: number; max: number; resetOn: 'SHORT_REST' | 'LONG_REST' }`.
- `applyShortRest` permet la dépense interactive de dés de vie (`hitDieRoll + conMod`, minimum 1 PV regagné par dé), réinitialise toutes les ressources dont `resetOn === 'SHORT_REST'` et recharge les emplacements de magie de pacte au maximum.
- `applyLongRest` restaure l'intégralité des PV courants, réinitialise `hp.temp` à 0, récupère `Math.max(1, Math.floor(hitDiceMax / 2))` dés de vie, réduit le niveau d'épuisement de 1, réinitialise l'intégralité des emplacements de sorts et réinitialise toutes les ressources (`resetOn === 'SHORT_REST'` ou `resetOn === 'LONG_REST'`).

### 4. Décrémentation Temporelle des Conditions
La fonction pure `decrementConditionDurations(conditions, trigger, currentTurnActorId)` applique la règle d'isolation des tours :
- Lorsque `trigger` vaut `'TURNS_START'` ou `'TURNS_END'`, la durée `durationRounds` d'une condition décrémente d'une unité **uniquement si** `condition.appliedTurnActorId === currentTurnActorId`.
- Lorsque `trigger` vaut `'ROUNDS'`, toutes les conditions avec `durationRounds > 0` décrémentent d'une unité, indépendamment de l'acteur actif.
- Toute condition atteignant `durationRounds <= 0` est éliminée du tableau des conditions actives.

### 5. Compendium Hiérarchique à 3 Niveaux et Licence CC-BY-4.0
La classe `CompendiumResolver` garantit l'immuabilité du SRD de base :
- La cascade prioritaire applique : `CAMPAIGN_HOMEBREW` > `INSTANCE_LIBRARY` > `SYSTEM_SRD`.
- La déduplication des entrées s'effectue sur le champ `slug`.
- La recherche textuelle dans `list(query)` opère un filtrage insensible à la casse sur `entry.name` et `entry.slug`.
- La méthode `getAttribution()` retourne la notice de licence obligatoire de Wizards of the Coast LLC pour le SRD 5.1 sous licence CC-BY-4.0.

### 6. Stratégie de Test
Tous les tests unitaires et d'intégration du package sont rédigés pour le test runner natif de Node 24 (`node --test`), exécutables via `npm test` dans `packages/web` sans dépendance vers un serveur actif ou une interface graphique.

## Conséquences

### Positives
- **Séparation stricte** : Le moteur Rust `trame-engine` reste générique et indépendant des règles d'un jeu spécifique.
- **Déterminisme** : Toutes les règles D&D 5e sont des fonctions pures et sans effets de bord, facilement auditables et testables sous `node --test`.
- **Conformité juridique** : L'attribution Creative Commons CC-BY-4.0 est incluse au coeur du compendium et vérifiable par les tests.
- **Extensibilité Homebrew** : Les créateurs de campagnes peuvent surcharger toute entité sans risquer d'altérer la base de données SRD officielle.

### Négatives / Contraintes
- Le typage strict impose la définition de structures exhaustives pour l'ensemble des compétences (`SkillId`), caractéristiques (`AbilityId`) et rangs de maîtrise (`ProficiencyRank`).
- L'évaluation des tours de combat nécessite le passage explicite de l'identifiant de l'acteur du tour courant (`currentTurnActorId`) lors de l'appel à `decrementConditionDurations`.
