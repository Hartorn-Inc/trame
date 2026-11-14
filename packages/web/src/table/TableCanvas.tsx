/**
 * ============================================================================
 * TACTICAL TABLE BOARD (table/TableCanvas.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Renders the active scene through PixiJS (battlemap, grid, difficult
 * terrain, walls, AoEs, tokens, lighting, fog of war, pings) and keeps every
 * token and door handle as a real `<button>` laid over the canvas, which
 * carries the accessible name, the keyboard input and the selection. Pointer
 * and keyboard input become commands: `MOVE_TOKEN`, `TOGGLE_DOOR`, GM fog and
 * difficult-terrain brush strokes, and ephemeral pointer pings. A token click
 * selects the token and its linked actor (`selectedTokenIdSignal`,
 * `selectedActorIdSignal`), which drives the sheet drawer and the vitals,
 * conditions and cover panels.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Server-Authoritative State`:
 *    - The board never moves a token, opens a door or paints a cell locally;
 *      it submits the command and re-renders from the next snapshot. A
 *      rejected command (wall, speed budget, locked door, Speed 0) leaves the
 *      board as it was and the rejection toast explains why.
 * 2. `Controlled Tokens Only`:
 *    - Move input is accepted for tokens in `tokens` (controlled); public
 *      tokens can be selected (to read their health tier) but not moved.
 *      Door handles a player may not toggle (locked, secret) stay focusable
 *      with `aria-disabled`, and activating one says why in a status line.
 *    - Players only get handles of doors they see: a side of the door is in
 *      a vision polygon or a GM reveal cell (`isPointUnfogged`), so a handle
 *      never reveals a door behind the fog. The GM gets every handle plus a
 *      lock toggle (`CONFIGURE_DOOR`) on plain doors.
 * 3. `Accessible Overlay`:
 *    - Every token and door is a real `<button>`; arrow keys move the
 *      focused controlled token one cell, `P` pings its centre, Shift+F10 /
 *      ContextMenu opens its action menu, Escape clears the selection or
 *      cancels a pending teleport. The canvas itself is a labelled
 *      `role="img"`. Door state is told by text and border style, not colour.
 *    - While a GM brush or a teleport is active, a focusable cell cursor is
 *      the keyboard twin of the pointer: arrow keys move it (Shift+arrows
 *      mark a rectangle for brushes), Enter paints the brush or rectangle or
 *      teleports there, Escape drops the rectangle, cancels the teleport or
 *      leaves the brush. A teleport focuses the cursor on the token's cell;
 *      a polite status names the cursor cell.
 * 4. `Progressive Renderer`:
 *    - PixiJS is imported lazily and only where WebGL2 exists. Until it is up,
 *      when it fails to start, or after a draw throws, the board draws the
 *      battlemap `<img>`, a CSS grid and visible token buttons, so the table
 *      stays usable without WebGL.
 * 5. `Zoom Without Reprojection`:
 *    - Zoom scales the whole board (canvas and overlay buttons together) by a
 *      CSS transform inside a sized scroll area, so every pointer position is
 *      divided by the zoom once (`boardPoint`) and stays in canvas pixels.
 *      Ctrl/Cmd + wheel and two-finger pinch zoom around the pointer; plain
 *      wheel, scrollbars and touch drag pan. The anchored scroll offset is
 *      applied in a layout effect after the zoomed board has its new size,
 *      otherwise the browser clamps it to the old, smaller scroll area.
 * 6. `GM-Only Brushes`:
 *    - The fog and terrain tools render for the GM only; while one is active
 *      board clicks paint instead of moving tokens (`tableTools.ts`).
 * 7. `Map-Art Independence`:
 *    - Neither the battlemap `<img>` nor the canvas carries a filter.
 * 8. `Pending Action Input`:
 *    - While a sheet attack waits for targets, token clicks toggle targets
 *      (marked in the label and by a dashed outline, not colour alone)
 *      instead of selecting. While an area spell waits for placement, board
 *      and token clicks place it; the placed template is drawn as a preview
 *      until the resolution card closes (`actionResolution.ts`).
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `TableCanvas`
 * ├── 1. `buildTableScene(projection, viewer, palette, WASM geometry)` -> draw list.
 * ├── 2. `background_asset_hash` -> `presignAsset` -> decoded battlemap image.
 * ├── 3. `createTableRenderer(canvas)` (lazy) -> `update(scene, image)` per render.
 * ├── 4. Token click -> select; right-click / Shift+F10 -> `TokenMenuDialog`.
 * ├── 5. Board click / arrow key -> `snapToCell` -> `MOVE_TOKEN` (teleport armed:
 * │      `gm_teleport: true`); Alt+click -> pointer ping. A GM click with no
 * │      token to move selects the cell (`selectedCellSignal`); scrolling and
 * │      zooming track `viewportCenterSignal`. Compendium spawns land there.
 * ├── 6. Door handle click -> `TOGGLE_DOOR` (refused locally with a reason when
 * │      locked); GM lock toggle -> `CONFIGURE_DOOR { is_locked }`.
 * └── 7. Brush drag -> `strokeCommands` -> one `SET_FOG_OVERRIDES` /
 *        `SET_DIFFICULT_TERRAIN` per stroke; a capped stroke shows a notice.
 * ============================================================================
 */
