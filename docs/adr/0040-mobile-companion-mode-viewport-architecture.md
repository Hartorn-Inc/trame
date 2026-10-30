# ADR 0040 : Découplage du Pipeline WebGL et Mode Compagnon Mobile

## Status
Accepted

## Context
L'application web TRAME intègre un moteur de rendu virtuel 2D lourd basé sur PixiJS v8, des nuanceurs de raycasting et des Framebuffer Objects (FBO) d'éclairage dynamique (`TableCanvas`). Sur les terminaux mobiles et smartphones (écrans `< 768px`), ce pipeline consomme une bande passante GPU et une mémoire excessives, provoquant des saccades, des surchauffes thermiques et des crashs de contexte WebGL.
L'issue #11 impose que tout viewport strictement inférieur à 768 pixels bascule automatiquement en Mode Compagnon Mobile avec un taux de rafraîchissement fluide sans jamais allouer le pipeline WebGL.

## Decision
1. **Seuil Déterministe de Découplage** :
   - Le seuil de déclenchement est fixé à une largeur d'affichage strictement inférieure à 768 pixels (`window.innerWidth < 768`).
2. **Bannissement du Montage WebGL sous 768px** :
   - Le composant `TableCanvas` (incluant l'application PixiJS, le SceneGraph et les FBOs d'éclairage) fait l'objet d'un chargement dynamique différé (`React.lazy`).
   - Lorsque le viewport est `< 768px`, `TableCanvas` n'est pas chargé et son nœud DOM n'est jamais monté.
   - Aucun contexte WebGL ou WebGPU n'est instancié.
3. **Navigation Tactile Mobile** :
   - Le composant racine `MobileCompanionLayout` est monté sous `< 768px`.
   - Il expose une barre de navigation inférieure proposant quatre destinations : `Sheet`, `Dice`, `Inventory`, `Journal`.
   - Pour le périmètre de l'issue #11, les onglets `Sheet`, `Dice` et `Inventory` affichent des conteneurs stables identifiés par `data-testid="tab-sheet"`, `data-testid="tab-dice"`, et `data-testid="tab-inventory"`, tandis que `Journal` monte `PartyJournalView` (`data-testid="tab-journal"`).

## Consequences
### Positive
- Empreinte mémoire minimale sur smartphone (zéro texture FBO ou contexte WebGL alloué).
- Défilement tactile fluide à 60 FPS sur les interfaces HTML/CSS pures.
- Testabilité unitaire et d'intégration déterministe sous Node.js natif sans mocks WebGL complexes.

### Negative / Trade-offs
- Les utilisateurs sur mobile ne peuvent pas observer le plateau de jeu tactique simultanément sans changer d'appareil ou agrandir la fenêtre.