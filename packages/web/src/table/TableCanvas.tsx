/**
 * ============================================================================
 * TACTICAL TABLE BOARD (table/TableCanvas.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Renders the active scene (battlemap image plus grid) and every token the
 * recipient's projection contains, and turns pointer and keyboard input into
 * `MOVE_TOKEN` commands. A token click selects the token and its linked actor
 * (`selectedTokenIdSignal`, `selectedActorIdSignal`), which drives the sheet
 * drawer and the damage/heal controls.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Server-Authoritative Movement`:
 *    - The board never moves a token locally; it submits `MOVE_TOKEN` and
 *      re-renders from the next `CommandAccepted` snapshot. A rejected move
 *      (wall, speed budget, turn lock) leaves the token where it was.
 * 2. `Controlled Tokens Only`:
 *    - Move input is accepted for tokens in `tokens` (controlled); public
 *      tokens can be selected (to read their health tier) but not moved.
 * 3. `Accessible Tokens`:
 *    - Every token is a real `<button>` with a name + health label and
 *      `aria-pressed`; arrow keys move the focused, controlled token one cell,
 *      Escape clears the selection.
 * 4. `Map-Art Independence`:
 *    - The battlemap `<img>` carries no filter; the grid is a separate layer.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `TableCanvas`
 * ├── 1. `listTableTokens(table)` -> positioned token buttons.
 * ├── 2. `background_asset_hash` -> `presignAsset` -> battlemap `<img>`.
 * ├── 3. Token click -> select token + linked actor.
 * └── 4. Board click / arrow key -> `snapToCell` -> `MOVE_TOKEN`.
 * ============================================================================
 */
import { useEffect, useState } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import { selectedActorIdSignal, selectedTokenIdSignal } from '../api/session.ts';
import type { Uuid, WirePoint2D } from '../api/wire.ts';
import { t } from '../i18n/index.ts';
import { moveToken } from './commands.ts';
import { assetHashFromKey, listTableTokens, snapToCell, type TableToken } from './tableView.ts';

/** Board size, in cells, used before a scene with dimensions is active. */
const FALLBACK_BOARD_CELLS = 20;

const ARROW_DELTAS: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

export interface TableCanvasProps {
  campaignId: Uuid;
  client: ApiClient;
}

function tokenLabel(token: TableToken): string {
  if (token.hp !== null && token.maxHp !== null) {
    return t('table.token.labelHp', { name: token.name, hp: token.hp, max: token.maxHp });
  }
  if (token.bloodied) {
    return t('table.token.labelTier', { name: token.name, tier: t(`table.tier.${token.bloodied}` as 'table.tier.UNHURT') });
  }
  return token.name;
}

function initials(name: string): string {
  return name.trim().slice(0, 2) || '?';
}

/** Selects a token and the actor sheet linked to it (`null` when unlinked). */
export function selectToken(token: TableToken | null): void {
  selectedTokenIdSignal.value = token?.id ?? null;
  if (token?.actorId) selectedActorIdSignal.value = token.actorId;
}

export function TableCanvas({ campaignId, client }: TableCanvasProps) {
  const table = client.state.table.value;
  const tokens = listTableTokens(table);
  const selectedId = selectedTokenIdSignal.value;
  const selected = tokens.find((tok) => tok.id === selectedId) ?? null;
  const cell = table && table.cell_size_px > 0 ? table.cell_size_px : 50;
  const width = table && table.map_width_px > 0 ? table.map_width_px : cell * FALLBACK_BOARD_CELLS;
  const height = table && table.map_height_px > 0 ? table.map_height_px : cell * FALLBACK_BOARD_CELLS;
  const mapHash = table?.background_asset_hash ?? null;
  const [mapUrl, setMapUrl] = useState<string | null>(null);

  useEffect(() => {
    setMapUrl(null);
    if (!mapHash) return;
    let live = true;
    client
      .presignAsset(campaignId, assetHashFromKey(mapHash))
      .then((url) => {
        if (live) setMapUrl(url);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, campaignId, mapHash]);

  const move = (token: TableToken, to: WirePoint2D) => {
    if (!token.controlled) return;
    client.submitCommand(moveToken(token.id, snapToCell(to, cell)));
  };

  const onBoardClick = (e: MouseEvent) => {
    if (!selected?.controlled) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    move(selected, { x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const onTokenKeyDown = (token: TableToken, e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      selectToken(null);
      return;
    }
    const delta = ARROW_DELTAS[e.key];
    if (!delta || !token.controlled) return;
    e.preventDefault();
    selectToken(token);
    move(token, { x: token.topLeft.x + delta[0] * cell, y: token.topLeft.y + delta[1] * cell });
  };

  return (
    <section class="ds-table-canvas" aria-label={t('table.canvas')} data-testid="table-canvas">
      <p class="ds-visually-hidden">{t('table.canvasHelp')}</p>
      <div
        class="ds-board"
        data-testid="table-board"
        style={{ width: `${width}px`, height: `${height}px`, '--board-cell': `${cell}px` }}
        onClick={onBoardClick}
      >
        {mapUrl ? <img class="ds-board-map" src={mapUrl} alt="" data-testid="table-map" /> : null}
        <div class="ds-board-grid" aria-hidden="true" />
        {tokens.map((token) => (
          <button
            key={token.id}
            type="button"
            class={`ds-token${token.controlled ? '' : ' is-public'}${token.id === selectedId ? ' is-selected' : ''}`}
            data-testid={`token-${token.id}`}
            aria-pressed={token.id === selectedId}
            aria-label={tokenLabel(token)}
            style={{
              left: `${token.topLeft.x}px`,
              top: `${token.topLeft.y}px`,
              width: `${token.gridW * cell}px`,
              height: `${token.gridH * cell}px`,
            }}
            onClick={(e) => {
              e.stopPropagation();
              selectToken(token);
            }}
            onKeyDown={(e) => onTokenKeyDown(token, e)}
          >
            <span aria-hidden="true">{initials(token.name)}</span>
          </button>
        ))}
      </div>
      {tokens.length === 0 ? (
        <p class="ds-hint" data-testid="table-empty">{t('table.empty')}</p>
      ) : null}
    </section>
  );
}