import { Fragment } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ApiClient } from '../api/client.ts';
import { selectedActorIdSignal, selectedCellSignal, selectedTokenIdSignal, viewportCenterSignal } from '../api/session.ts';
import type { Uuid, WirePoint2D } from '../api/wire.ts';
import { getCanvasThemePalette } from '../canvas/CanvasThemePalette.ts';
import {
  computeTokenVisionPolygon,
  computeVisibilityPolygon,
  initEngine,
  isEngineReady,
  previewAoeCells,
  type GridCell,
} from '../engine/wasmBridge.ts';
import { t, type MessageKey } from '../i18n/index.ts';
import { resolvedThemeSignal } from '../signals/themeSignal.ts';
import {
  actionTargetIdsSignal,
  areaOriginSignal,
  isPickingTargets,
  isPlacingArea,
  pendingAreaTemplate,
  toggleActionTarget,
} from './actionResolution.ts';
import { configureDoorLock, moveToken, toggleDoor } from './commands.ts';
import type { TableRenderer } from './scene/pixiTableRenderer.ts';
import { buildTableScene, isPointUnfogged, type SceneGeometry, type TableScene } from './scene/tableScene.ts';
import {
  BRUSH_SIZES,
  MAX_STROKE_CELLS,
  TABLE_TOOLS,
  ZOOM_STEP,
  brushCells,
  cellAt,
  gridBounds,
  mergeCells,
  pinchFactor,
  rectCells,
  stepCell,
  strokeCapped,
  strokeCells,
  strokeCommands,
  zoomAround,
  type TableTool,
} from './tableTools.ts';
import { activeTurnTokenId, assetHashFromKey, doorHandles, listTableTokens, snapToCell, type DoorHandle, type TableToken } from './tableView.ts';
import { TokenMenuDialog } from './TokenMenuDialog.tsx';

const ARROW_DELTAS: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

const WASM_GEOMETRY: SceneGeometry = {
  visibilityPolygon: computeVisibilityPolygon,
  tokenVisionPolygon: computeTokenVisionPolygon,
  aoeCells: previewAoeCells,
};

/** Door handle hit target edge (`px`), the ATLAS desktop minimum. */
const DOOR_HANDLE_PX = 40;

export interface TableCanvasProps {
  campaignId: Uuid;
  client: ApiClient;
  /** GM view: whole map, the player-vision preview toggle, and the map brushes. */
  isGm?: boolean;
}

function tokenLabel(token: TableToken): string {
  let label = token.name;
  if (token.hp !== null && token.maxHp !== null) {
    label = t('table.token.labelHp', { name: token.name, hp: token.hp, max: token.maxHp });
  } else if (token.bloodied) {
    label = t('table.token.labelTier', { name: token.name, tier: t(`table.tier.${token.bloodied}` as 'table.tier.UNHURT') });
  }
  if (token.gmHidden) label += `, ${t('table.token.hidden')}`;
  if (token.disengaged) label += `, ${t('table.token.disengaged')}`;
  if (actionTargetIdsSignal.value.includes(token.id)) label += `, ${t('table.token.targeted')}`;
  return label;
}

