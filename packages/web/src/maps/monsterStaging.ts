/**
 * ============================================================================
 * SRD MONSTER STAGING FOR THE MAP STUDIO (maps/monsterStaging.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Turns an SRD compendium monster into a `StagedToken` of a prepared scene.
 * Before it, the studio staged plain 10 HP tokens named after a free-form
 * template key, so an activated encounter had no stat block: no AC, no
 * attacks, no saves.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Reference, Not Numbers`:
 *    - A staged monster carries `monster_template_id = srd:monster:<slug>`.
 *      `PUT .../maps` copies the server's own pack stat block from it, and
 *      activation applies HP, AC, speed, senses and actions from that copy.
 *      `hpCurrent` / `hpMax` here are display hints for the studio only.
 * 2. `Distinct Names`:
 *    - Names go through `uniqueNameAmong` over the scene's staged tokens, so
 *      three goblins become "Goblin", "Goblin 2" and "Goblin 3" in target
 *      lists and the initiative tracker.
 * 3. `One Creature Per Cell`:
 *    - `freeStagingTopLeft` walks square rings around the first spawn point
 *      and returns the first grid-aligned spot whose footprint overlaps no
 *      staged token and stays on the map, so stacked staging never hides a
 *      monster under another.
 * ============================================================================
 */
import { CompendiumResolver } from '../../../game-systems/dnd5e/src/index.ts';
import type { CompendiumEntry } from '../compendium/CompendiumDrawer.tsx';
import { monsterStatBlockOf } from '../compendium/CompendiumDrawer.tsx';
import type { Point2D } from '../engine/wasmBridge.ts';
import { uniqueNameAmong } from '../table/tableView.ts';
import { generateEntityUuid } from './domain.ts';
import type { CampaignMapScene, StagedToken } from './types.ts';

/** Prefix of SRD monster references (`srd:monster:goblin`), shared with the server. */
export const SRD_MONSTER_PREFIX = 'srd:monster:';

/** Quick-pick studio buttons and the SRD monster each one stages. */
export const QUICK_PICK_MONSTERS = [
  { key: 'Goblin', slug: 'goblin' },
  { key: 'Bandit', slug: 'bandit' },
  { key: 'Guard', slug: 'guard' },
  { key: 'Skeleton', slug: 'skeleton' },
  { key: 'Wolf', slug: 'wolf' },
  { key: 'Ogre', slug: 'ogre' },
] as const;

/** Grid footprint in cells per side for each SRD creature size (Tiny shares a cell's slot). */
const SIZE_CELLS: Record<string, number> = { tiny: 1, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 };

/** Rings searched around the spawn before falling back to the spawn cell itself. */
const MAX_SEARCH_RINGS = 40;

/** SRD monster entries of the compendium, the studio picker's list. */
export function srdMonsterEntries(entries: CompendiumEntry[] = CompendiumResolver.getDefault().list()): CompendiumEntry[] {
  return entries.filter((e) => e.entityType === 'monster' && e.id.startsWith(SRD_MONSTER_PREFIX) && monsterStatBlockOf(e) !== null);
}

/** The compendium entry of `srd:monster:<slug>`, or `null` before the SRD is loaded. */
export function srdMonsterEntry(slug: string): CompendiumEntry | null {
  return srdMonsterEntries().find((e) => e.id === `${SRD_MONSTER_PREFIX}${slug}`) ?? null;
}

/**
 * Top-left (scene px) of the first free `sizeCells`-wide square nearest the
 * scene's first spawn point (banner invariant 3). Rings are scanned row by
 * row, so ties resolve top-left first.
 */
export function freeStagingTopLeft(scene: CampaignMapScene, sizeCells: number): Point2D {
  const cell = scene.gridCellSizePx > 0 ? scene.gridCellSizePx : 70;
  const cols = Math.max(1, Math.floor(scene.widthPx / cell));
  const rows = Math.max(1, Math.floor(scene.heightPx / cell));
  const anchor = scene.spawnPoints?.[0] ?? scene.spawnPoint ?? { x: 0, y: 0 };
  const startCol = Math.min(cols - 1, Math.max(0, Math.floor(anchor.x / cell)));
  const startRow = Math.min(rows - 1, Math.max(0, Math.floor(anchor.y / cell)));
  const occupied = scene.stagedTokens.map((tok) => {
    const size = Math.max(1, tok.sizeCells ?? 1);
    const col = Math.floor(tok.x / cell);
    const row = Math.floor(tok.y / cell);
    return { col, row, size };
  });
  const fits = (col: number, row: number) =>
    col >= 0 &&
    row >= 0 &&
    col + sizeCells <= cols &&
    row + sizeCells <= rows &&
    occupied.every((o) => col + sizeCells <= o.col || o.col + o.size <= col || row + sizeCells <= o.row || o.row + o.size <= row);
  for (let ring = 0; ring <= MAX_SEARCH_RINGS; ring++) {
    for (let row = startRow - ring; row <= startRow + ring; row++) {
      for (let col = startCol - ring; col <= startCol + ring; col++) {
        const onRing = Math.max(Math.abs(col - startCol), Math.abs(row - startRow)) === ring;
        if (onRing && fits(col, row)) return { x: col * cell, y: row * cell };
      }
    }
  }
  return { x: startCol * cell, y: startRow * cell };
}

/**
 * A GM-hidden staged token for an SRD monster entry: SRD reference, unique
 * name, own free cell, footprint from the creature size.
 */
export function stageSrdMonster(scene: CampaignMapScene, entry: CompendiumEntry): StagedToken {
  const block = monsterStatBlockOf(entry);
  const sizeCells = SIZE_CELLS[block?.size ?? 'medium'] ?? 1;
  const at = freeStagingTopLeft(scene, sizeCells);
  const hp = block?.hitPoints.average;
  return {
    id: generateEntityUuid(),
    name: uniqueNameAmong(entry.name, scene.stagedTokens.map((tok) => tok.name)),
    templateKey: entry.id,
    monsterTemplateId: entry.id,
    x: at.x,
    y: at.y,
    elevationFt: scene.defaultGroundElevationFt ?? 0,
    visibilityChannel: 'GmHidden',
    ownerUserId: null,
    hpCurrent: hp,
    hpMax: hp,
    sizeCells,
  };
}
