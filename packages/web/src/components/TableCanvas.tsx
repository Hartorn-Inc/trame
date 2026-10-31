import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { client, type ApiClient } from "../api/client.ts";
import { ViewportCamera, measureRulerWaypointsFt, type Waypoint3D } from "../canvas/SceneGraph.ts";
import { Bvh2D, type Point2D, type WallSegmentDto } from "../engine/wasmBridge.ts";
import { appSignals, mutateActorPosition } from "../state/appSignals.ts";
import type { CampaignRoomState, Token, TrameCommand, WallSegment } from "../types/index.ts";

export class HeadlessCanvasMock {
  public width: number;
  public height: number;
  public destroyed = false;
  public isHeadless = true;
  public stage = { children: [] as unknown[] };
  public canvas: unknown = null;

  constructor(options?: { width?: number; height?: number }) {
    this.width = options?.width ?? 1200;
    this.height = options?.height ?? 800;
  }

  public render(): void {}
  public destroy(): void {
    this.destroyed = true;
  }
}

export function isWebGLAvailable(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    if (!canvas || typeof canvas.getContext !== "function") return false;
    return Boolean(
      (window as unknown as { WebGLRenderingContext?: unknown }).WebGLRenderingContext &&
        (canvas.getContext("webgl2") ||
          canvas.getContext("webgl") ||
          canvas.getContext("experimental-webgl")),
    );
  } catch {
    return false;
  }
}

export function isDoorSegment(wall: WallSegment): boolean {
  if (wall.id && wall.id.toLowerCase().includes("door")) return true;
  if (typeof wall.kind === "string") {
    const k = wall.kind.toUpperCase();
    return k === "DOOR" || k === "SECRETDOOR" || k === "SECRET_DOOR";
  }
  if (typeof wall.kind === "object" && wall.kind !== null) {
    const obj = wall.kind as Record<string, unknown>;
    if ("Door" in obj || "SecretDoor" in obj) return true;
    if (typeof obj.kind === "string") {
      const k = obj.kind.toUpperCase();
      return k === "DOOR" || k === "SECRETDOOR" || k === "SECRET_DOOR";
    }
  }
  return false;
}

export function isDoorOpen(wall: WallSegment): boolean {
  if (typeof wall.kind === "object" && wall.kind !== null) {
    const obj = wall.kind as Record<string, unknown>;
    if (typeof obj.is_open === "boolean") return obj.is_open;
    if (typeof obj.isOpen === "boolean") return obj.isOpen;
    if (typeof obj.Door === "object" && obj.Door !== null) {
      return Boolean(
        (obj.Door as Record<string, unknown>).is_open ??
          (obj.Door as Record<string, unknown>).isOpen,
      );
    }
    if (typeof obj.SecretDoor === "object" && obj.SecretDoor !== null) {
      return Boolean(
        (obj.SecretDoor as Record<string, unknown>).is_open ??
          (obj.SecretDoor as Record<string, unknown>).isOpen,
      );
    }
  }
  return false;
}

export interface TableCanvasProps {
  children?: ComponentChildren;
  campaignId?: string;
  client?: ApiClient;
  tableState?: CampaignRoomState | null;
  activeTokenId?: string | null;
  onSelectToken?: (tokenId: string | null) => void;
  onMoveToken?: (command: TrameCommand) => void;
  onToggleDoor?: (command: TrameCommand) => void;
  onPointerPing?: (ping: { x: number; y: number; colorHex?: string }) => void;
  onCollisionCheck?: (collided: boolean, tokenId: string, targetPos: Point2D) => void;
  onRecenter?: () => void;
}