/** Name of a door handle; open / closed is its `aria-pressed` state, never part of the name. */
function doorLabel(door: DoorHandle): string {
  const extra = door.isSecret ? t('table.door.secret') : door.isLocked ? t('table.door.locked') : null;
  return extra ? t('table.door.labelWith', { extra }) : t('table.door.label');
}

function initials(name: string): string {
  return name.trim().slice(0, 2) || '?';
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function hexColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Selects a token and the actor sheet linked to it (`null` when unlinked). */
export function selectToken(token: TableToken | null): void {
  selectedTokenIdSignal.value = token?.id ?? null;
  if (token) selectedCellSignal.value = null;
  if (token?.actorId) selectedActorIdSignal.value = token.actorId;
}

export function TableCanvas({ campaignId, client, isGm = false }: TableCanvasProps) {
  const table = client.state.table.value;
  const tokens = listTableTokens(table);
  const selectedId = selectedTokenIdSignal.value;
  const selected = tokens.find((tok) => tok.id === selectedId) ?? null;
  const selectedCell = selectedCellSignal.value;
  const [previewPlayerView, setPreviewPlayerView] = useState(false);
  const [, setEngineLoads] = useState(0);
  const palette = getCanvasThemePalette(resolvedThemeSignal.value);
  const areaPreview = pendingAreaTemplate(table);
  const targetIds = actionTargetIdsSignal.value;
  const scene: TableScene = buildTableScene({
    state: areaPreview && table ? { ...table, persistent_aoes: { ...table.persistent_aoes, [areaPreview.id]: areaPreview } } : table,
    palette,
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
  const doors = doorHandles(table, isGm).filter((door) => isGm || door.sides.some((point) => isPointUnfogged(scene.fog, point)));
  const [doorNotice, setDoorNotice] = useState('');
  const [mapUrl, setMapUrl] = useState<string | null>(null);
  const [mapImage, setMapImage] = useState<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  /** Scroll offset (`px`) the next zoom render applies (invariant 5). */
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<TableRenderer | null>(null);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<TableTool>('select');
  const [brushSize, setBrushSize] = useState(BRUSH_SIZES[0]);
  const [capped, setStrokeCapped] = useState(false);
  const [menuTokenId, setMenuTokenId] = useState<Uuid | null>(null);
  const [teleportId, setTeleportId] = useState<Uuid | null>(null);
  /** Keyboard cell cursor (`null`: start at the teleported token, the selected cell or the origin). */
  const [cursor, setCursor] = useState<GridCell | null>(null);
  /** Corner a Shift+arrow rectangle started from (`null`: Enter paints one brush). */
  const [anchor, setAnchor] = useState<GridCell | null>(null);
  const cursorRef = useRef<HTMLButtonElement>(null);
  const stroke = useRef<{ cells: GridCell[]; last: GridCell } | null>(null);
  const touches = useRef(new Map<number, WirePoint2D>());
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const activeTool: TableTool = isGm ? tool : 'select';
  const menuToken = tokens.find((tok) => tok.id === menuTokenId) ?? null;
  const teleportToken = isGm ? tokens.find((tok) => tok.id === teleportId) ?? null : null;
  const bounds = gridBounds(width, height, cell);
  const cursorActive = activeTool !== 'select' || teleportToken !== null;
  const cursorCell =
    cursor ?? (teleportToken ? cellAt(teleportToken.topLeft, cell) : selectedCell ? cellAt(selectedCell, cell) : { col: 0, row: 0 });

  useLayoutEffect(() => {
    if (teleportId && !menuTokenId) cursorRef.current?.focus();
  }, [teleportId, menuTokenId]);

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

  /** Board point (`px`) under a pointer event, undoing the zoom (invariant 5). */
  const boardPoint = (e: { clientX: number; clientY: number }): WirePoint2D => {
    const rect = boardRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  };

  const zoomBy = (factor: number, anchor?: WirePoint2D) => {
    const scroller = scrollerRef.current;
    const at = anchor ?? { x: (scroller?.clientWidth ?? 0) / 2, y: (scroller?.clientHeight ?? 0) / 2 };
    const next = zoomAround({ zoom, scrollLeft: scroller?.scrollLeft ?? 0, scrollTop: scroller?.scrollTop ?? 0 }, factor, at);
    pendingScrollRef.current = { left: next.scrollLeft, top: next.scrollTop };
    setZoom(next.zoom);
  };

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const pending = pendingScrollRef.current;
    if (!scroller || !pending) return;
    pendingScrollRef.current = null;
    scroller.scrollLeft = pending.left;
    scroller.scrollTop = pending.top;
  }, [zoom]);

  const scrollerAnchor = (e: { clientX: number; clientY: number }): WirePoint2D => {
    const rect = scrollerRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const ping = (pos: WirePoint2D) => client.sendPointerPing(pos, hexColor(palette.pointerPingHex));

  const move = (token: TableToken, to: WirePoint2D) => {
    if (!token.controlled) return;
    const gmTeleport = teleportToken?.id === token.id;
    client.submitCommand(moveToken(token.id, snapToCell(to, cell), gmTeleport));
    if (gmTeleport) setTeleportId(null);
  };

  const onBoardClick = (e: MouseEvent) => {
    if (e.altKey) {
      ping(boardPoint(e));
      return;
    }
    if (isPlacingArea()) {
      areaOriginSignal.value = boardPoint(e);
      return;
    }
    if (activeTool !== 'select') return;
    const mover = teleportToken ?? (selected?.controlled ? selected : null);
    if (mover) move(mover, boardPoint(e));
    else if (isGm) selectedCellSignal.value = snapToCell(boardPoint(e), cell);
  };

  const trackViewportCenter = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    viewportCenterSignal.value = {
      x: (scroller.scrollLeft + scroller.clientWidth / 2) / zoom,
      y: (scroller.scrollTop + scroller.clientHeight / 2) / zoom,
    };
  };
  useEffect(trackViewportCenter, [zoom]);

  const paint = (e: PointerEvent, phase: 'start' | 'move') => {
    const bounds = gridBounds(width, height, cell);
    const at = cellAt(boardPoint(e), cell);
    if (phase === 'start') {
      stroke.current = { cells: mergeCells([], brushCells(at, brushSize, bounds)), last: at };
      return;
    }
    const current = stroke.current;
    if (!current || (at.col === current.last.col && at.row === current.last.row)) return;
    const added = strokeCells(current.last, at).flatMap((c) => brushCells(c, brushSize, bounds));
    stroke.current = { cells: mergeCells(current.cells, added), last: at };
  };

  const onBoardPointerDown = (e: PointerEvent) => {
    if (activeTool === 'select' || e.pointerType === 'touch') return;
    e.preventDefault();
    paint(e, 'start');
  };

  const onBoardPointerMove = (e: PointerEvent) => {
    if (stroke.current) paint(e, 'move');
  };

  const onBoardPointerUp = () => {
    const done = stroke.current;
    stroke.current = null;
    if (!done) return;
    for (const command of strokeCommands(activeTool, done.cells)) client.submitCommand(command);
    setStrokeCapped(strokeCapped(done.cells));
  };

  const onScrollerWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, scrollerAnchor(e));
  };

  const onScrollerPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };

  const onScrollerPointerMove = (e: PointerEvent) => {
    const map = touches.current;
    if (e.pointerType !== 'touch' || !map.has(e.pointerId)) return;
    const before = [...map.values()];
    map.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (map.size !== 2) return;
    const after = [...map.values()];
    const factor = pinchFactor([before[0], before[1]], [after[0], after[1]]);
    const mid = { clientX: (after[0].x + after[1].x) / 2, clientY: (after[0].y + after[1].y) / 2 };
    if (factor !== 1) zoomBy(factor, scrollerAnchor(mid));
  };

  const onScrollerPointerEnd = (e: PointerEvent) => {
    touches.current.delete(e.pointerId);
  };

  const onTokenKeyDown = (token: TableToken, e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (teleportId) setTeleportId(null);
      else selectToken(null);
      return;
    }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      selectToken(token);
      setMenuTokenId(token.id);
      return;
    }
    if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      ping({ x: token.topLeft.x + (token.gridW * cell) / 2, y: token.topLeft.y + (token.gridH * cell) / 2 });
      return;
    }
    const delta = ARROW_DELTAS[e.key];
    if (!delta || !token.controlled) return;
    e.preventDefault();
    selectToken(token);
    move(token, { x: token.topLeft.x + delta[0] * cell, y: token.topLeft.y + delta[1] * cell });
  };

  const focusToken = (id: Uuid) => boardRef.current?.querySelector<HTMLButtonElement>(`[data-testid="token-${id}"]`)?.focus();

  /** Keyboard twin of brush strokes and teleport clicks (invariant 3). */
  const onCursorKeyDown = (e: KeyboardEvent) => {
    const delta = ARROW_DELTAS[e.key];
    if (delta) {
      e.preventDefault();
      setAnchor(e.shiftKey && !teleportToken ? (anchor ?? cursorCell) : null);
      setCursor(stepCell(cursorCell, delta, bounds));
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (teleportToken) {
        focusToken(teleportToken.id);
        move(teleportToken, { x: cursorCell.col * cell, y: cursorCell.row * cell });
        return;
      }
      const cells = anchor ? rectCells(anchor, cursorCell, bounds) : brushCells(cursorCell, brushSize, bounds);
      for (const command of strokeCommands(activeTool, cells)) client.submitCommand(command);
      setStrokeCapped(strokeCapped(cells));
      setAnchor(null);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (anchor) setAnchor(null);
      else if (teleportToken) {
        focusToken(teleportToken.id);
        setTeleportId(null);
      } else setTool('select');
    }
  };

  const cursorStatus = anchor
    ? t('table.cursor.rect', {
        col: cursorCell.col + 1,
        row: cursorCell.row + 1,
        cols: Math.abs(cursorCell.col - anchor.col) + 1,
        rows: Math.abs(cursorCell.row - anchor.row) + 1,
      })
    : t('table.cursor.at', { col: cursorCell.col + 1, row: cursorCell.row + 1 });

  const pixi = renderer !== null;
  return (
    <section class="ds-table-canvas" aria-label={t('table.canvas')} data-testid="table-canvas">
      <p class="ds-visually-hidden">{t('table.canvasHelp')}</p>
      <div class="ds-board-toolbar" role="toolbar" aria-label={t('table.toolbar')}>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-testid="table-zoom-out" aria-label={t('table.zoomOut')} onClick={() => zoomBy(1 / ZOOM_STEP)}>
          −
        </button>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-testid="table-zoom-reset" aria-label={t('table.zoomReset')} onClick={() => zoomBy(1 / zoom)}>
          {t('table.zoomLevel', { percent: Math.round(zoom * 100) })}
        </button>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-testid="table-zoom-in" aria-label={t('table.zoomIn')} onClick={() => zoomBy(ZOOM_STEP)}>
          +
        </button>
        {selected ? (
          <button
            type="button"
            class="ds-btn ds-btn-secondary ds-btn-sm"
            data-testid="table-token-menu-open"
            onClick={() => setMenuTokenId(selected.id)}
          >
            {t('table.tokenActions')}
          </button>
        ) : null}
        {isGm ? (
          <>
            <button
              type="button"
              class="ds-btn ds-btn-secondary ds-btn-sm"
              aria-pressed={previewPlayerView}
              data-testid="table-preview-player-view"
              onClick={() => setPreviewPlayerView(!previewPlayerView)}
            >
              {t('table.previewPlayerView')}
            </button>
            <div class="ds-cluster" role="group" aria-label={t('table.tools')}>
              {TABLE_TOOLS.map((id) => (
                <button
                  key={id}
                  type="button"
                  class="ds-btn ds-btn-ghost ds-btn-sm"
                  data-testid={`table-tool-${id}`}
                  aria-pressed={tool === id ? 'true' : 'false'}
                  onClick={() => {
                    setTool(id);
                    setAnchor(null);
                  }}
                >
                  {t(`table.tool.${id}` as MessageKey)}
                </button>
              ))}
              <label class="ds-field-label" for="table-brush-size">{t('table.brushSize')}</label>
              <select
                id="table-brush-size"
                class="ds-input ds-input-compact"
                data-testid="table-brush-size"
                value={String(brushSize)}
                onChange={(e) => setBrushSize(Number((e.target as HTMLSelectElement).value))}
              >
                {BRUSH_SIZES.map((size) => (
                  <option key={size} value={String(size)}>{t('table.brushCells', { size })}</option>
                ))}
              </select>
            </div>
          </>
        ) : null}
      </div>
      {isGm && selectedCell ? (
        <p class="ds-hint" role="status" data-testid="table-selected-cell">
          {t('table.selectedCell', { col: Math.round(selectedCell.x / cell) + 1, row: Math.round(selectedCell.y / cell) + 1 })}
        </p>
      ) : null}
      {capped && tool !== 'select' ? (
        <p class="ds-hint" role="status" data-testid="table-stroke-capped">
          {t('table.strokeCapped', { max: MAX_STROKE_CELLS })}
        </p>
      ) : null}
      {teleportToken ? (
        <p class="ds-hint" role="status" data-testid="table-teleport-armed">
          {t('table.teleportArmed', { name: teleportToken.name })}
        </p>
      ) : null}
      <p class="ds-visually-hidden" role="status" data-testid="table-door-status">
        {doorNotice}
      </p>
      {cursorActive ? (
        <p class="ds-visually-hidden" id="table-cursor-status" role="status" data-testid="table-cursor-status">
          {cursorStatus}
        </p>
      ) : null}
      <div
        ref={scrollerRef}
        class="ds-board-scroller"
        data-testid="table-scroller"
        onWheel={onScrollerWheel}
        onScroll={trackViewportCenter}
        onPointerDown={onScrollerPointerDown}
        onPointerMove={onScrollerPointerMove}
        onPointerUp={onScrollerPointerEnd}
        onPointerCancel={onScrollerPointerEnd}
      >
        <div class="ds-board-viewport" style={{ width: `${width * zoom}px`, height: `${height * zoom}px` }}>
          <div
            ref={boardRef}
            class={`ds-board${pixi ? ' is-pixi' : ''}${activeTool === 'select' ? '' : ' is-brushing'}`}
            data-testid="table-board"
            data-tool={activeTool}
            style={{
              width: `${width}px`,
              height: `${height}px`,
              '--board-cell': `${cell}px`,
              transform: zoom === 1 ? undefined : `scale(${zoom})`,
            }}
            onClick={onBoardClick}
            onPointerDown={onBoardPointerDown}
            onPointerMove={onBoardPointerMove}
            onPointerUp={onBoardPointerUp}
            onPointerLeave={onBoardPointerUp}
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
            {doors.map((door) => (
              <Fragment key={door.wallId}>
                <button
                  type="button"
                  class={`ds-door-handle${door.isOpen ? ' is-open' : ''}${door.isLocked || door.isSecret ? ' is-locked' : ''}`}
                  data-testid={`door-${door.wallId}`}
                  aria-label={doorLabel(door)}
                  aria-pressed={door.isOpen ? 'true' : 'false'}
                  aria-disabled={door.canToggle ? undefined : 'true'}
                  style={{ left: `${door.pos.x - DOOR_HANDLE_PX / 2}px`, top: `${door.pos.y - DOOR_HANDLE_PX / 2}px` }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (door.canToggle) client.submitCommand(toggleDoor(door.wallId, !door.isOpen));
                    else setDoorNotice(t(door.isSecret ? 'table.door.secretReason' : 'table.door.lockedReason'));
                  }}
                >
                  <span aria-hidden="true">{door.isOpen ? '⊐' : '▮'}</span>
                </button>
                {isGm && !door.isSecret ? (
                  <button
                    type="button"
                    class={`ds-door-handle${door.isLocked ? ' is-locked' : ''}`}
                    data-testid={`door-lock-${door.wallId}`}
                    aria-label={t('table.door.lock')}
                    aria-pressed={door.isLocked ? 'true' : 'false'}
                    style={{ left: `${door.pos.x + DOOR_HANDLE_PX / 2 + 4}px`, top: `${door.pos.y - DOOR_HANDLE_PX / 2}px` }}
                    onClick={(e) => {
                      e.stopPropagation();
                      client.submitCommand(configureDoorLock(door.wallId, !door.isLocked));
                    }}
                  >
                    <span aria-hidden="true">{door.isLocked ? '●' : '○'}</span>
                  </button>
                ) : null}
              </Fragment>
            ))}
            {cursorActive && anchor ? (
              <div
                class="ds-board-cursor-rect"
                aria-hidden="true"
                style={{
                  left: `${Math.min(anchor.col, cursorCell.col) * cell}px`,
                  top: `${Math.min(anchor.row, cursorCell.row) * cell}px`,
                  width: `${(Math.abs(anchor.col - cursorCell.col) + 1) * cell}px`,
                  height: `${(Math.abs(anchor.row - cursorCell.row) + 1) * cell}px`,
                }}
              />
            ) : null}
            {cursorActive ? (
              <button
                ref={cursorRef}
                type="button"
                class="ds-board-cursor"
                data-testid="table-cell-cursor"
                aria-label={teleportToken ? t('table.cursor.teleport', { name: teleportToken.name }) : t('table.cursor.brush')}
                aria-describedby="table-cursor-status"
                style={{ left: `${cursorCell.col * cell}px`, top: `${cursorCell.row * cell}px`, width: `${cell}px`, height: `${cell}px` }}
                onKeyDown={onCursorKeyDown}
                onClick={(e) => {
                  if (e.detail === 0) e.stopPropagation();
                }}
              />
            ) : null}
            {tokens.map((token) => (
              <button
                key={token.id}
                type="button"
                class={`ds-token${token.controlled ? '' : ' is-public'}${token.id === selectedId ? ' is-selected' : ''}${token.gmHidden ? ' is-hidden' : ''}${targetIds.includes(token.id) ? ' is-targeted' : ''}`}
                data-testid={`token-${token.id}`}
                aria-pressed={token.id === selectedId}
                aria-label={tokenLabel(token)}
                aria-haspopup="dialog"
                style={{
                  left: `${token.topLeft.x}px`,
                  top: `${token.topLeft.y}px`,
                  width: `${token.gridW * cell}px`,
                  height: `${token.gridH * cell}px`,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (e.altKey) {
                    ping(boardPoint(e));
                    return;
                  }
                  if (isPickingTargets()) {
                    toggleActionTarget(token.id);
                    return;
                  }
                  if (isPlacingArea()) {
                    areaOriginSignal.value = { x: token.topLeft.x + (token.gridW * cell) / 2, y: token.topLeft.y + (token.gridH * cell) / 2 };
                    return;
                  }
                  selectToken(token);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  selectToken(token);
                  setMenuTokenId(token.id);
                }}
                onKeyDown={(e) => onTokenKeyDown(token, e)}
              >
                <span aria-hidden="true">{initials(token.name)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {tokens.length === 0 ? (
        <p class="ds-hint" data-testid="table-empty">{t('table.empty')}</p>
      ) : null}
      {menuToken ? (
        <TokenMenuDialog
          client={client}
          token={menuToken}
          isGm={isGm}
          onClose={() => setMenuTokenId(null)}
          onTeleport={(tok) => {
            setTeleportId(tok.id);
            setCursor(null);
            setAnchor(null);
          }}
        />
      ) : null}
    </section>
  );
}
