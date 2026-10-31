# ADR-0035 : Architecture MobileCompanionView et Couche Présentationnelle i18n/Unités

- **Statut** : Accepté
- **Date** : 2025-05-18
- **Auteurs** : Équipe Architecture TRAME
- **Contexte** : Issue #80, ADR-0009

## Contexte

L'expérience sur smartphone ou tablette (`< 768px`) nécessite une interface tactile dédiée sans contexte WebGL/PixiJS afin de préserver la mémoire GPU et l'autonomie des terminaux mobiles (ADR-0009). Auparavant, `MobileCompanionLayout` et `HandoutRevealManager` étaient de simples classes TypeScript orphelines, non montées dans l'arborescence Preact (`App.tsx`).

Par ailleurs, les tables de jeu francophones ou mixtes requièrent une interface bilingue (`FR` / `EN`) et la conversion dynamique des mesures tactiques (`5 ft` $\leftrightarrow$ `1.5 m (1 case)`). Cette localisation ne doit en aucun cas corrompre les calculs géométriques et les slugs d'actions canoniques du moteur de règles Rust `trame-engine`.

## Décision

1. **Cycle de vie WebGL et basculement réactif de `MobileCompanionView`** :
   - `App.tsx` pilote le rendu via un computed signal réactif :
     `shouldMountCanvas = computed(() => !mobileCompanionOverrideSignal.value && windowWidthSignal.value >= 768)`.
   - Dès que `shouldMountCanvas.value === false` :
     1. Le canvas `TableCanvas` est démonté et l'application PixiJS est détruite via `app.destroy(true, { children: true, texture: false })` en vidant les textures et framebuffers GPU.
     2. Le composant Preact `MobileCompanionView` est monté dans le DOM avec ses 5 onglets tactiles (`Sheet`, `Dice`, `Inventory`, `Tracker`, `Journal`).
   - Lorsque le viewport repasse au-dessus de `768px` et que l'override est inactif, `TableCanvas` est réinstancié proprement.

2. **Couche de présentation i18n et conversion d'unités métriques** :
   - Le module `packages/web/src/i18n/` agit strictement comme une couche de présentation réactive basée sur `@preact/signals`.
   - Deux signaux réactifs globaux sont exposés : `localeSignal` (`'en' | 'fr'`) et `unitSystemSignal` (`'imperial_ft' | 'metric_m'`).
   - La conversion des distances s'effectue via la fonction pure `formatDistanceFt(feet)` :
     - En système impérial : `${feet} ft`.
     - En système métrique : `${feet * 0.3} m (${squares} ${squares <= 1 ? 'case' : 'cases'})` où `squares = Math.round(feet / 5)`.
   - Tous les protocoles réseau (WebSocket `ClientEnvelope`/`ServerEnvelope`), structures Rust et slugs de règles restent exclusivement en anglais canonique et en unités standard (pieds).
   - La recherche dans le Compendium intègre un dictionnaire bilingue bidirectionnel associant les termes traduits (ex. *Furtivité*, *Boule de feu*) aux clés canoniques sous-jacentes (*stealth*, *fireball*).

## Conséquences

### Positives
- Zéro fuite de mémoire GPU sur terminaux mobiles grâce à la destruction contrôlée de l'instance PixiJS.
- Expérience utilisateur native pour les joueurs mobiles sur table physique.
- Intégrité absolue des calculs du moteur Rust et des protocoles réseau.

### Négatives / Contraintes
- Le basculement dynamique mobile/desktop implique un cycle de réinitialisation complet du canvas WebGL.
- Tous les composants d'affichage tactile doivent consommer `formatDistanceFt` et les clés de traduction `t(key)`.