export function TableCanvas(props: TableCanvasProps): JSX.Element {
  const activeClient = props.client || client;
  const activeTableState = props.tableState !== undefined ? props.tableState : appSignals.tableStateSignal.value;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<ViewportCamera>(new ViewportCamera());

  const [headlessMock, setHeadlessMock] = useState<HeadlessCanvasMock | null>(null);
  const [, setCameraTransform] = useState(cameraRef.current.getTransform());

  const [isRulerActive, setIsRulerActive] = useState(false);
  const [rulerWaypoints, setRulerWaypoints] = useState<Waypoint3D[]>([]);
  const [rulerElevationFt, setRulerElevationFt] = useState(0);
  const rulerElevationRef = useRef(0);
  rulerElevationRef.current = rulerElevationFt;

  const [isPingToolActive, setIsPingToolActive] = useState(false);
  const [pings, setPings] = useState<Array<{ id: string; x: number; y: number; color: string; timestamp: number }>>([]);

  const dragRef = useRef<{ id: string; currentPos: Point2D } | null>(null);
  const [, setDragRenderTick] = useState(0);

  useEffect(() => {
    if (!isWebGLAvailable()) {
      const mock = new HeadlessCanvasMock({
        width: activeTableState?.mapWidthPx ?? 1200,
        height: activeTableState?.mapHeightPx ?? 800,
      });
      setHeadlessMock(mock);
      if (typeof window !== "undefined") {
        const event =
          typeof CustomEvent !== "undefined"
            ? new CustomEvent("mock-canvas-active", { detail: { mock, headless: true } })
            : ({ type: "mock-canvas-active", detail: { mock, headless: true } } as unknown as Event);
        window.dispatchEvent(event);
      }
      return () => {
        mock.destroy();
      };
    }

    let cancelled = false;
    let appInstance: { destroy: (removeView?: boolean) => void; canvas?: unknown } | null = null;

    (async () => {
      try {
        const { Application } = await import("pixi.js");
        if (cancelled) return;
        const app = new Application();
        await app.init({
          width: activeTableState?.mapWidthPx ?? 1200,
          height: activeTableState?.mapHeightPx ?? 800,
          backgroundColor: 0x0b0f19,
          preference: "webgl",
        });
        if (cancelled) {
          app.destroy(true);
          return;
        }
        appInstance = app;
        if (containerRef.current && (app as unknown as { canvas: Node }).canvas) {
          containerRef.current.appendChild((app as unknown as { canvas: Node }).canvas);
        }
      } catch (_err) {
        const mock = new HeadlessCanvasMock();
        setHeadlessMock(mock);
        if (typeof window !== "undefined") {
          const event =
            typeof CustomEvent !== "undefined"
              ? new CustomEvent("mock-canvas-active", { detail: { mock, headless: true } })
              : ({ type: "mock-canvas-active", detail: { mock, headless: true } } as unknown as Event);
          window.dispatchEvent(event);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (appInstance) {
        appInstance.destroy(true);
      }
    };
  }, []);

  useEffect(() => {
    const handleRecenter = () => {
      cameraRef.current = new ViewportCamera();
      setCameraTransform(cameraRef.current.getTransform());
      props.onRecenter?.();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("recenter-viewport", handleRecenter);
      return () => window.removeEventListener("recenter-viewport", handleRecenter);
    }
  }, [props.onRecenter]);

  const recenter = () => {
    cameraRef.current = new ViewportCamera();
    setCameraTransform(cameraRef.current.getTransform());
    props.onRecenter?.();
  };

  const handleDoorClick = (doorId: string) => {
    const walls = activeTableState?.walls || [];
    const wall = walls.find((w) => w.id === doorId);
    const isOpen = wall ? isDoorOpen(wall) : false;

    const toggleCmd: TrameCommand = {
      cmd: "TOGGLE_DOOR",
      wall_id: doorId,
      is_open: !isOpen,
    };
    activeClient.sendCommand(toggleCmd);
    props.onToggleDoor?.(toggleCmd);
  };

  const handleTokenDragEnd = (tokenId: string, targetPos: Point2D) => {
    const token = activeTableState?.tokens?.[tokenId];
    if (!token) return;

    const walls = (activeTableState?.walls || []).map((w) => ({
      id: w.id,
      a: w.a,
      b: w.b,
      blocksVision: w.blocksVision,
      blocksMovement: w.blocksMovement !== false,
      bottomElevationFt: w.bottomElevationFt,
      topElevationFt: w.topElevationFt,
    } as WallSegmentDto));

    const bvh = new Bvh2D(walls);
    const collides = bvh.checkMovementCollision(token.topLeft, targetPos);
    props.onCollisionCheck?.(collides, tokenId, targetPos);

    const moveCmd: TrameCommand = {
      cmd: "MOVE_TOKEN",
      token_id: tokenId,
      to_top_left: targetPos,
      to_elevation_ft: token.elevationFt ?? 0,
      gm_teleport: false,
    };

    activeClient.sendCommand(moveCmd);
    props.onMoveToken?.(moveCmd);
    mutateActorPosition(tokenId, targetPos, token.elevationFt);
    dragRef.current = null;
    setDragRenderTick((tick) => tick + 1);
  };

  const handleSurfaceClick = (e: MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const clickX = rect ? e.clientX - rect.left : e.clientX || 0;
    const clickY = rect ? e.clientY - rect.top : e.clientY || 0;

    if (e.shiftKey || e.altKey || e.ctrlKey || isPingToolActive) {
      const newPing = {
        id: `ping-${Date.now()}`,
        x: clickX,
        y: clickY,
        color: "#f59e0b",
        timestamp: Date.now(),
      };
      setPings((prev) => [...prev, newPing]);
      activeClient.sendPointerPing({ x: clickX, y: clickY }, "#f59e0b");
      props.onPointerPing?.({ x: clickX, y: clickY, colorHex: "#f59e0b" });
      return;
    }

    if (isRulerActive) {
      const targetElev = rulerElevationRef.current;
      setRulerWaypoints((prev) => {
        if (prev.length === 0 || prev.length >= 2) {
          return [{ x: clickX, y: clickY, elevationFt: 0 }];
        }
        return [...prev, { x: clickX, y: clickY, elevationFt: targetElev }];
      });
    }
  };

  const cellSizePx = activeTableState?.cellSizePx || 100;
  const feetPerCell = activeTableState?.feetPerCell || 5;
  const pxPerFt = cellSizePx / feetPerCell;

  let rulerDistanceFt = 0;
  if (rulerWaypoints.length >= 2) {
    const p1 = rulerWaypoints[0];
    const p2 = rulerWaypoints[1];
    const dxFt = Math.abs(p2.x - p1.x) / pxPerFt;
    const dyFt = Math.abs(p2.y - p1.y) / pxPerFt;
    const dzFt = Math.abs((p2.elevationFt ?? 0) - (p1.elevationFt ?? 0));
    rulerDistanceFt = Math.sqrt(dxFt * dxFt + dyFt * dyFt + dzFt * dzFt);
  }

  const tokens = Object.values(activeTableState?.tokens || {});
  const walls = activeTableState?.walls || [];

  return (
    <div
      data-testid="table-canvas-container"
      role="region"
      aria-label="Tabletop Canvas"
      tabIndex={0}
      ref={containerRef}
      onClick={handleSurfaceClick}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: "600px",
        backgroundColor: "#0b0f19",
        overflow: "hidden",
        userSelect: "none",
        outline: "2px solid transparent",
        outlineOffset: "-2px",
      }}
      onFocus={(e) => {
        if (e.currentTarget === e.target) {
          e.currentTarget.style.outline = "2px solid #38bdf8";
        }
      }}
      onBlur={(e) => {
        e.currentTarget.style.outline = "2px solid transparent";
      }}
    >
      {headlessMock && (
        <div
          data-testid="headless-canvas-mock"
          aria-hidden="true"
          style={{ display: "none" }}
        />
      )}

      <div
        role={"toolbar" as unknown as undefined}
        aria-label="Table Canvas Tools"
        style={{
          position: "absolute",
          top: "1rem",
          left: "1rem",
          zIndex: 40,
          display: "flex",
          gap: "0.5rem",
          backgroundColor: "rgba(19, 26, 42, 0.9)",
          padding: "0.5rem",
          borderRadius: "6px",
          border: "1px solid #1e293b",
        }}
      >
        <button
          type="button"
          data-testid="tool-ruler-btn"
          aria-pressed={isRulerActive}
          aria-label="3D Distance Ruler Tool"
          onClick={(e) => {
            e.stopPropagation();
            setIsRulerActive(!isRulerActive);
            if (isRulerActive) setRulerWaypoints([]);
          }}
          style={{
            padding: "0.375rem 0.75rem",
            backgroundColor: isRulerActive ? "#38bdf8" : "#1e293b",
            color: isRulerActive ? "#0f172a" : "#f8fafc",
            border: "1px solid #334155",
            borderRadius: "4px",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          3D Ruler
        </button>

        <button
          type="button"
          data-testid="tool-ping-btn"
          aria-pressed={isPingToolActive}
          aria-label="PointerPing Tool"
          onClick={(e) => {
            e.stopPropagation();
            setIsPingToolActive(!isPingToolActive);
          }}
          style={{
            padding: "0.375rem 0.75rem",
            backgroundColor: isPingToolActive ? "#f59e0b" : "#1e293b",
            color: isPingToolActive ? "#0f172a" : "#f8fafc",
            border: "1px solid #334155",
            borderRadius: "4px",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Ping
        </button>

        <button
          type="button"
          data-testid="recenter-viewport-btn"
          aria-label="Re-center Viewport"
          onClick={(e) => {
            e.stopPropagation();
            recenter();
          }}
          style={{
            padding: "0.375rem 0.75rem",
            backgroundColor: "#1e293b",
            color: "#cbd5e1",
            border: "1px solid #334155",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          Center
        </button>

        {isRulerActive && (
          <label
            htmlFor="ruler-elevation-input"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.25rem",
              fontSize: "0.75rem",
              color: "#94a3b8",
            }}
          >
            Elev (ft):
            <input
              id="ruler-elevation-input"
              type="number"
              data-testid="ruler-elevation-input"
              value={rulerElevationFt}
              onInput={(e) => {
                const val = Number((e.target as HTMLInputElement).value) || 0;
                setRulerElevationFt(val);
                rulerElevationRef.current = val;
              }}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "50px",
                backgroundColor: "#0f172a",
                color: "#f8fafc",
                border: "1px solid #334155",
                borderRadius: "4px",
                padding: "0.25rem",
              }}
            />
          </label>
        )}
      </div>

      <svg
        data-testid="table-walls-overlay"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      >
        {walls.map((wall) => {
          const isInteractiveDoor = isDoorSegment(wall);
          const isOpen = isDoorOpen(wall);
          return (
            <g key={wall.id}>
              <line
                x1={wall.a.x}
                y1={wall.a.y}
                x2={wall.b.x}
                y2={wall.b.y}
                stroke={isInteractiveDoor ? (isOpen ? "#22c55e" : "#eab308") : "#64748b"}
                strokeWidth={isInteractiveDoor ? "6" : "4"}
                strokeDasharray={isOpen ? "4,4" : undefined}
              />
              {isInteractiveDoor && (
                <circle
                  data-testid={`door-${wall.id}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`Toggle door ${wall.id}`}
                  cx={(wall.a.x + wall.b.x) / 2}
                  cy={(wall.a.y + wall.b.y) / 2}
                  r="14"
                  fill={isOpen ? "#15803d" : "#ca8a04"}
                  stroke="#ffffff"
                  strokeWidth="2"
                  style={{ cursor: "pointer", pointerEvents: "auto" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDoorClick(wall.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleDoorClick(wall.id);
                    }
                  }}
                />
              )}
            </g>
          );
        })}
      </svg>

      {tokens.map((tok) => {
        const isDragging = dragRef.current?.id === tok.id;
        const posX = isDragging && dragRef.current ? dragRef.current.currentPos.x : tok.topLeft.x;
        const posY = isDragging && dragRef.current ? dragRef.current.currentPos.y : tok.topLeft.y;

        return (
          <div
            key={tok.id}
            data-testid={`token-${tok.id}`}
            role="button"
            aria-label={`Token ${tok.name}`}
            tabIndex={0}
            style={{
              position: "absolute",
              left: `${posX}px`,
              top: `${posY}px`,
              width: "60px",
              height: "60px",
              borderRadius: "50%",
              backgroundColor: "#0284c7",
              border: "2px solid #38bdf8",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#ffffff",
              fontSize: "0.75rem",
              fontWeight: 600,
              cursor: isDragging ? "grabbing" : "grab",
              boxShadow: "0 4px 6px rgba(0,0,0,0.5)",
              zIndex: isDragging ? 30 : 10,
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              dragRef.current = { id: tok.id, currentPos: { ...tok.topLeft } };
              setDragRenderTick((tick) => tick + 1);
            }}
            onPointerMove={(e) => {
              if (dragRef.current && dragRef.current.id === tok.id) {
                e.stopPropagation();
                const rect = containerRef.current?.getBoundingClientRect();
                const x = rect ? e.clientX - rect.left : e.clientX || 0;
                const y = rect ? e.clientY - rect.top : e.clientY || 0;
                dragRef.current.currentPos = { x, y };
                setDragRenderTick((tick) => tick + 1);
              }
            }}
            onPointerUp={(e) => {
              if (dragRef.current && dragRef.current.id === tok.id) {
                e.stopPropagation();
                const endPos = dragRef.current.currentPos;
                handleTokenDragEnd(tok.id, endPos);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") handleTokenDragEnd(tok.id, { x: tok.topLeft.x + 50, y: tok.topLeft.y });
              if (e.key === "ArrowLeft") handleTokenDragEnd(tok.id, { x: tok.topLeft.x - 50, y: tok.topLeft.y });
              if (e.key === "ArrowUp") handleTokenDragEnd(tok.id, { x: tok.topLeft.x, y: tok.topLeft.y - 50 });
              if (e.key === "ArrowDown") handleTokenDragEnd(tok.id, { x: tok.topLeft.x, y: tok.topLeft.y + 50 });
            }}
          >
            {tok.name.slice(0, 3)}
          </div>
        );
      })}

      {isRulerActive && rulerWaypoints.length >= 2 && (
        <div data-testid="ruler-line-overlay" style={{ pointerEvents: "none" }}>
          <svg
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
            }}
          >
            <line
              x1={rulerWaypoints[0].x}
              y1={rulerWaypoints[0].y}
              x2={rulerWaypoints[1].x}
              y2={rulerWaypoints[1].y}
              stroke="#38bdf8"
              strokeWidth="2"
              strokeDasharray="5,5"
            />
          </svg>
          <div
            data-testid="ruler-distance-label"
            aria-label={`Distance: ${rulerDistanceFt.toFixed(1)} ft`}
            style={{
              position: "absolute",
              left: `${(rulerWaypoints[0].x + rulerWaypoints[1].x) / 2}px`,
              top: `${(rulerWaypoints[0].y + rulerWaypoints[1].y) / 2 - 20}px`,
              backgroundColor: "#0f172a",
              color: "#38bdf8",
              padding: "0.25rem 0.5rem",
              borderRadius: "4px",
              border: "1px solid #38bdf8",
              fontSize: "0.75rem",
              fontWeight: 600,
              transform: "translate(-50%, -50%)",
            }}
          >
            {rulerDistanceFt.toFixed(1)} ft
          </div>
        </div>
      )}

      {pings.map((ping) => (
        <div
          key={ping.id}
          data-testid="pointer-ping"
          style={{
            position: "absolute",
            left: `${ping.x}px`,
            top: `${ping.y}px`,
            width: "36px",
            height: "36px",
            borderRadius: "50%",
            border: "2px solid #f59e0b",
            backgroundColor: "rgba(245, 158, 11, 0.2)",
            transform: "translate(-50%, -50%)",
            pointerEvents: "none",
            animation: "pulse 1.5s infinite",
          }}
        />
      ))}
    </div>
  );
}
