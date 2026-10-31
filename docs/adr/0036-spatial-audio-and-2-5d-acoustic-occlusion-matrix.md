# ADR-0036: 2.5D Acoustic Occlusion Model and Wall Permeability Matrix

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

## Consequences
- Physical consistency across visual rendering, line of sight, and spatial audio.
