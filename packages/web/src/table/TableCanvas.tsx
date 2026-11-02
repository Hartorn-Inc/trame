/**
 * ============================================================================
 * TACTICAL TABLE BOARD (table/TableCanvas.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Renders the active scene through PixiJS (battlemap, grid, walls, AoEs,
 * tokens, lighting, fog of war, pings) and keeps every token as a real
 * `<button>` laid over the canvas, which carries the accessible name, the
 * keyboard movement and the selection. Pointer and keyboard input become
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
 * 3. `Accessible Token Layer`:
 *    - Every token is a real `<button>` with a name + health label and
 *      `aria-pressed`, positioned over its drawing; arrow keys move the
 *      focused, controlled token one cell, Escape clears the selection. The
 *      canvas itself is a labelled `role="img"`.
 * 4. `Progressive Renderer`:
 *    - PixiJS is imported lazily and only where WebGL2 exists. Until it is up,
 *      when it fails to start, or after a draw throws, the board draws the
 *      battlemap `<img>`, a CSS grid and visible token buttons, so the table
 *      stays usable without WebGL.
 * 5. `Map-Art Independence`:
 *    - Neither the battlemap `<img>` nor the canvas carries a filter.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `TableCanvas`
 * ├── 1. `buildTableScene(projection, viewer, palette)` -> draw list.
 * ├── 2. `background_asset_hash` -> `presignAsset` -> decoded battlemap image.
 * ├── 3. `createTableRenderer(canvas)` (lazy) -> `update(scene, image)` per render.
 * ├── 4. Token button click -> select token + linked actor.
 * └── 5. Board click / arrow key -> `snapToCell` -> `MOVE_TOKEN`.
 * ============================================================================
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import { selectedActorIdSignal, selectedTokenIdSignal } from '../api/session.ts';
import type { Uuid, WirePoint2D } from '../api/wire.ts';
import { getCanvasThemePalette } from '../canvas/CanvasThemePalette.ts';
import { computeVisibilityPolygon, initEngine, isEngineReady, previewAoeCells } from '../engine/wasmBridge.ts';
import { t } from '../i18n/index.ts';
import { resolvedThemeSignal } from '../signals/themeSignal.ts';
import { moveToken } from './commands.ts';
import type { TableRenderer } from './scene/pixiTableRenderer.ts';
import { buildTableScene, type SceneGeometry, type TableScene } from './scene/tableScene.ts';
import { activeTurnTokenId, assetHashFromKey, listTableTokens, snapToCell, type TableToken } from './tableView.ts';

const ARROW_DELTAS: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

const WASM_GEOMETRY: SceneGeometry = {
  visibilityPolygon: computeVisibilityPolygon,
  aoeCells: previewAoeCells,
};

export interface TableCanvasProps {
  campaignId: Uuid;
  client: ApiClient;
  /** GM view: whole map, plus the player-vision preview toggle. */
  isGm?: boolean;
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

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Selects a token and the actor sheet linked to it (`null` when unlinked). */
export function selectToken(token: TableToken | null): void {
  selectedTokenIdSignal.value = token?.id ?? null;
  if (token?.actorId) selectedActorIdSignal.value = token.actorId;
}

export function TableCanvas({ campaignId, client, isGm = false }: TableCanvasProps) {
  const table = client.state.table.value;
  const tokens = listTableTokens(table);
  const selectedId = selectedTokenIdSignal.value;
  const selected = tokens.find((tok) => tok.id === selectedId) ?? null;
  const [previewPlayerView, setPreviewPlayerView] = useState(false);
  const [, setEngineLoads] = useState(0);
  const scene: TableScene = buildTableScene({
    state: table,
    palette: getCanvasThemePalette(resolvedThemeSignal.value),
    isGm,
    selectedTokenId: selectedId,
    activeTurnTokenId: activeTurnTokenId(table),
    previewPlayerView,
    reducedMotion: prefersReducedMotion(),
    pings: client.state.pointerPings.value,
    nowMs: Date.now(),
    geometry: isEngineReady() ? WASM_GEOMETRY : null,
  });
  const { cellPx: cell, widthPx: width, heightPx: height } = scene;
  const mapHash = scene.mapHash;
  const [mapUrl, setMapUrl] = useState<string | null>(null);
  const [mapImage, setMapImage] = useState<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderer, setRenderer] = useState<TableRenderer | null>(null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  useEffect(() => {
    if (isEngineReady()) return;
    let live = true;
    initEngine()
      .then(() => live && setEngineLoads((n) => n + 1))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof WebGL2RenderingContext === 'undefined') return;
    let live = true;
    let created: TableRenderer | null = null;
    import('./scene/pixiTableRenderer.ts')
      .then(({ createTableRenderer }) => createTableRenderer(canvas, sceneRef.current))
      .then((r) => {
        created = r;
        if (live) setRenderer(r);
        else r.destroy();
      })
      .catch(() => undefined);
    return () => {
      live = false;
      created?.destroy();
    };
  }, []);

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

  useEffect(() => {
    setMapImage(null);
    if (!renderer || !mapUrl) return;
    let live = true;
    const image = new Image();
    image.src = mapUrl;
    image
      .decode()
      .then(() => live && setMapImage(image))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [renderer, mapUrl]);

  useEffect(() => {
    if (!renderer) return;
    try {
      renderer.update(scene, mapImage);
    } catch {
      renderer.destroy();
      setRenderer(null);
    }
  });

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

  const pixi = renderer !== null;
  return (
    <section class="ds-table-canvas" aria-label={t('table.canvas')} data-testid="table-canvas">
      <p class="ds-visually-hidden">{t('table.canvasHelp')}</p>
      {isGm ? (
        <button
          type="button"
          class="ds-btn ds-btn-secondary ds-board-preview"
          aria-pressed={previewPlayerView}
          data-testid="table-preview-player-view"
          onClick={() => setPreviewPlayerView(!previewPlayerView)}
        >
          {t('table.previewPlayerView')}
        </button>
      ) : null}
      <div
        class={`ds-board${pixi ? ' is-pixi' : ''}`}
        data-testid="table-board"
        style={{ width: `${width}px`, height: `${height}px`, '--board-cell': `${cell}px` }}
        onClick={onBoardClick}
      >
        <canvas
          ref={canvasRef}
          class="ds-board-canvas trame-pixijs-canvas"
          role="img"
          aria-label={t('table.render')}
          hidden={!pixi}
          data-testid={pixi && mapImage ? 'table-map' : 'table-render'}
        />
        {!pixi && mapUrl ? <img class="ds-board-map" src={mapUrl} alt="" data-testid="table-map" /> : null}
        {!pixi ? <div class="ds-board-grid" aria-hidden="true" /> : null}
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
