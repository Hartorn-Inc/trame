# ADR 0036: Modèle d'Occlusion Acoustique 2.5D et Matrice de Perméabilité des Parois

## Statut
Accepté

## Contexte
L'immersion sonore dans TRAME repose sur `SpatialAudioManager` pour spatialiser les ambiances de donjon et les effets environnementaux. Auparavant, les obstacles bloquant la vue (murs) n'étaient pas couplés de manière univoque avec la propagation acoustique : un mur de verre (`WallType::Window`) bloquait le son ou laissait passer la lumière de manière incohérente, tandis que les portes ouvertes ou fermées n'altéraient pas dynamiquement l'atténuation du son.

De plus, le moteur géométrique 2.5D introduit des élévations (`bottom_elevation_ft`, `top_elevation_ft`). Les émetteurs audio spatiaux manquaient d'une coordonnée verticale explicite pour calculer l'occlusion lorsqu'un son provient d'un balcon ou d'une fosse.

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