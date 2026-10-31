# ADR 0036: Modèle d'Occlusion Acoustique 2.5D et Matrice de Perméabilité des Parois

## Status
Accepted

## Context
`SpatialAudioManager` spatializes dungeon ambiences and environmental sound effects. With 2.5D elevation bounds (`bottom_elevation_ft`, `top_elevation_ft`) and distinct wall types (`Window`, `Terrain`, `Door`, `SecretDoor`, `Illusion`), acoustic propagation must align deterministically with wall state and vertical elevation.

## Decision
1. **Vertical Emitter Coordinate**: `SpatialAudioEmitter` includes `elevation_ft: f32` to position each source in 3D space `(x, y, elevation_ft)`.
2. **Wall Permeability Matrix**:
   - `Normal`: Blocks vision, movement, and sound (`blocks_sound = true`).
   - `Window`: Blocks movement and sound (`blocks_sound = true`), transmits vision and light (`blocks_light = false`).
   - `Terrain`: Blocks movement and sound when both source and listener are below `top_elevation_ft`.
   - `Door` / `SecretDoor`: Blocks sound, vision, and movement when `Closed` or `Locked`; permeable when `Open`.
   - `Illusion`: Permeable to sound (`blocks_sound = false`), vision, and movement.
3. **2.5D `AcousticOcclusion` Raycast**: Each intersecting `WallSegment` whose `[bottom_elevation_ft, top_elevation_ft]` span crosses the 3D source-to-listener segment and has `blocks_sound == true` applies a `-12 dB` attenuation factor (`0.25x` linear gain) and an `800 Hz` low-pass filter.

## Décision
1. **Coordonnée Verticale pour les Émetteurs** : Ajouter `elevation_ft: f32` à `SpatialAudioEmitter` afin de situer rigoureusement la source en trois dimensions `(x, y, elevation_ft)`.
2. **Matrice Univoque d'Occlusion** :
   - `Normal` : Bloque vision, mouvement et son (`blocks_sound = true`).
   - `Window` : Bloque mouvement et son (`blocks_sound = true`), mais laisse passer la vision et la lumière dynamique (`blocks_light = false`).
   - `Terrain` : Barrière 2.5D bloquant mouvement et son si l'élévation de la source et de l'auditeur est inférieure à `top_elevation_ft`.
   - `Door` : Si fermée ou verrouillée, bloque son (`blocks_sound = true`), vision et mouvement. Si ouverte, perméable au son (`blocks_sound = false`), à la vision et au mouvement.
   - `SecretDoor` : Si fermée ou verrouillée, propriétés identiques à `Normal` (`blocks_sound = true`). Si ouverte, perméable au son (`blocks_sound = false`).
   - `Illusion` : Complètement perméable au son (`blocks_sound = false`), à la vision et au mouvement pour les calculs physiques du moteur.
3. **Calcul d'AcousticOcclusion 2.5D** : `SpatialAudioManager` trace un segment direct 3D entre la source `(x_e, y_e, z_e)` et le récepteur `(x_l, y_l, z_l)`. Si le segment intersecte un `WallSegment` dont l'intervalle altimétrique `[bottom_elevation_ft, top_elevation_ft]` couvre le rayon et dont `blocks_sound == true`, un coefficient d'atténuation exponentiel de -12 dB (facteur linéaire 0.25) est appliqué par mur traversé, couplé à un filtre passe-bas à 800 Hz.

## Conséquences
### Positives
- Cohérence physique rigoureuse entre l'affichage visuel, la ligne de vue et la perception auditive.
- Support complet des ambiances architecturales verticales (balcons, cryptes, meurtrières).

### Négatives
- Complexité accrue du calcul d'intersection 3D résolue par le BVH sur le thread audio client.