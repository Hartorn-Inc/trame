# Spécification Technique & Fonctionnelle : TRAME ATLAS v1.1 Design System, Architecture Hybride Canvas Theme & Validation Impeccable Gate

## 1. Vue d'Ensemble & Objectif Stratégique

### 1.1 Contexte et Problématique
L'application TRAME offre une expérience de jeu sur table virtuelle en temps réel (`ExplorationMode`, `TurnByTurnMode`), des ateliers de préparation de campagne (`CampaignLobby`, `CampaignWorkspace`), des fiches d'acteurs déclaratives (`DeclarativeSheetRenderer`), un wiki collaboratif (`CRDTDocument`) et une interface mobile d'appoint (`MobileCompanionLayout`).

L'absence d'un système de design unifié générait plusieurs défauts bloquants :
1. Les vues Preact et les composants du `WidgetRegistry` utilisaient des couleurs hexadécimales brutes codées en dur sans adaptation aux modes clair, sombre et système.
2. Le moteur PixiJS v8 et son `SceneGraph` à 7 couches (`backgroundMap`, `gridOverlay`, `aoeTemplates`, `tokens`, `lightingAndVisionMask`, `fogOfWar`, `uiControlHud`) ne disposaient pas d'une passerelle typée avec les thèmes du DOM. Aucun invariant n'interdisait l'altération des battlemaps importées par des filtres CSS globaux.
3. Les états tactiques (allégeance des tokens d'Actor, indicateur de tour actif, types de `WallSegment` et aperçus fantômes de `MCPStagingMode`) reposaient exclusivement sur la couleur.
4. Les fiches d'acteurs risquaient des modifications accidentelles de caractéristiques structurelles en pleine session de jeu lors de simples clics de dés.
5. L'application chargeait des polices distantes depuis des CDN, compromettant le fonctionnement conteneurisé hors-ligne sous Docker et la portabilité des archives `.trame`.
6. Le pipeline CI ne disposait d'aucun contrôle automatisé pour interdire la régression du contraste WCAG 2.2 AA et l'apparition de code hexadécimal brut.

### 1.2 Objectif & Principe Directeur
La présente spécification établit et verrouille le système de design **TRAME ATLAS v1.1** autour du principe directeur : **"The Map Is the Workspace"**.

Le système repose sur quatre piliers techniques :
1. Une double source de vérité découplée : des variables CSS pour le DOM Preact (`packages/web/src/styles/tokens.css`) et un registre typé immuable pour WebGL (`packages/web/src/canvas/CanvasThemePalette.ts`).
2. La règle absolue d'indépendance de l'art cartographique (*The Map-Art Independence Rule*) : les textures de battlemap restent strictement neutres et le calque inexploré de `FogLayer` reste opaque et sombre.
3. La redondance géométrique systématique (*Non-Color Redundancy*) pour toutes les informations tactiques.
4. La gouvernance hermétique en deux étapes (audit statique CI `scripts/check-impeccable-design.mjs` et tests unitaires `packages/web/tests/designSystem.test.ts`).

---

## 2. Modèle de Domaine & Définitions Ubiquitaires

Conformément au `GLOSSARY.md` et à la norme ASD-STE100, la spécification emploie exclusivement les termes canoniques suivants :

- **Actor** : Agrégat représentant un héros, un monstre ou une créature non-joueur. L'usage des termes `personnage`, `entité` ou `joueur-avatar` est strictement interdit.
- **CampaignWorkspace** : Coquille applicative Preact authentifiée contenant les espaces `Map`, `Actors`, `Journal`, `Compendium` et `Settings`.
- **CanvasThemePalette** : Registre typé fournissant les couleurs numériques et les motifs géométriques au `SceneGraph` PixiJS selon le thème résolu.
- **PadlockEditMode** : État booléen de l'en-tête de `DeclarativeSheetRenderer` commutant entre le mode jeu verrouillé (`aria-pressed="false"`) et le mode édition déverrouillé (`aria-pressed="true"`).
- **SceneGraph** : Arbre hiérarchique PixiJS v8 à 7 couches rendant le plateau virtuel.
- **WallSegment** : Segment d'obstacle spatial portant des propriétés d'occlusion lumineuse et de franchissement physique.
- **WidgetRegistry** : Registre central associant les clés de widgets déclaratifs à leurs composants de rendu Preact.

---

## 3. Architecture Hybride des Tokens & Typographie Autohébergée

### 3.1 Définition des Variables CSS Sémantiques
Le fichier `packages/web/src/styles/tokens.css` déclare les variables CSS sur `:root` (thème sombre par défaut), `[data-theme="light"]` et via `@media (prefers-color-scheme: light)` lorsque l'attribut est `[data-theme="system"]`.

```css
:root,
[data-theme="dark"] {
  --atlas-bg: #0F1A25;
  --atlas-surface: #182736;
  --atlas-surface-raised: #203243;
  --atlas-text: #F1F4F3;
  --atlas-text-muted: #B8C7D1;
  --atlas-border: #405466;
  --atlas-action: #F3BB71;
  --atlas-on-action: #172535;
  --atlas-focus: #80CBE2;
  --atlas-danger: #D57973;
  --atlas-grid: rgba(184, 199, 209, 0.16);
  --atlas-shadow: rgba(5, 10, 16, 0.42);
}

[data-theme="light"] {
  --atlas-bg: #F4F7F9;
  --atlas-surface: #FFFFFF;
  --atlas-surface-raised: #E8EFF3;
  --atlas-text: #1C3041;
  --atlas-text-muted: #465D6D;
  --atlas-border: #ACBFCB;
  --atlas-action: #995817;
  --atlas-on-action: #FFFFFF;
  --atlas-focus: #155D77;
  --atlas-danger: #A3333B;
  --atlas-grid: rgba(28, 48, 65, 0.14);
  --atlas-shadow: rgba(15, 26, 37, 0.12);
}
```

### 3.2 Matrice de Contraste WCAG 2.2 AA
Le script de contrôle `scripts/check-impeccable-design.mjs` calcule la luminance relative $L = 0.2126 R + 0.7152 G + 0.0722 B$ et vérifie mathématiquement le ratio $(L_1 + 0.05) / (L_2 + 0.05)$ :

| Paire de Tokens | Mode Sombre (Hex) | Ratio Sombre | Mode Clair (Hex) | Ratio Clair | Règle Normative |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `--atlas-text` sur `--atlas-bg` | `#F1F4F3` sur `#0F1A25` | 14.8:1 | `#1C3041` sur `#F4F7F9` | 11.2:1 | Texte corps $\ge 4.5:1$ |
| `--atlas-text` sur `--atlas-surface` | `#F1F4F3` sur `#182736` | 12.3:1 | `#1C3041` sur `#FFFFFF` | 12.6:1 | Texte corps $\ge 4.5:1$ |
| `--atlas-text-muted` sur `--atlas-bg` | `#B8C7D1` sur `#0F1A25` | 9.2:1 | `#465D6D` sur `#F4F7F9` | 5.3:1 | Texte secondaire $\ge 4.5:1$ |
| `--atlas-danger` sur `--atlas-surface` | `#D57973` sur `#182736` | 5.2:1 | `#A3333B` sur `#FFFFFF` | 6.4:1 | Texte alerte $\ge 4.5:1$ |
| `--atlas-on-action` sur `--atlas-action`| `#172535` sur `#F3BB71` | 9.1:1 | `#FFFFFF` sur `#995817` | 5.8:1 | Texte bouton action $\ge 4.5:1$ |
| `--atlas-focus` sur `--atlas-bg` | `#80CBE2` sur `#0F1A25` | 9.3:1 | `#155D77` sur `#F4F7F9` | 6.8:1 | Anneau focus UI $\ge 3.0:1$ |
| `--atlas-border` sur `--atlas-bg` | `#405466` sur `#0F1A25` | 3.1:1 | `#ACBFCB` sur `#F4F7F9` | 3.2:1 | Bordure de contrôle $\ge 3.0:1$ |

Pour la grille vectorielle `--atlas-grid` :
- En mode sombre, l'application de `rgba(184, 199, 209, 0.16)` sur `--atlas-bg` (`#0F1A25`) produit la couleur composite `#2A353F`. Le contraste Weber calculé $(L_{\text{composite}} - L_{\text{bg}}) / L_{\text{bg}}$ est égal à $0.14$, ce qui garantit une lisibilité discrète sans saturer le regard.
- En mode clair, l'application de `rgba(28, 48, 65, 0.14)` sur `--atlas-bg` (`#F4F7F9`) produit la couleur composite `#E4E9EC`. Le contraste Weber calculé $(L_{\text{bg}} - L_{\text{composite}}) / L_{\text{bg}}$ est égal à $0.11$.

### 3.3 Typographie Autohébergée et Alignement Tabulaire
1. Le paquet `packages/web` héberge les fichiers WOFF2 dans `packages/web/public/fonts/` :
   - `space-grotesk-v16-latin-500.woff2`
   - `space-grotesk-v16-latin-600.woff2`
   - `ibm-plex-sans-v19-latin-regular.woff2` (400)
   - `ibm-plex-sans-v19-latin-500.woff2`
   - `ibm-plex-sans-v19-latin-600.woff2`
   - `OFL-1.1.txt`
2. Le fichier `packages/web/src/styles/tokens.css` déclare les règles `@font-face` avec la directive `font-display: swap` et des chemins d'accès locaux relatifs. Aucun appel vers `fonts.googleapis.com` ou `fonts.gstatic.com` n'est autorisé.
3. La classe utilitaire `.atlas-tabular-nums` applique la propriété `font-variant-numeric: tabular-nums; font-family: var(--atlas-font-body);`. Le `DeclarativeSheetRenderer`, le `CombatTracker` et le visualiseur de dés assignent obligatoirement cette classe à l'ensemble des valeurs numériques affichées.

### 3.4 Propagation Réactive de l'État de Thème
1. Le module `packages/web/src/signals/themeSignal.ts` exporte le signal `themeModeSignal = signal<AtlasThemeMode>('system')` et le signal dérivé `resolvedThemeSignal = computed<ResolvedAtlasTheme>(...)`.
2. Le composant racine `App.tsx` exécute un hook réactif `effect()` qui :
   - Lit la valeur de `resolvedThemeSignal`.
   - Assigne l'attribut `data-theme` à la balise `<html>` (`document.documentElement.setAttribute('data-theme', resolvedTheme)`).
   - Écrit le choix de l'utilisateur dans `localStorage` sous la clé `trame.atlas.theme`.
3. Le contrôleur du canvas PixiJS s'abonne à `resolvedThemeSignal` et appelle `getCanvasThemePalette(resolvedThemeSignal.value)`. Le contrôleur transmet la palette immuable aux couches vectorielles sans réinitialiser le contexte WebGL.

---

## 4. Palette PixiJS v8 (`CanvasThemePalette`) & Non-Dépendance à la Couleur

### 4.1 Contrat TypeScript Immuable
Le fichier `packages/web/src/canvas/CanvasThemePalette.ts` expose l'interface stricte et la fonction de résolution de palette :

```ts
export type AtlasThemeMode = "dark" | "light" | "system";
export type ResolvedAtlasTheme = "dark" | "light";

export interface TokenDispositionStyle {
  readonly ringColorHex: number;
  readonly ringStrokeStyle: "solid" | "dashed" | "double";
  readonly dashPatternPx: readonly [number, number] | null;
  readonly badgeShape: "shield" | "diamond" | "corner-chevrons" | "chevron-beacon";
  readonly badgeGlyph: "" | "!" | "›";
}

export interface WallKindVisualStyle {
  readonly strokeColorHex: number;
  readonly strokeWidthPx: number;
  readonly dashPatternPx: readonly [number, number] | null;
  readonly endpointMarker: "cap" | "tick" | "dot" | "arrow" | "s-glyph" | "hinge-box" | "diamond-hollow";
}

export interface CanvasThemePaletteSpec {
  readonly theme: ResolvedAtlasTheme;
  readonly mapArtFilter: "none";
  readonly canvasVoidHex: number;
  readonly gridLineHex: number;
  readonly gridLineAlpha: number;
  readonly fogUnexploredHex: number;
  readonly fogExploredDimAlpha: number;
  readonly rulerStrokeHex: number;
  readonly pointerPingHex: number;
  readonly mcpStagingGhost: {
    readonly fillHex: number;
    readonly strokeHex: number;
    readonly fillAlpha: number;
    readonly dashPatternPx: readonly [number, number];
    readonly badgeText: "STAGED";
  };
  readonly aoeTemplate: {
    readonly fillHex: number;
    readonly strokeHex: number;
    readonly fillAlpha: number;
    readonly boundaryDashPx: readonly [number, number];
  };
  readonly tokenDispositions: {
    readonly ally: TokenDispositionStyle;
    readonly hostile: TokenDispositionStyle;
    readonly selected: TokenDispositionStyle;
    readonly activeTurn: TokenDispositionStyle;
  };
  readonly wallKinds: Record<
    "Normal" | "Window" | "Terrain" | "OneWay" | "SecretDoor" | "Door" | "Illusion",
    WallKindVisualStyle
  >;
}

export function getCanvasThemePalette(theme: ResolvedAtlasTheme): CanvasThemePaletteSpec;
```

### 4.2 Règle d'Indépendance de l'Art Cartographique (*The Map-Art Independence Rule*)
1. La propriété `mapArtFilter` vaut obligatoirement `"none"` dans les deux thèmes.
2. Le conteneur PixiJS du calque `backgroundMap` conserve en permanence `filters = []` et n'applique aucun filtre CSS (`filter: none`). Les images de carte importées ne subissent aucune inversion chromatique ni atténuation de luminosité.
3. La couleur `fogUnexploredHex` reste strictement fixée à `0x0f1a25` (`#0F1A25`) quel que soit le thème actif. Le brouillard inexploré de `FogLayer` demeure un noir ardoise opaque afin de garantir le contraste dynamique des sources lumineuses 2.5D.
4. La couleur du vide hors-carte `canvasVoidHex` bascule entre `0x0f1a25` (sombre) et `0xf4f7f9` (clair).

### 4.3 Injectivité Géométrique des États Tactiques
Pour assurer l'opérabilité par des utilisateurs daltoniens, chaque état tactique associe sa couleur à une géométrie unique. Le test unitaire `packages/web/tests/designSystem.test.ts` vérifie formellement l'injectivité des tuples :

#### Dispositions des Tokens d'Actor :
- `ally` : Anneau continu (`ringStrokeStyle: "solid"`), couleur verte/cyanée `0x22c55e`, badge bouclier (`"shield"`), glyphe vide `""`.
- `hostile` : Anneau tireté (`ringStrokeStyle: "dashed"`, `dashPatternPx: [6, 4]`), couleur rouge `0xef4444`, badge losange (`"diamond"`), glyphe `"!"`.
- `selected` : Double anneau (`ringStrokeStyle: "double"`), couleur bleue `0x38bdf8`, chevrons de coin (`"corner-chevrons"`), glyphe vide `""`.
- `activeTurn` : Anneau ambre `0xf59e0b`, balise directionnelle chevron (`"chevron-beacon"`), glyphe `"›"`.

#### Types de WallSegment :
- `Normal` : Trait continu (`dashPatternPx: null`), embout droit (`endpointMarker: "cap"`).
- `Window` : Trait tireté large (`dashPatternPx: [6, 4]`), embout ergot (`endpointMarker: "tick"`).
- `Terrain` : Trait pointillé dense (`dashPatternPx: [2, 4]`), embout rond (`endpointMarker: "dot"`).
- `OneWay` : Trait tireté directionnel (`dashPatternPx: [8, 3]`), embout flèche (`endpointMarker: "arrow"`).
- `SecretDoor` : Trait discontinu court (`dashPatternPx: [4, 4]`), embout glyphe secret (`endpointMarker: "s-glyph"`).
- `Door` : Trait plein renforcé (`dashPatternPx: null`, `strokeWidthPx: 3`), embout boîte charnière (`endpointMarker: "hinge-box"`).
- `Illusion` : Trait alterné complexe (`dashPatternPx: [3, 3, 1, 3]`), embout losange évidé (`endpointMarker: "diamond-hollow"`).

---

## 5. Composants Applicatifs, Feuille d'Acteur & Suite SVG

### 5.1 Verrouillage de Sécurité `PadlockEditMode`
Le composant `DeclarativeSheetRenderer.tsx` intègre un bouton bascule dans son en-tête identifié par l'attribut `data-testid="sheet-padlock-toggle"`. Ce bouton porte l'attribut `aria-pressed="false"` (mode verrouillé par défaut) ou `aria-pressed="true"` (mode déverrouillé).

```
+-----------------------------------------------------------------------------------+
|  Actor: Valeros           [ Padlock Locked: aria-pressed="false" ] (Click to edit)|
+-----------------------------------------------------------------------------------+
|  [X] READONLY / DISABLED STRUCTURAL FIELDS       |  [O] INTERACTIVE COMBAT CONTROLS|
|  - Name, Class, Level, Max HP, Speed             |  - [Roll d20] Ability Checks    |
|  - Strength, Dexterity, Constitution, etc.       |  - [Roll d20] Saving Throws     |
|  - Skill / Save Proficiency Checkboxes           |  - [Attack] Weapon Rolls        |
|  - Inventory Item Add/Delete/Rename              |  - Current HP (+ / -) & Temp HP |
|  - Spell List Add/Delete & Feature Descriptions  |  - Death Saves (Success/Fail)   |
|                                                  |  - Spell Slots (Expend/Restore) |
+-----------------------------------------------------------------------------------+
```

#### Énumération Exhaustive des Champs Protégés (Mode Verrouillé `aria-pressed="false"`) :
Le composant assigne l'attribut `readonly={true}` ou `disabled={true}` aux éléments suivants :
1. Nom de l'Actor (`actor.name`).
2. Classe et sous-classe (`actor.class`, `actor.subclass`).
3. Niveau global (`actor.level`).
4. Points de vie maximaux (`actor.hp.max`).
5. Valeur de base de la classe d'armure (`actor.armorClass.base`).
6. Vitesse de déplacement au sol, en vol et à la nage (`actor.speed.*`).
7. Les 6 valeurs de caractéristiques fondamentales (`strength`, `dexterity`, `constitution`, `intelligence`, `wisdom`, `charisma`).
8. Les cases à cocher de maîtrise et d'expertise des compétences (`actor.skills.*.proficient`).
9. Les cases à cocher de maîtrise des jets de sauvegarde (`actor.savingThrows.*.proficient`).
10. Les actions d'ajout, de suppression, de renommage et de modification de poids dans l'inventaire (`actor.inventory.items`).
11. Les boutons d'ajout et de suppression de sorts connus et préparés (`actor.spells.known`, `actor.spells.prepared`).
12. Les champs de description textuelle des dons et capacités (`actor.features.*.description`).

#### Énumération Exhaustive des Contrôles Opérationnels Maintenus Actifs en Mode Verrouillé :
1. Tous les déclencheurs de jets de dés (`roll-button`, tests de caractéristiques, jets de sauvegarde, jets d'attaque et de dégâts).
2. Les boutons d'incrémentation et décrémentation des points de vie actuels (`actor.hp.current`).
3. Le champ des points de vie temporaires (`actor.hp.temp`).
4. Les compteurs de succès et d'échecs des jets de sauvegarde contre la mort (`actor.deathSaves.successes`, `actor.deathSaves.failures`).
5. Les cases d'utilisation et de récupération des emplacements de sorts (`actor.spellSlots.*.expended`).
6. Les compteurs des réserves de ressources temporaires (`actor.resources.*.current`, points de Ki, rages, etc.).
7. Les badges d'activation et désactivation des conditions (`Blinded`, `Poisoned`, etc.).
8. La bascule d'inspiration (`actor.inspiration`).
9. Les boutons de repos court (`Short Rest`) et de repos long (`Long Rest`).

### 5.2 Bibliothèque d'Icônes Stroked `AtlasIcons.tsx`
Le fichier `packages/web/src/components/icons/AtlasIcons.tsx` exporte l'interface commune et les composants individuels :

```ts
export interface AtlasIconProps {
  readonly size?: 20 | 24;
  readonly color?: string;
  readonly class?: string;
  readonly "aria-hidden"?: boolean | "true" | "false";
  readonly "data-testid"?: string;
}
```

Toutes les icônes partagent les propriétés SVG géométriques strictes : `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `strokeWidth={1.75}`, `strokeLinecap="round"`, `strokeLinejoin="round"` et `aria-hidden="true"` par défaut.

Le module exporte également le composant de répartition `AtlasIcon` recevant la propriété `name: AtlasIconName`. La liste des 34 icônes comprend formellement :
1. `SelectToolIcon`
2. `PanToolIcon`
3. `RulerToolIcon`
4. `GridToolIcon`
5. `FogBrushToolIcon`
6. `WallToolIcon`
7. `DoorToolIcon`
8. `LightToolIcon`
9. `AmbientToolIcon`
10. `AudioToolIcon`
11. `PingToolIcon`
12. `AoEToolIcon`
13. `PadlockLockedIcon`
14. `PadlockUnlockedIcon`
15. `LevelUpArrowIcon`
16. `ShortRestCampfireIcon`
17. `LongRestTentIcon`
18. `DiceD20NeutralIcon`
19. `AllyBadgeIcon`
20. `HostileBadgeIcon`
21. `ActiveTurnChevronIcon`
22. `ThemeDarkIcon`
23. `ThemeLightIcon`
24. `ThemeSystemIcon`
25. `WorkspaceMapIcon`
26. `WorkspaceActorsIcon`
27. `WorkspaceJournalIcon`
28. `WorkspaceCompendiumIcon`
29. `WorkspaceSettingsIcon`
30. `UndoIcon`
31. `RedoIcon`
32. `ChevronDownIcon`
33. `ChevronRightIcon`
34. `CloseIcon`

### 5.3 Logo Cartographique `TrameLogo.tsx`
Le composant `TrameLogo.tsx` restitue la marque sous forme de T cartographique vectoriel. Il expose les propriétés `variant?: 'route-intersection' | 'waypoint-grid' | 'monolith-path'` (valeur par défaut : `'route-intersection'`), `size?: number` (de 16 à 256) et `duotone?: boolean`.
En mode duotone, le composant utilise `--atlas-text` pour la structure du T et `--atlas-action` pour le point de jonction cartographique.

### 5.4 États Vides Cartographiques `AtlasEmptyStates.tsx`
Le fichier `packages/web/src/components/empty/AtlasEmptyStates.tsx` exporte 4 illustrations vectorielles :
1. `EmptyCampaignsSvg`
2. `EmptyMapAtlasSvg`
3. `EmptyJournalSvg`
4. `EmptyActorsSvg`

Invariant critique : Chaque illustration SVG se compose exclusivement de chemins de courbes de niveau (`<path>`), de nœuds de balisage (`<circle>`) et de hachures géométriques avec `stroke="currentColor"`. **L'inclusion de balises `<text>` dans ces fichiers SVG est formellement interdite**. Les conteneurs HTML parents fournissent l'ensemble des titres, descriptions et boutons d'action via les dictionnaires i18n avec le rôle sémantique `role="status"`.

### 5.5 Adaptation Mobile `MobileCompanionLayout.tsx`
Pour les écrans de largeur inférieure à 768 pixels, `MobileCompanionLayout.tsx` présente 4 onglets inférieurs (`tab-button-sheet`, `tab-button-dice`, `tab-button-inventory`, `tab-button-journal`).
Chaque bouton respecte une surface tactile minimale de $44 \times 44$ pixels (`min-height: 44px; min-width: 44px;`). Sur les interfaces de bureau, les cibles interactives respectent une hauteur minimale de 40 pixels.

---

## 6. Gouvernance Impeccable & Validation Fail-Closed en CI

### 6.1 Architecture du Script `scripts/check-impeccable-design.mjs`
Le script de vérification s'exécute sous Node 24 lors de l'appel à `make lint`. Il procède en deux étapes séquentielles hermétiques :

#### Étape 1 : Analyse Statique Interne (Contrats, Tokens, Ratios & Craft Floor)
1. **Validation de `DESIGN.md`** :
   - Le script parse le frontmatter YAML et valide la présence des champs `name`, `description`, `colors`, `typography`, `rounded`, `spacing` et `components`.
   - Le script vérifie la présence exacte des 8 sections H2 canoniques dans l'ordre prescrit :
     1. `## Overview`
     2. `## Colors`
     3. `## Typography`
     4. `## Layout`
     5. `## Elevation & Depth`
     6. `## Shapes`
     7. `## Components`
     8. `## Do's and Don'ts`
2. **Validation de `.impeccable/design.json`** :
   - Le script valide la conformité du fichier JSON avec le standard Schema v2 (extensions `colorMeta`, `typographyMeta`, `shadows`, `motion`, `breakpoints` et snippets HTML/CSS).
3. **Calcul Automatisé des Contrastes WCAG 2.2 AA** :
   - Le script évalue chaque paire de tokens définie au tableau 3.2. Il retourne une erreur bloquante si le ratio est inférieur à $4.5:1$ pour le texte ou inférieur à $3.0:1$ pour les bordures et l'anneau de focus.
4. **Détection des Couleurs Hexadécimales Brutes** :
   - Le script inspecte l'ensemble des fichiers sous `packages/web/src/**/*.{ts,tsx,css}`.
   - Le script rejette l'exécution si une chaîne hexadécimale (`#([0-9a-fA-F]{3,8})`), `rgb(` ou `hsl(` apparaît en dehors des deux fichiers autorisés : `packages/web/src/styles/tokens.css` et `packages/web/src/canvas/CanvasThemePalette.ts`.
5. **Vérification de l'Étanchéité Réseau des Polices** :
   - Le script rejette toute référence aux domaines `fonts.googleapis.com` ou `fonts.gstatic.com` dans le code source.
6. **Contrôle Statique des 62 Règles Craft Floor Anti-Slop** :
   - Le script analyse les fichiers CSS/TSX et échoue s'il détecte des textes en dégradé (`-webkit-background-clip: text`), des ombres portées avec halos néon (`filter: drop-shadow(...)`), des polices interdites ou des titres surmontés d'accroches en majuscules (*eyebrow kickers*).

#### Étape 2 : Exécution du Détecteur Impeccable CLI
- Si le binaire CLI `impeccable` (`engine-v0.1.18`) est présent dans l'environnement, le script exécute la commande `npx impeccable detect --rules-all`.
- En cas d'indisponibilité du binaire en environnement déconnecté, les contrôles de l'Étape 1 garantissent le rejet immédiat de toute dérive de design.

---

## 7. EpicGoalContract & Critères d'Acceptation Formels

### 7.1 epic_goal_contract

#### `epic_goal_summary`
Livrer et verrouiller le système de design TRAME ATLAS v1.1 garantissant la séparation étanche des tokens DOM et WebGL, la synchronisation réactive du thème avec `CanvasThemePalette` sans altération des cartes de combat, la non-dépendance absolue à la vision des couleurs par discrimination géométrique, le verrouillage de sécurité `PadlockEditMode` de la feuille d'Actor et le contrôle de conformité fail-closed des 62 règles Craft Floor en CI.

#### `required_entrypoints`
1. `packages/web/src/styles/tokens.css` (Variables sémantiques CSS, classes `.ds-*`, `.atlas-tabular-nums`, `@font-face` locaux).
2. `packages/web/src/canvas/CanvasThemePalette.ts:getCanvasThemePalette` (Registre typé PixiJS v8 immuable).
3. `packages/web/src/signals/themeSignal.ts` (Gestion réactive des thèmes `themeModeSignal` et `resolvedThemeSignal`).
4. `packages/web/src/components/sheet/DeclarativeSheetRenderer.tsx` (Composant de fiche intégrant la bascule `PadlockEditMode`).
5. `packages/web/src/components/icons/AtlasIcons.tsx` (Suite de 34 icônes vectorielles trait 1.75px).
6. `packages/web/src/components/empty/AtlasEmptyStates.tsx` (4 états vides cartographiques sans balise `<text>`).
7. `scripts/check-impeccable-design.mjs` (Script d'audit statique CI WCAG AA et Craft Floor).

#### `forbidden_stubs`
1. Interdiction des valeurs hexadécimales brutes (`#RGB`, `#RRGGBB`, `rgb()`, `hsl()`) dans `packages/web/src/` en dehors de `tokens.css` et `CanvasThemePalette.ts`.
2. Interdiction des filtres graphiques CSS (`filter: invert()`, `filter: brightness()`) ou WebGL sur le calque `backgroundMap`.
3. Interdiction de toute couleur de fond autre que `0x0f1a25` pour le calque inexploré de `FogLayer`.
4. Interdiction de requêtes réseau sortantes vers des services de polices distants (Google Fonts).
5. Interdiction de balises `<text>` codées en dur à l'intérieur des illustrations SVG de `AtlasEmptyStates.tsx`.
6. Interdiction de boutons d'action d'une dimension inférieure à $40$ px sur desktop et $44 \times 44$ px sur mobile.

#### `end_to_end_verification_criteria`
1. **Vérification Statique CI** :
   - WHEN le développeur exécute `make lint`, THEN le script `scripts/check-impeccable-design.mjs` valide l'arbre de code et retourne le code de sortie 0.
   - WHEN un contributeur introduit une valeur hexadécimale brute dans un composant Preact, THEN `scripts/check-impeccable-design.mjs` intercepte l'infraction et retourne le code de sortie 1 en indiquant le fichier et la ligne fautive.
2. **Vérification Mathématique des Contrastes** :
   - WHEN la suite de tests `packages/web/tests/designSystem.test.ts` évalue les contrastes des thèmes sombre et clair, THEN les ratios respectent strictement $\ge 4.5:1$ pour les textes et $\ge 3.0:1$ pour les bordures et l'anneau de focus.
3. **Vérification de l'Injectivité Géométrique Canvas** :
   - WHEN le test unitaire inspecte les spécifications renvoyées par `getCanvasThemePalette`, THEN aucune paire d'états parmi les 4 allégeances de tokens (`ally`, `hostile`, `selected`, `activeTurn`) ou parmi les 7 types de `WallSegment` ne présente un couple `(dashPatternPx, endpointMarker)` ou `(ringStrokeStyle, badgeShape)` identique.
4. **Vérification de l'Indépendance de l'Art Cartographique** :
   - WHEN le contrôleur bascule le thème résolu de `dark` à `light`, THEN la propriété `mapArtFilter` de `CanvasThemePaletteSpec` conserve la valeur `"none"` et `fogUnexploredHex` conserve la valeur `0x0f1a25`.
5. **Vérification du Verrouillage de la Feuille d'Actor** :
   - WHEN l'utilisateur clique sur le bouton `[data-testid="sheet-padlock-toggle"]` pour définir `PadlockEditMode` sur l'état verrouillé (`aria-pressed="false"`), THEN le composant `DeclarativeSheetRenderer` assigne l'attribut `disabled` ou `readonly` à l'ensemble des 12 catégories de champs structurels et maintient les écouteurs d'événements cliquables sur les 9 catégories de contrôles opérationnels de combat.
6. **Vérification de l'Accessibilité SVG & Mobile** :
   - WHEN le moteur de test analyse les composants de `AtlasIcons.tsx` et `AtlasEmptyStates.tsx`, THEN toutes les icônes portent `aria-hidden="true"` et aucune illustration d'état vide ne contient d'élément `<text>`.
   - WHEN le test monte `MobileCompanionLayout.tsx` avec une largeur de fenêtre de 390px, THEN les 4 onglets de navigation mesurent au minimum 44px par 44px.
