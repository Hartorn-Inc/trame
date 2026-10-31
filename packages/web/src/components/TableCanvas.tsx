/**
 * ============================================================================
 * TRAME LIVE TABLETOP CANVAS (TableCanvas.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Renders the interactive 2D/2.5D tabletop canvas using HTML5 Canvas/WebGL
 * layers and WASM/Raycast line-of-sight:
 *   1. Background map sprite (`mapImageUrlSignal` or starter dungeon grid)
 *   2. Tactical grid overlay (`cell_size_px`, `feet_per_cell`)
 *   3. AoE templates (persistent + live hover preview using `previewSphereAoeCells`)
 *   4. Walls & interactive Doors (`TOGGLE_DOOR` command on click)
 *   5. Vision & Lighting polygon (`computeVisibilityPolygon` + `DualBufferFogOfWar`)
 *   6. Tokens (`MOVE_TOKEN` command on drag-and-drop, click to select, HUD bars)
 *   7. Ruler measurement (`measureRulerWaypointsFt`) & Radar Pointer Pings
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `ServerAuthoritativeCommands`:
 *      - Token movement, door toggling, AoE placement, and resource updates
 *        submit typed `TableCommand` frames over `globalWsClient` and reconcile
 *        against `tableStateSignal`.
 * ============================================================================
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  type ActiveToolMode,
  type WireTokenState,
  activeCampaignSignal,
  activeDrawerSignal,
  activeToolSignal,
  combatAutomationModeSignal,
  currentUserSignal,
  isGmSignal,
  lastErrorBannerSignal,
  mapDimensionsSignal,
  mapImageUrlSignal,
  pointerPingsSignal,
  selectedTokenIdSignal,
  selectedTokenSignal,
  tableStateSignal,
} from '../store/signals.ts';
import { formatDistanceFt, t } from '../i18n/index.ts';
import {
  type Point2D,
  type WallSegmentDto,
  computeVisibilityPolygon,
  previewSphereAoeCells,
} from '../engine/wasmBridge.ts';
import { ViewportCamera, measureRulerWaypointsFt } from '../canvas/SceneGraph.ts';
import {
  apiGenerateStarterMap,
  apiUpdateActor,
  apiUploadUvttMap,
  buildDefaultSpawnTokenPayload,
  globalWsClient,
} from '../net/wsClient.ts';

export function TableCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<ViewportCamera>(new ViewportCamera());
  const mapImageRef = useRef<HTMLImageElement | null>(null);
  const loadedMapUrlRef = useRef<string | null>(null);

  const [draggingTokenId, setDraggingTokenId] = useState<string | null>(null);
  const [dragWorldPos, setDragWorldPos] = useState<Point2D | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [panLastScreen, setPanLastScreen] = useState<Point2D | null>(null);
  const [hoverWorldPos, setHoverWorldPos] = useState<Point2D | null>(null);
  const [aoeRadiusFt, setAoeRadiusFt] = useState(20);
  const [spawnTokenName, setSpawnTokenName] = useState('');
  const [uploadingMap, setUploadingMap] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    screenX: number;
    screenY: number;
    worldPt: Point2D;
    token: WireTokenState | null;
    door: { id: string; is_open: boolean; is_locked?: boolean; is_secret?: boolean } | null;
  } | null>(null);
  const [pendingHitConfirm, setPendingHitConfirm] = useState<{
    attackerName: string;
    targetId: string;
    targetName: string;
    damageExpr: string;
    damageAmount: number;
  } | null>(null);

  const mapUrl = mapImageUrlSignal.value;
  const activeCampaign = activeCampaignSignal.value;
  const activeTool = activeToolSignal.value;
  const selectedToken = selectedTokenSignal.value;
  const isGm = isGmSignal.value;

  useEffect(() => {
    if (!mapUrl) {
      mapImageRef.current = null;
      loadedMapUrlRef.current = null;
      return;
    }
    if (loadedMapUrlRef.current === mapUrl) {
      return;
    }
    loadedMapUrlRef.current = mapUrl;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      mapImageRef.current = img;
    };
    img.src = mapUrl;
  }, [mapUrl]);

  useEffect(() => {
    let animId = 0;

    const renderFrame = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        animId = requestAnimationFrame(renderFrame);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      if (canvas.width !== Math.floor(rect.width) || canvas.height !== Math.floor(rect.height)) {
        canvas.width = Math.max(320, Math.floor(rect.width));
        canvas.height = Math.max(240, Math.floor(rect.height));
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        animId = requestAnimationFrame(renderFrame);
        return;
      }

      const state = tableStateSignal.value;
      const cellPx = Math.max(16, state?.cell_size_px || 64);
      const feetPerCell = Math.max(1, state?.feet_per_cell || 5);
      const cam = cameraRef.current.getTransform();

      ctx.fillStyle = '#0b0e14';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.save();
      ctx.translate(cam.offsetX, cam.offsetY);
      ctx.scale(cam.scale, cam.scale);

      const dims = mapDimensionsSignal.value;
      const mapWidthPx = Math.max(dims.width, 16 * cellPx);
      const mapHeightPx = Math.max(dims.height, 12 * cellPx);

      if (mapImageRef.current) {
        ctx.drawImage(
          mapImageRef.current,
          0,
          0,
          mapImageRef.current.naturalWidth || mapWidthPx,
          mapImageRef.current.naturalHeight || mapHeightPx,
        );
      } else {
        ctx.fillStyle = '#141923';
        ctx.fillRect(0, 0, mapWidthPx, mapHeightPx);
      }

      // Tactical Grid Overlay
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
      ctx.lineWidth = 1 / cam.scale;
      const cols = Math.ceil(mapWidthPx / cellPx);
      const rows = Math.ceil(mapHeightPx / cellPx);
      ctx.beginPath();
      for (let c = 0; c <= cols; c++) {
        ctx.moveTo(c * cellPx, 0);
        ctx.lineTo(c * cellPx, mapHeightPx);
      }
      for (let r = 0; r <= rows; r++) {
        ctx.moveTo(0, r * cellPx);
        ctx.lineTo(mapWidthPx, r * cellPx);
      }
      ctx.stroke();

      const wallDtos: WallSegmentDto[] = (state?.walls || []).map((w) => {
        const raw = w as WallSegmentDto & {
          is_door?: boolean;
          is_open?: boolean;
          kind?: { kind?: string; is_open?: boolean };
          blocks_vision?: boolean;
          bottom_elevation_ft?: number;
          top_elevation_ft?: number;
        };
        const isDoor = Boolean(raw.is_door || raw.kind?.kind === 'DOOR' || raw.kind?.kind === 'SECRET_DOOR');
        const isOpen = Boolean(raw.is_open ?? raw.kind?.is_open ?? false);
        return {
          id: raw.id,
          a: raw.a,
          b: raw.b,
          blocksVision: isDoor ? !isOpen : (raw.blocksVision ?? raw.blocks_vision ?? true),
          blocksMovement: isDoor ? !isOpen : (raw.blocksMovement ?? true),
          bottomElevationFt: raw.bottomElevationFt ?? raw.bottom_elevation_ft ?? 0,
          topElevationFt: raw.topElevationFt ?? raw.top_elevation_ft ?? 10,
        };
      });

      // Persistent AoE Templates
      for (const aoe of Object.values(state?.persistent_aoes || {})) {
        const shape = aoe.shape;
        const origin = shape.origin;
        const radiusFt =
          shape.shape === 'SPHERE'
            ? shape.radius_ft
            : shape.shape === 'CUBE'
              ? shape.size_ft / 2
              : shape.shape === 'CONE'
                ? shape.length_ft
                : 20;
        const radiusPx = (radiusFt / feetPerCell) * cellPx;
        ctx.save();
        ctx.fillStyle = 'rgba(249, 115, 22, 0.22)';
        ctx.strokeStyle = 'rgba(251, 146, 60, 0.85)';
        ctx.lineWidth = 2 / cam.scale;
        ctx.beginPath();
        ctx.arc(origin.x, origin.y, radiusPx, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      // Live AoE preview
      if (
        (activeToolSignal.value === 'aoe_sphere' ||
          activeToolSignal.value === 'aoe_cone' ||
          activeToolSignal.value === 'aoe_line') &&
        hoverWorldPos
      ) {
        const cells = previewSphereAoeCells(
          hoverWorldPos,
          aoeRadiusFt,
          cellPx,
          feetPerCell,
          'CENTER_POINT',
          true,
          wallDtos,
        );
        ctx.fillStyle = 'rgba(245, 158, 11, 0.25)';
        for (const cell of cells) {
          ctx.fillRect(cell.col * cellPx, cell.row * cellPx, cellPx, cellPx);
        }
        const radiusPx = (aoeRadiusFt / feetPerCell) * cellPx;
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2 / cam.scale;
        ctx.beginPath();
        ctx.arc(hoverWorldPos.x, hoverWorldPos.y, radiusPx, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Visibility Polygon from selected token (Anti-Scout: anchored to committed server top_left during drag!)
      const activeTok = selectedTokenSignal.value;
      if (activeTok && wallDtos.length > 0) {
        const tokenCenter: Point2D = {
          x: activeTok.top_left.x + (activeTok.grid_w * cellPx) / 2,
          y: activeTok.top_left.y + (activeTok.grid_h * cellPx) / 2,
        };
        const visRangeFt = Math.max(
          30,
          activeTok.senses?.darkvision_range_ft || 60,
          activeTok.senses?.truesight_range_ft || 0,
        );
        const visRangePx = (visRangeFt / feetPerCell) * cellPx;
        const poly = computeVisibilityPolygon(
          wallDtos,
          tokenCenter,
          (activeTok.elevation_ft || 0) + 5,
          visRangePx,
        );
        if (poly.length >= 3) {
          ctx.save();
          ctx.fillStyle = 'rgba(253, 224, 71, 0.09)';
          ctx.strokeStyle = 'rgba(253, 224, 71, 0.35)';
          ctx.lineWidth = 1.5 / cam.scale;
          ctx.beginPath();
          ctx.moveTo(poly[0].x, poly[0].y);
          for (let i = 1; i < poly.length; i++) {
            ctx.lineTo(poly[i].x, poly[i].y);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      }

      // Walls & Doors Layer
      for (const rawWall of state?.walls || []) {
        const wall = rawWall as WallSegmentDto & {
          is_door?: boolean;
          is_open?: boolean;
          kind?: { kind?: string; is_open?: boolean };
        };
        const isDoor = Boolean(wall.is_door || wall.kind?.kind === 'DOOR' || wall.kind?.kind === 'SECRET_DOOR');
        const isOpen = Boolean(wall.is_open ?? wall.kind?.is_open ?? false);
        ctx.save();
        if (isDoor) {
          ctx.strokeStyle = isOpen ? '#22c55e' : '#f59e0b';
          ctx.lineWidth = 6 / cam.scale;
          if (isOpen) {
            ctx.setLineDash([8 / cam.scale, 6 / cam.scale]);
          }
        } else {
          ctx.strokeStyle = '#cbd5e1';
          ctx.lineWidth = 4 / cam.scale;
        }
        ctx.beginPath();
        ctx.moveTo(wall.a.x, wall.a.y);
        ctx.lineTo(wall.b.x, wall.b.y);
        ctx.stroke();

        if (isDoor) {
          const midX = (wall.a.x + wall.b.x) / 2;
          const midY = (wall.a.y + wall.b.y) / 2;
          ctx.fillStyle = isOpen ? '#166534' : '#92400e';
          ctx.beginPath();
          ctx.arc(midX, midY, 8 / cam.scale, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // Tokens Layer
      const tokens = Object.values(state?.tokens || {});
      for (const token of tokens) {
        const wPx = Math.max(1, token.grid_w || 1) * cellPx;
        const hPx = Math.max(1, token.grid_h || 1) * cellPx;
        const radius = Math.min(wPx, hPx) * 0.42;
        const isDraggingThis = draggingTokenId === token.id && dragWorldPos !== null;
        const tx = isDraggingThis && dragWorldPos ? dragWorldPos.x : token.top_left.x + wPx / 2;
        const ty = isDraggingThis && dragWorldPos ? dragWorldPos.y : token.top_left.y + hPx / 2;
        const isSelected = selectedTokenIdSignal.value === token.id;
        const isGmHidden = ((token.visibility_channel ?? 1) & 4) !== 0;

        ctx.save();
        if (isGmHidden) {
          ctx.globalAlpha = 0.52;
        }
        if (isSelected) {
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 3.5 / cam.scale;
          ctx.beginPath();
          ctx.arc(tx, ty, radius + 5, 0, Math.PI * 2);
          ctx.stroke();
        }

        const isMonster = token.id.startsWith('goblin') || token.name.toLowerCase().includes('goblin');
        ctx.fillStyle = isMonster ? '#991b1b' : '#1d4ed8';
        ctx.strokeStyle = isGmHidden ? '#f59e0b' : '#f8fafc';
        ctx.lineWidth = 2 / cam.scale;
        if (isGmHidden) {
          ctx.setLineDash([5 / cam.scale, 3 / cam.scale]);
        }
        ctx.beginPath();
        ctx.arc(tx, ty, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.max(11, Math.round(13 / cam.scale))}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const initials = (token.name || 'T')
          .split(' ')
          .map((p) => p[0])
          .join('')
          .slice(0, 2)
          .toUpperCase();
        ctx.fillText(initials, tx, ty);

        // HP Bar
        const hpMax = Math.max(1, token.max_hp || 10);
        const hpRatio = Math.max(0, Math.min(1, (token.hp ?? hpMax) / hpMax));
        const barW = radius * 1.8;
        const barH = 5 / cam.scale;
        const barX = tx - barW / 2;
        const barY = ty - radius - 12 / cam.scale;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        ctx.fillRect(barX, barY, barW, barH);
        ctx.fillStyle = hpRatio > 0.5 ? '#22c55e' : hpRatio > 0.25 ? '#eab308' : '#ef4444';
        ctx.fillRect(barX, barY, barW * hpRatio, barH);

        ctx.fillStyle = '#e2e8f0';
        ctx.font = `600 ${Math.max(10, Math.round(11 / cam.scale))}px Inter, sans-serif`;
        ctx.fillText(
          isGmHidden ? `👁️‍🗨️ ${token.name} (GM Hidden)` : token.name,
          tx,
          ty + radius + 12 / cam.scale,
        );
        ctx.restore();
      }

      // Drag Distance Ruler Overlay
      if (draggingTokenId && selectedTokenSignal.value && dragWorldPos) {
        const tok = selectedTokenSignal.value;
        const origin = {
          x: tok.top_left.x + (tok.grid_w * cellPx) / 2,
          y: tok.top_left.y + (tok.grid_h * cellPx) / 2,
        };
        const distFt = measureRulerWaypointsFt([origin, dragWorldPos], cellPx, feetPerCell, 'FIVE_FIVE_FIVE');
        ctx.save();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2.5 / cam.scale;
        ctx.setLineDash([6 / cam.scale, 4 / cam.scale]);
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y);
        ctx.lineTo(dragWorldPos.x, dragWorldPos.y);
        ctx.stroke();

        const midX = (origin.x + dragWorldPos.x) / 2;
        const midY = (origin.y + dragWorldPos.y) / 2;
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(midX - 38 / cam.scale, midY - 12 / cam.scale, 76 / cam.scale, 22 / cam.scale);
        ctx.fillStyle = '#38bdf8';
        ctx.font = `bold ${Math.round(12 / cam.scale)}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(formatDistanceFt(distFt, true), midX, midY);
        ctx.restore();
      }

      // Radar Pointer Pings
      const now = Date.now();
      for (const ping of pointerPingsSignal.value) {
        const ageMs = now - ping.timestamp_ms;
        if (ageMs > 3000) continue;
        const progress = ageMs / 3000;
        const pingRadius = (12 + progress * 48) / cam.scale;
        ctx.save();
        ctx.strokeStyle = ping.color_hex || '#38bdf8';
        ctx.globalAlpha = Math.max(0, 1 - progress);
        ctx.lineWidth = 3 / cam.scale;
        ctx.beginPath();
        ctx.arc(ping.pos.x, ping.pos.y, pingRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore();
      animId = requestAnimationFrame(renderFrame);
    };

    animId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(animId);
  }, [draggingTokenId, dragWorldPos, hoverWorldPos, aoeRadiusFt]);

  function getWorldCoords(e: MouseEvent): Point2D {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return cameraRef.current.screenToWorld({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }

  function findTokenAt(worldPt: Point2D): WireTokenState | null {
    const state = tableStateSignal.value;
    if (!state) return null;
    const cellPx = state.cell_size_px || 64;
    const tokens = Object.values(state.tokens || {});
    for (let i = tokens.length - 1; i >= 0; i--) {
      const tok = tokens[i];
      const wPx = Math.max(1, tok.grid_w || 1) * cellPx;
      const hPx = Math.max(1, tok.grid_h || 1) * cellPx;
      const cx = tok.top_left.x + wPx / 2;
      const cy = tok.top_left.y + hPx / 2;
      const r = Math.min(wPx, hPx) * 0.45;
      if (Math.hypot(worldPt.x - cx, worldPt.y - cy) <= r + 4) {
        return tok;
      }
    }
    return null;
  }

  function findDoorAt(
    worldPt: Point2D,
  ): { id: string; is_open: boolean; is_locked?: boolean; is_secret?: boolean } | null {
    const state = tableStateSignal.value;
    if (!state) return null;
    for (const rawWall of state.walls || []) {
      const wall = rawWall as WallSegmentDto & {
        is_door?: boolean;
        is_open?: boolean;
        kind?: { kind?: string; is_open?: boolean; is_locked?: boolean };
      };
      const isDoor = Boolean(
        wall.is_door ||
          wall.kind?.kind === 'DOOR' ||
          wall.kind?.kind === 'SECRET_DOOR' ||
          wall.kind?.kind === 'Door' ||
          wall.kind?.kind === 'SecretDoor',
      );
      if (!isDoor) continue;
      const isOpen = Boolean(wall.is_open ?? wall.kind?.is_open ?? false);
      const isLocked = Boolean(wall.kind?.is_locked ?? false);
      const isSecret = Boolean(
        wall.kind?.kind === 'SECRET_DOOR' || wall.kind?.kind === 'SecretDoor',
      );
      const midX = (wall.a.x + wall.b.x) / 2;
      const midY = (wall.a.y + wall.b.y) / 2;
      if (Math.hypot(worldPt.x - midX, worldPt.y - midY) <= 28) {
        return { id: wall.id, is_open: isOpen, is_locked: isLocked, is_secret: isSecret };
      }
    }
    return null;
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const worldPt = getWorldCoords(e);
    const token = findTokenAt(worldPt);
    const door = token ? null : findDoorAt(worldPt);
    if (token) {
      selectedTokenIdSignal.value = token.id;
    }
    setContextMenu({
      screenX: e.clientX - rect.left,
      screenY: e.clientY - rect.top,
      worldPt,
      token,
      door,
    });
  }

  function handleMouseDown(e: MouseEvent) {
    if (e.button === 2) {
      return;
    }
    if (contextMenu) {
      setContextMenu(null);
    }
    const worldPt = getWorldCoords(e);

    if (e.button === 1 || e.shiftKey) {
      setIsPanning(true);
      setPanLastScreen({ x: e.clientX, y: e.clientY });
      return;
    }

    const tool = activeToolSignal.value;

    if (tool === 'ping') {
      globalWsClient.sendPointerPing(worldPt, '#38bdf8');
      return;
    }

    if (tool === 'aoe_sphere' || tool === 'aoe_cone' || tool === 'aoe_line') {
      const aoeId = crypto.randomUUID();
      globalWsClient.submitCommand({
        cmd: 'PROJECT_AOE',
        persist_zone: true,
        template: {
          id: aoeId,
          caster_token_id: selectedTokenIdSignal.value ?? null,
          requires_concentration: false,
          elevation_ft: 0,
          height_ft: 20,
          shape: {
            shape: 'SPHERE',
            origin: worldPt,
            radius_ft: aoeRadiusFt,
          },
        },
      });
      return;
    }

    const door = findDoorAt(worldPt);
    if (door) {
      globalWsClient.submitCommand({
        cmd: 'TOGGLE_DOOR',
        wall_id: door.id,
        is_open: !door.is_open,
      });
      return;
    }

    const token = findTokenAt(worldPt);
    if (token) {
      selectedTokenIdSignal.value = token.id;
      setDraggingTokenId(token.id);
      setDragWorldPos(worldPt);
      return;
    }

    setIsPanning(true);
    setPanLastScreen({ x: e.clientX, y: e.clientY });
  }

  function handleMouseMove(e: MouseEvent) {
    const worldPt = getWorldCoords(e);
    setHoverWorldPos(worldPt);

    if (isPanning && panLastScreen) {
      const dx = e.clientX - panLastScreen.x;
      const dy = e.clientY - panLastScreen.y;
      cameraRef.current.pan(dx, dy);
      setPanLastScreen({ x: e.clientX, y: e.clientY });
      return;
    }

    if (draggingTokenId) {
      setDragWorldPos(worldPt);
    }
  }

  function handleMouseUp(e: MouseEvent) {
    if (isPanning) {
      setIsPanning(false);
      setPanLastScreen(null);
    }

    if (draggingTokenId) {
      const worldPt = getWorldCoords(e);
      const cellPx = tableStateSignal.value?.cell_size_px || 64;
      const snappedX = e.altKey ? worldPt.x - cellPx / 2 : Math.floor(worldPt.x / cellPx) * cellPx;
      const snappedY = e.altKey ? worldPt.y - cellPx / 2 : Math.floor(worldPt.y / cellPx) * cellPx;

      globalWsClient.submitCommand({
        cmd: 'MOVE_TOKEN',
        token_id: draggingTokenId,
        to_top_left: { x: Math.max(0, snappedX), y: Math.max(0, snappedY) },
        to_elevation_ft: null,
        gm_teleport: isGmSignal.value,
      });

      setDraggingTokenId(null);
      setDragWorldPos(null);
    }
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    cameraRef.current.zoomAtCursor(factor, e.clientX - rect.left, e.clientY - rect.top);
  }

  async function handleGenerateStarterMap() {
    if (!activeCampaign) return;
    setUploadingMap(true);
    try {
      await apiGenerateStarterMap(activeCampaign.id);
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    } finally {
      setUploadingMap(false);
    }
  }

  async function handleUploadUvtt(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !activeCampaign) return;
    setUploadingMap(true);
    try {
      const rawBytes = await file.arrayBuffer();
      await apiUploadUvttMap(activeCampaign.id, rawBytes);
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    } finally {
      setUploadingMap(false);
      input.value = '';
    }
  }

  async function handleSpawnToken(e: Event) {
    e.preventDefault();
    if (!activeCampaign) return;
    const name = spawnTokenName.trim() || 'Adventurer';
    const tokenId = crypto.randomUUID();
    try {
      await apiUpdateActor(activeCampaign.id, tokenId, {
        name,
        hp: 25,
        max_hp: 25,
        spawn_on_map: true,
      });
      selectedTokenIdSignal.value = tokenId;
      setSpawnTokenName('');
    } catch (err) {
      lastErrorBannerSignal.value = (err as Error).message;
    }
  }

  function handleSelectedHpDelta(delta: number) {
    if (!selectedToken) return;
    if (delta < 0) {
      globalWsClient.submitCommand({
        cmd: 'APPLY_DAMAGE',
        token_id: selectedToken.id,
        raw_damage: Math.abs(delta),
        affinity: 'Normal',
      });
    } else {
      globalWsClient.submitCommand({
        cmd: 'GM_OVERRIDE_TOKEN_RESOURCES',
        token_id: selectedToken.id,
        hp: Math.min(selectedToken.max_hp, selectedToken.hp + delta),
        temp_hp: null,
        speed_remaining_ft: null,
        has_action: null,
        has_bonus_action: null,
        has_reaction: null,
      });
    }
  }

  const tools: Array<{ id: ActiveToolMode; label: string }> = [
    { id: 'select', label: 'Select / Move' },
    { id: 'ping', label: 'Ping' },
    { id: 'aoe_sphere', label: 'AoE Sphere' },
  ];

  return (
    <div
      style={{
        position: 'relative',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        background: '#0b0e14',
        overflow: 'hidden',
      }}
    >
      {/* Floating Top-Left Tool & Map Bar */}
      <div
        data-testid="table-toolbar"
        style={{
          position: 'absolute',
          top: '0.75rem',
          left: '0.75rem',
          zIndex: 10,
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.4rem',
          background: 'rgba(15, 23, 42, 0.92)',
          border: '1px solid #334155',
          borderRadius: '8px',
          padding: '0.45rem 0.65rem',
          alignItems: 'center',
        }}
      >
        {tools.map((tool) => (
          <button
            key={tool.id}
            type="button"
            data-testid={`tool-${tool.id}-btn`}
            onClick={() => {
              activeToolSignal.value = tool.id;
            }}
            style={{
              padding: '0.35rem 0.65rem',
              borderRadius: '6px',
              border: 'none',
              background: activeTool === tool.id ? '#4f46e5' : '#1e293b',
              color: '#f8fafc',
              fontWeight: 600,
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
          >
            {tool.label}
          </button>
        ))}

        {activeTool === 'aoe_sphere' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginLeft: '0.4rem' }}>
            <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Radius (ft):</span>
            <input
              type="number"
              min={5}
              max={120}
              step={5}
              value={aoeRadiusFt}
              onInput={(e) => {
                setAoeRadiusFt(Number((e.currentTarget as HTMLInputElement).value) || 20);
              }}
              style={{
                width: '3.5rem',
                padding: '0.2rem 0.35rem',
                borderRadius: '4px',
                border: '1px solid #475569',
                background: '#0f172a',
                color: '#f8fafc',
                fontSize: '0.8rem',
              }}
            />
          </div>
        )}

        <span style={{ width: '1px', height: '1.4rem', background: '#334155', margin: '0 0.25rem' }} />

        <button
          type="button"
          data-testid="load-starter-map-btn"
          disabled={uploadingMap}
          onClick={handleGenerateStarterMap}
          style={{
            padding: '0.35rem 0.7rem',
            borderRadius: '6px',
            border: '1px solid #10b981',
            background: 'rgba(16, 185, 129, 0.18)',
            color: '#6ee7b7',
            fontWeight: 600,
            fontSize: '0.8rem',
            cursor: 'pointer',
          }}
        >
          Load Starter Dungeon
        </button>

        {isGm && (
          <label
            data-testid="upload-uvtt-label"
            style={{
              padding: '0.35rem 0.7rem',
              borderRadius: '6px',
              border: '1px solid #475569',
              background: '#1e293b',
              color: '#e2e8f0',
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
          >
            Upload .uvtt Map
            <input
              type="file"
              data-testid="upload-uvtt-input"
              accept=".uvtt,.dd2vtt,application/json"
              onChange={handleUploadUvtt}
              style={{ display: 'none' }}
            />
          </label>
        )}

        <form onSubmit={handleSpawnToken} style={{ display: 'flex', gap: '0.3rem', marginLeft: '0.25rem' }}>
          <input
            type="text"
            data-testid="spawn-token-name-input"
            value={spawnTokenName}
            onInput={(e) => setSpawnTokenName((e.currentTarget as HTMLInputElement).value)}
            placeholder="New token name..."
            style={{
              width: '8.5rem',
              padding: '0.3rem 0.5rem',
              borderRadius: '6px',
              border: '1px solid #334155',
              background: '#0f172a',
              color: '#f8fafc',
              fontSize: '0.8rem',
            }}
          />
          <button
            type="submit"
            data-testid="spawn-token-btn"
            style={{
              padding: '0.3rem 0.65rem',
              borderRadius: '6px',
              border: 'none',
              background: '#2563eb',
              color: '#fff',
              fontWeight: 600,
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
          >
            + Spawn Token
          </button>
        </form>
      </div>

      {/* Selected Token Quick-HUD */}
      {selectedToken && (
        <div
          data-testid="selected-token-hud"
          style={{
            position: 'absolute',
            bottom: '0.85rem',
            left: '0.85rem',
            zIndex: 10,
            background: 'rgba(15, 23, 42, 0.94)',
            border: '1px solid #334155',
            borderRadius: '10px',
            padding: '0.65rem 0.9rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.85rem',
            color: '#f8fafc',
          }}
        >
          <div>
            <div data-testid="selected-token-name" style={{ fontWeight: 700, fontSize: '0.95rem' }}>
              {selectedToken.name}
            </div>
            <div style={{ fontSize: '0.78rem', color: '#94a3b8' }}>
              HP:{' '}
              <strong data-testid="selected-token-hp" style={{ color: '#4ade80' }}>
                {selectedToken.hp}/{selectedToken.max_hp}
              </strong>{' '}
              | Speed: <strong>{selectedToken.speed_remaining_ft}/{selectedToken.speed_max_ft} ft</strong> | Pos: (
              {Math.round(selectedToken.top_left.x)}, {Math.round(selectedToken.top_left.y)})
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              data-testid="token-damage-5-btn"
              onClick={() => handleSelectedHpDelta(-5)}
              style={{
                padding: '0.3rem 0.55rem',
                borderRadius: '6px',
                border: '1px solid #ef4444',
                background: 'rgba(239, 68, 68, 0.2)',
                color: '#fca5a5',
                fontWeight: 600,
                fontSize: '0.78rem',
                cursor: 'pointer',
              }}
            >
              -5 HP
            </button>
            <button
              type="button"
              data-testid="token-heal-5-btn"
              onClick={() => handleSelectedHpDelta(5)}
              style={{
                padding: '0.3rem 0.55rem',
                borderRadius: '6px',
                border: '1px solid #22c55e',
                background: 'rgba(34, 197, 94, 0.2)',
                color: '#86efac',
                fontWeight: 600,
                fontSize: '0.78rem',
                cursor: 'pointer',
              }}
            >
              +5 HP
            </button>

            {isGm && (
              <button
                type="button"
                data-testid="hud-gm-toggle-visibility-btn"
                onClick={() => {
                  const isHidden = ((selectedToken.visibility_channel ?? 1) & 4) !== 0;
                  globalWsClient.submitCommand({
                    cmd: 'SET_TOKEN_VISIBILITY',
                    token_id: selectedToken.id,
                    gm_hidden: !isHidden,
                    invisible: Boolean(selectedToken.invisible),
                  });
                }}
                style={{
                  padding: '0.3rem 0.65rem',
                  borderRadius: '6px',
                  border:
                    ((selectedToken.visibility_channel ?? 1) & 4) !== 0
                      ? '1px solid #10b981'
                      : '1px solid #f59e0b',
                  background:
                    ((selectedToken.visibility_channel ?? 1) & 4) !== 0
                      ? 'rgba(16, 185, 129, 0.22)'
                      : 'rgba(245, 158, 11, 0.22)',
                  color:
                    ((selectedToken.visibility_channel ?? 1) & 4) !== 0 ? '#6ee7b7' : '#fde68a',
                  fontWeight: 700,
                  fontSize: '0.78rem',
                  cursor: 'pointer',
                }}
              >
                {((selectedToken.visibility_channel ?? 1) & 4) !== 0
                  ? '👁️ Reveal to Players'
                  : '👁️‍🗨️ Hide from Players'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Assisted Roll + DM Hit Confirmation Banner */}
      {pendingHitConfirm && (
        <div
          data-testid="assisted-combat-confirm-banner"
          style={{
            position: 'absolute',
            top: '3.9rem',
            left: '0.75rem',
            zIndex: 15,
            background: 'rgba(15, 23, 42, 0.96)',
            border: '1px solid #f59e0b',
            borderRadius: '10px',
            padding: '0.65rem 0.9rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            color: '#f8fafc',
          }}
        >
          <span style={{ fontSize: '0.82rem' }}>
            ⚔️ <strong>{pendingHitConfirm.attackerName}</strong> rolled attack vs{' '}
            <strong>{pendingHitConfirm.targetName}</strong> ({pendingHitConfirm.damageExpr})
          </span>
          {isGm && (
            <button
              type="button"
              data-testid="confirm-hit-apply-damage-btn"
              onClick={() => {
                globalWsClient.submitCommand({
                  cmd: 'APPLY_DAMAGE',
                  token_id: pendingHitConfirm.targetId,
                  raw_damage: pendingHitConfirm.damageAmount,
                  affinity: 'Normal',
                });
                setPendingHitConfirm(null);
              }}
              style={{
                padding: '0.3rem 0.65rem',
                borderRadius: '6px',
                border: 'none',
                background: '#dc2626',
                color: '#fff',
                fontWeight: 700,
                fontSize: '0.76rem',
                cursor: 'pointer',
              }}
            >
              Confirm Hit (-{pendingHitConfirm.damageAmount} HP)
            </button>
          )}
          <button
            type="button"
            onClick={() => setPendingHitConfirm(null)}
            style={{
              padding: '0.25rem 0.5rem',
              borderRadius: '6px',
              border: '1px solid #475569',
              background: '#1e293b',
              color: '#cbd5e1',
              fontSize: '0.75rem',
              cursor: 'pointer',
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Desktop Right-Click Context Menu */}
      {contextMenu && (
        <div
          data-testid="table-context-menu"
          style={{
            position: 'absolute',
            left: `${Math.min(contextMenu.screenX, 900)}px`,
            top: `${Math.min(contextMenu.screenY, 550)}px`,
            zIndex: 40,
            minWidth: '220px',
            background: '#111622',
            border: '1px solid #334155',
            borderRadius: '10px',
            boxShadow: '0 12px 28px rgba(0, 0, 0, 0.65)',
            padding: '0.45rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.25rem',
          }}
        >
          {/* Context: Right-clicked on a Token */}
          {contextMenu.token && (
            <>
              <div
                style={{
                  padding: '0.3rem 0.55rem',
                  fontSize: '0.76rem',
                  fontWeight: 800,
                  color: '#93c5fd',
                  borderBottom: '1px solid #1e293b',
                }}
              >
                🎯 {contextMenu.token.name} ({contextMenu.token.hp}/{contextMenu.token.max_hp} HP)
              </div>

              <button
                type="button"
                data-testid="ctx-attack-token-btn"
                onClick={() => {
                  const target = contextMenu.token!;
                  const attackerName = selectedToken?.name ?? 'Hero';
                  globalWsClient.rollDice('1d20+5', 'Public', `${attackerName} attacks ${target.name}`);
                  const mode = combatAutomationModeSignal.value;
                  if (mode === 'FULL_AUTOMATION') {
                    globalWsClient.submitCommand({
                      cmd: 'APPLY_DAMAGE',
                      token_id: target.id,
                      raw_damage: 7,
                      affinity: 'Normal',
                    });
                  } else if (mode === 'ASSISTED_DM_CONFIRM') {
                    setPendingHitConfirm({
                      attackerName,
                      targetId: target.id,
                      targetName: target.name,
                      damageExpr: '1d8+3 (7 dmg)',
                      damageAmount: 7,
                    });
                  }
                  setContextMenu(null);
                }}
                style={{
                  textAlign: 'left',
                  padding: '0.4rem 0.6rem',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'transparent',
                  color: '#f8fafc',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                ⚔️ {t('menu.attack_melee')}
              </button>

              <button
                type="button"
                data-testid="ctx-damage-5-btn"
                onClick={() => {
                  globalWsClient.submitCommand({
                    cmd: 'APPLY_DAMAGE',
                    token_id: contextMenu.token!.id,
                    raw_damage: 5,
                    affinity: 'Normal',
                  });
                  setContextMenu(null);
                }}
                style={{
                  textAlign: 'left',
                  padding: '0.4rem 0.6rem',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'transparent',
                  color: '#fca5a5',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                💥 {t('menu.damage_5')}
              </button>

              <button
                type="button"
                data-testid="ctx-toggle-squeeze-btn"
                onClick={() => {
                  globalWsClient.submitCommand({
                    cmd: 'TOGGLE_SQUEEZE',
                    token_id: contextMenu.token!.id,
                    is_squeezing: !contextMenu.token!.is_squeezing,
                  });
                  setContextMenu(null);
                }}
                style={{
                  textAlign: 'left',
                  padding: '0.4rem 0.6rem',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'transparent',
                  color: '#e2e8f0',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                ↔️ {t('menu.toggle_squeeze')}
              </button>

              <button
                type="button"
                data-testid="ctx-open-sheet-btn"
                onClick={() => {
                  selectedTokenIdSignal.value = contextMenu.token!.id;
                  activeDrawerSignal.value = 'sheet';
                  setContextMenu(null);
                }}
                style={{
                  textAlign: 'left',
                  padding: '0.4rem 0.6rem',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'transparent',
                  color: '#c7d2fe',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                📜 Inspect Character Sheet
              </button>

              {isGm && (
                <>
                  <div style={{ height: '1px', background: '#1e293b', margin: '0.15rem 0' }} />
                  <button
                    type="button"
                    data-testid="ctx-gm-toggle-visibility-btn"
                    onClick={() => {
                      const tok = contextMenu.token!;
                      const isHidden = ((tok.visibility_channel ?? 1) & 4) !== 0;
                      globalWsClient.submitCommand({
                        cmd: 'SET_TOKEN_VISIBILITY',
                        token_id: tok.id,
                        gm_hidden: !isHidden,
                        invisible: Boolean(tok.invisible),
                      });
                      setContextMenu(null);
                    }}
                    style={{
                      textAlign: 'left',
                      padding: '0.4rem 0.6rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: 'rgba(245, 158, 11, 0.14)',
                      color: '#fde68a',
                      fontWeight: 700,
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                    }}
                  >
                    {((contextMenu.token.visibility_channel ?? 1) & 4) === 0
                      ? `👁️‍🗨️ ${t('menu.gm_hide_token')}`
                      : `👁️ ${t('menu.gm_reveal_token')}`}
                  </button>

                  <button
                    type="button"
                    data-testid="ctx-gm-assign-player-btn"
                    onClick={() => {
                      const tok = contextMenu.token!;
                      const nextOwner = tok.owner_user_id ? null : (currentUserSignal.value?.id ?? null);
                      globalWsClient.submitCommand({
                        cmd: 'ASSIGN_TOKEN_OWNER',
                        token_id: tok.id,
                        owner_user_id: nextOwner,
                      });
                      setContextMenu(null);
                    }}
                    style={{
                      textAlign: 'left',
                      padding: '0.4rem 0.6rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: 'transparent',
                      color: '#93c5fd',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                    }}
                  >
                    👤 GM: Toggle Owner Assignment
                  </button>

                  <button
                    type="button"
                    data-testid="ctx-gm-remove-token-btn"
                    onClick={() => {
                      globalWsClient.submitCommand({
                        cmd: 'REMOVE_TOKEN',
                        token_id: contextMenu.token!.id,
                      });
                      setContextMenu(null);
                    }}
                    style={{
                      textAlign: 'left',
                      padding: '0.4rem 0.6rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: 'transparent',
                      color: '#f87171',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                    }}
                  >
                    🗑️ {t('menu.gm_delete_token')}
                  </button>
                </>
              )}
            </>
          )}

          {/* Context: Right-clicked on a Door */}
          {contextMenu.door && (
            <>
              <div
                style={{
                  padding: '0.3rem 0.55rem',
                  fontSize: '0.76rem',
                  fontWeight: 800,
                  color: '#fcd34d',
                  borderBottom: '1px solid #1e293b',
                }}
              >
                🚪 Door Controls
              </div>
              <button
                type="button"
                data-testid="ctx-door-toggle-open-btn"
                onClick={() => {
                  globalWsClient.submitCommand({
                    cmd: 'TOGGLE_DOOR',
                    wall_id: contextMenu.door!.id,
                    is_open: !contextMenu.door!.is_open,
                  });
                  setContextMenu(null);
                }}
                style={{
                  textAlign: 'left',
                  padding: '0.4rem 0.6rem',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'transparent',
                  color: '#f8fafc',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                {contextMenu.door.is_open ? `🔒 ${t('menu.door_close')}` : `🔓 ${t('menu.door_open')}`}
              </button>

              {isGm && (
                <>
                  <button
                    type="button"
                    data-testid="ctx-gm-door-lock-btn"
                    onClick={() => {
                      const d = contextMenu.door!;
                      globalWsClient.submitCommand({
                        cmd: 'CONFIGURE_DOOR',
                        wall_id: d.id,
                        is_open: false,
                        is_locked: !d.is_locked,
                        is_secret: Boolean(d.is_secret),
                      });
                      setContextMenu(null);
                    }}
                    style={{
                      textAlign: 'left',
                      padding: '0.4rem 0.6rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: 'transparent',
                      color: '#fde68a',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                    }}
                  >
                    🗝️ {t('menu.gm_door_lock')}
                  </button>

                  <button
                    type="button"
                    data-testid="ctx-gm-door-secret-btn"
                    onClick={() => {
                      const d = contextMenu.door!;
                      globalWsClient.submitCommand({
                        cmd: 'CONFIGURE_DOOR',
                        wall_id: d.id,
                        is_open: d.is_open,
                        is_locked: Boolean(d.is_locked),
                        is_secret: !d.is_secret,
                      });
                      setContextMenu(null);
                    }}
                    style={{
                      textAlign: 'left',
                      padding: '0.4rem 0.6rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: 'transparent',
                      color: '#c084fc',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                    }}
                  >
                    🕵️ {t('menu.gm_door_secret')}
                  </button>
                </>
              )}
            </>
          )}

          {/* Context: Right-clicked on Empty Map Cell */}
          {!contextMenu.token && !contextMenu.door && (
            <>
              <div
                style={{
                  padding: '0.3rem 0.55rem',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  color: '#94a3b8',
                  borderBottom: '1px solid #1e293b',
                }}
              >
                📍 Cell ({Math.round(contextMenu.worldPt.x)}, {Math.round(contextMenu.worldPt.y)})
              </div>

              {selectedToken && (
                <button
                  type="button"
                  data-testid="ctx-move-selected-here-btn"
                  onClick={() => {
                    const cellPx = tableStateSignal.value?.cell_size_px || 64;
                    const snappedX = Math.floor(contextMenu.worldPt.x / cellPx) * cellPx;
                    const snappedY = Math.floor(contextMenu.worldPt.y / cellPx) * cellPx;
                    globalWsClient.submitCommand({
                      cmd: 'MOVE_TOKEN',
                      token_id: selectedToken.id,
                      to_top_left: { x: Math.max(0, snappedX), y: Math.max(0, snappedY) },
                      to_elevation_ft: null,
                      gm_teleport: false,
                    });
                    setContextMenu(null);
                  }}
                  style={{
                    textAlign: 'left',
                    padding: '0.4rem 0.6rem',
                    borderRadius: '6px',
                    border: 'none',
                    background: 'transparent',
                    color: '#f8fafc',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                  }}
                >
                  🥾 {t('menu.move_here')} ({selectedToken.name})
                </button>
              )}

              <button
                type="button"
                data-testid="ctx-cast-aoe-here-btn"
                onClick={() => {
                  globalWsClient.submitCommand({
                    cmd: 'PROJECT_AOE',
                    persist_zone: true,
                    template: {
                      id: crypto.randomUUID(),
                      caster_token_id: selectedTokenIdSignal.value ?? null,
                      requires_concentration: false,
                      elevation_ft: 0,
                      height_ft: 20,
                      shape: {
                        shape: 'SPHERE',
                        origin: contextMenu.worldPt,
                        radius_ft: aoeRadiusFt,
                      },
                    },
                  });
                  setContextMenu(null);
                }}
                style={{
                  textAlign: 'left',
                  padding: '0.4rem 0.6rem',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'transparent',
                  color: '#fbbf24',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                🔥 {t('menu.cast_aoe')}
              </button>

              <button
                type="button"
                data-testid="ctx-ping-here-btn"
                onClick={() => {
                  globalWsClient.sendPointerPing(contextMenu.worldPt, '#38bdf8');
                  setContextMenu(null);
                }}
                style={{
                  textAlign: 'left',
                  padding: '0.4rem 0.6rem',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'transparent',
                  color: '#38bdf8',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                📡 {t('menu.ping_here')}
              </button>

              {isGm && (
                <>
                  <div style={{ height: '1px', background: '#1e293b', margin: '0.15rem 0' }} />
                  {selectedToken && (
                    <button
                      type="button"
                      data-testid="ctx-gm-teleport-here-btn"
                      onClick={() => {
                        const cellPx = tableStateSignal.value?.cell_size_px || 64;
                        const snappedX = Math.floor(contextMenu.worldPt.x / cellPx) * cellPx;
                        const snappedY = Math.floor(contextMenu.worldPt.y / cellPx) * cellPx;
                        globalWsClient.submitCommand({
                          cmd: 'MOVE_TOKEN',
                          token_id: selectedToken.id,
                          to_top_left: { x: Math.max(0, snappedX), y: Math.max(0, snappedY) },
                          to_elevation_ft: null,
                          gm_teleport: true,
                        });
                        setContextMenu(null);
                      }}
                      style={{
                        textAlign: 'left',
                        padding: '0.4rem 0.6rem',
                        borderRadius: '6px',
                        border: 'none',
                        background: 'transparent',
                        color: '#c084fc',
                        fontSize: '0.8rem',
                        cursor: 'pointer',
                      }}
                    >
                      ⚡ {t('menu.gm_teleport')}
                    </button>
                  )}

                  <button
                    type="button"
                    data-testid="ctx-gm-spawn-monster-here-btn"
                    onClick={() => {
                      const cellPx = tableStateSignal.value?.cell_size_px || 64;
                      const snappedX = Math.floor(contextMenu.worldPt.x / cellPx) * cellPx;
                      const snappedY = Math.floor(contextMenu.worldPt.y / cellPx) * cellPx;
                      globalWsClient.submitCommand({
                        cmd: 'SPAWN_TOKEN',
                        token: buildDefaultSpawnTokenPayload({
                          id: crypto.randomUUID(),
                          name: 'Goblin Skirmisher',
                          owner_user_id: null,
                          top_left: { x: Math.max(0, snappedX), y: Math.max(0, snappedY) },
                          hp: 12,
                          max_hp: 12,
                          visibility_channel: 1,
                        }),
                      });
                      setContextMenu(null);
                    }}
                    style={{
                      textAlign: 'left',
                      padding: '0.4rem 0.6rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: 'rgba(239, 68, 68, 0.14)',
                      color: '#fca5a5',
                      fontWeight: 700,
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                    }}
                  >
                    👹 {t('menu.gm_spawn_monster')}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}

      <canvas
        ref={canvasRef}
        data-testid="trame-table-canvas"
        onContextMenu={handleContextMenu}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        style={{
          width: '100%',
          height: '100%',
          flex: 1,
          cursor:
            activeTool === 'ping'
              ? 'crosshair'
              : draggingTokenId
                ? 'grabbing'
                : isPanning
                  ? 'move'
                  : 'default',
        }}
      />
    </div>
  );
}
