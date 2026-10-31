import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { client as defaultClient, type ApiClient } from "../api/client.ts";
import { ViewportCamera, measureRulerWaypointsFt, type Waypoint3D } from "../canvas/SceneGraph.ts";
import { Bvh2D, type Point2D, type WallSegmentDto } from "../engine/wasmBridge.ts";
import { appSignals } from "../state/appSignals.ts";
import type { CampaignRoomState, Token, WallSegment } from "../types/index.ts";

export interface TableCanvasProps {
  children?: ComponentChildren;
  client?: ApiClient;
  roomState?: CampaignRoomState | null;
  readOnly?: boolean;
  rulerActive?: boolean;
  pingKeyActive?: boolean;
  onRecenterViewport?: () => void;
}

export class HeadlessCanvasMock {
  public readonly isHeadless = true;
  public width = 1200;
  public height = 800;
  public renderedFrames = 0;

  public renderFrame(): void {
    this.renderedFrames++;
  }
}

function isDoorWall(wall: WallSegment | WallSegmentDto): boolean {
  if (!wall) return false;
  if (typeof wall.kind === "string") {
    return wall.kind.toLowerCase().includes("door");
  }
  if (typeof wall.kind === "object" && wall.kind !== null) {
    return "Door" in wall.kind || "SecretDoor" in wall.kind || "door" in wall.kind || "secretDoor" in wall.kind;
  }
  return wall.id.toLowerCase().includes("door");
}

function isDoorOpen(wall: WallSegment | WallSegmentDto): boolean {
  if (typeof wall.kind === "object" && wall.kind !== null) {
    const k = wall.kind as Record<string, any>;
    if (k.Door && typeof k.Door.is_open === "boolean") return k.Door.is_open;
    if (k.SecretDoor && typeof k.SecretDoor.is_open === "boolean") return k.SecretDoor.is_open;
    if (typeof k.is_open === "boolean") return k.is_open;
    if (typeof k.isOpen === "boolean") return k.isOpen;
  }
  return wall.blocksMovement === false && wall.blocksVision === false;
}

export function TableCanvas(props: TableCanvasProps): JSX.Element {
  const activeClient = props.client || defaultClient;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [isHeadless, setIsHeadless] = useState(false);
  const [headlessMock] = useState(() => new HeadlessCanvasMock());
  const camera = useMemo(() => new ViewportCamera(), []);

  const liveRoomState = props.roomState ?? appSignals.tableStateSignal.value;
  const tokens = liveRoomState?.tokens ? Object.values(liveRoomState.tokens) : [];
  const walls = (liveRoomState?.walls || []) as (WallSegment | WallSegmentDto)[];
  const cellSizePx = liveRoomState?.cellSizePx || 100;
  const feetPerCell = liveRoomState?.feetPerCell || 5;

  const bvh = useMemo(() => {
    const wallDtos: WallSegmentDto[] = walls.map((w) => ({
      id: w.id,
      a: w.a,
      b: w.b,
      blocksVision: w.blocksVision,
      blocksMovement: w.blocksMovement !== false,
      bottomElevationFt: w.bottomElevationFt ?? -1000,
      topElevationFt: w.topElevationFt ?? 1000,
      kind: w.kind,
    }));
    return new Bvh2D(wallDtos);
  }, [walls]);

  const [rulerActive, setRulerActive] = useState(Boolean(props.rulerActive));
  const [rulerWaypoints, setRulerWaypoints] = useState<Waypoint3D[]>([]);
  const [rulerDistanceFt, setRulerDistanceFt] = useState<number>(0);

  const [pings, setPings] = useState<Array<{ id: string; x: number; y: number; colorHex: string; timestamp: number }>>([]);
  const [draggingTokenId, setDraggingTokenId] = useState<string | null>(null);
  const [dragCurrentPos, setDragCurrentPos] = useState<Point2D | null>(null);
  const [collisionAlert, setCollisionAlert] = useState<string | null>(null);

  useEffect(() => {
    if (props.rulerActive !== undefined) {
      setRulerActive(props.rulerActive);
    }
  }, [props.rulerActive]);

  const detectHeadlessAndInit = useCallback(() => {
    let hasWebGl = false;
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      try {
        const testCanvas = document.createElement("canvas");
        const gl = testCanvas.getContext("webgl") || testCanvas.getContext("experimental-webgl") || testCanvas.getContext("webgl2");
        hasWebGl = Boolean(gl);
      } catch {
        hasWebGl = false;
      }
    }

    if (!hasWebGl) {
      setIsHeadless(true);
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        const ev = typeof CustomEvent !== "undefined"
          ? new CustomEvent("mock-canvas-active", { detail: { headless: true } })
          : ({ type: "mock-canvas-active", detail: { headless: true } } as unknown as Event);
        window.dispatchEvent(ev);
      }
    }
  }, []);

  useEffect(() => {
    detectHeadlessAndInit();
  }, [detectHeadlessAndInit]);

  const recenter = useCallback(() => {
    camera.pan(-camera.getTransform().offsetX, -camera.getTransform().offsetY);
    props.onRecenterViewport?.();
  }, [camera, props.onRecenterViewport]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleRecenter = () => {
      recenter();
    };
    window.addEventListener("recenter-canvas-viewport", handleRecenter);
    return () => window.removeEventListener("recenter-canvas-viewport", handleRecenter);
  }, [recenter]);

  const handleTokenDragStart = (tokenId: string, initialPos: Point2D) => {
    setDraggingTokenId(tokenId);
    setDragCurrentPos(initialPos);
    setCollisionAlert(null);
  };

  const handleTokenDragComplete = (tokenId: string, targetPos: Point2D) => {
    const token = tokens.find((t) => t.id === tokenId);
    if (!token) {
      setDraggingTokenId(null);
      setDragCurrentPos(null);
      return;
    }

    const from = token.topLeft;
    const hasCollision = bvh.checkCollision(from, targetPos, token.elevationFt ?? 0);

    if (hasCollision) {
      setCollisionAlert(`Movement blocked by wall collision for token ${token.name || tokenId}`);
    } else {
      activeClient.sendCommand({
        cmd: "MOVE_TOKEN",
        token_id: tokenId,
        to_top_left: targetPos,
        to_elevation_ft: token.elevationFt ?? 0,
        gm_teleport: false,
      });
      setCollisionAlert(null);
    }

    setDraggingTokenId(null);
    setDragCurrentPos(null);
  };

  const handleDoorClick = (wall: WallSegment | WallSegmentDto) => {
    if (!isDoorWall(wall)) return;
    const currentOpen = isDoorOpen(wall);
    activeClient.sendCommand({
      cmd: "TOGGLE_DOOR",
      wall_id: wall.id,
      is_open: !currentOpen,
    });
  };

  const triggerPointerPing = (x: number, y: number, colorHex = "#38bdf8") => {
    const newPing = {
      id: `ping-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      x,
      y,
      colorHex,
      timestamp: Date.now(),
    };
    setPings((prev) => [...prev, newPing]);
    activeClient.sendEnvelope({
      type: "PointerPing",
      pos: { x, y },
      colorHex,
    });
    setTimeout(() => {
      setPings((prev) => prev.filter((p) => p.id !== newPing.id));
    }, 1500);
  };

  const handleCanvasClick = (e: MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect() || { left: 0, top: 0 };
    const screenPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const worldPos = camera.screenToWorld(screenPos);

    if (e.altKey || props.pingKeyActive) {
      triggerPointerPing(worldPos.x, worldPos.y);
      return;
    }

    if (rulerActive) {
      const next = [...rulerWaypoints, { x: worldPos.x, y: worldPos.y, elevationFt: 0 }];
      setRulerWaypoints(next);
      if (next.length >= 2) {
        const dist = measureRulerWaypointsFt(next, cellSizePx, feetPerCell, "EUCLIDEAN");
        setRulerDistanceFt(dist);
      }
    }
  };

  return (
    <section
      ref={containerRef}
      role="region"
      aria-label="Tactical Tabletop Canvas"
      data-testid="table-canvas-container"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "r" || e.key === "R") {
          setRulerActive((prev) => !prev);
        } else if (e.key === "p" || e.key === "P") {
          const center = camera.screenToWorld({ x: 600, y: 400 });
          triggerPointerPing(center.x, center.y);
        } else if (e.key === "Escape") {
          setRulerWaypoints([]);
          setRulerDistanceFt(0);
        }
      }}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: "600px",
        backgroundColor: "#070b12",
        overflow: "hidden",
        outline: "none",
      }}
    >
      {isHeadless ? (
        <div
          data-testid="headless-canvas-mock"
          aria-label="Headless Mock Canvas"
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            color: "#94a3b8",
          }}
        >
          <div data-testid="headless-status-badge" style={{ fontSize: "0.875rem", color: "#38bdf8" }}>
            HeadlessCanvasMock Active (Zero-GPU Safe)
          </div>
        </div>
      ) : (
        <canvas
          ref={canvasRef}
          data-testid="pixi-canvas-element"
          width={1200}
          height={800}
          onClick={handleCanvasClick}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      )}

      {collisionAlert && (
        <div
          role="alert"
          aria-live="assertive"
          data-testid="collision-warning-banner"
          style={{
            position: "absolute",
            top: "1rem",
            left: "50%",
            transform: "translateX(-50%)",
            backgroundColor: "#7f1d1d",
            color: "#fecaca",
            padding: "0.5rem 1rem",
            borderRadius: "4px",
            zIndex: 30,
            fontSize: "0.875rem",
            border: "1px solid #dc2626",
          }}
        >
          {collisionAlert}
        </div>
      )}

      <div
        data-testid="tokens-layer"
        aria-label="Tokens Layer"
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      >
        {tokens.map((token: Token) => (
          <div
            key={token.id}
            role="button"
            tabIndex={0}
            aria-label={`Token ${token.name || token.id}`}
            data-testid={`token-${token.id}`}
            data-token-id={token.id}
            onClick={() => handleTokenDragStart(token.id, token.topLeft)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleTokenDragComplete(token.id, {
                  x: token.topLeft.x + cellSizePx,
                  y: token.topLeft.y,
                });
              }
            }}
            style={{
              position: "absolute",
              left: `${camera.worldToScreen(token.topLeft).x}px`,
              top: `${camera.worldToScreen(token.topLeft).y}px`,
              width: `${(token.gridW || 1) * cellSizePx * camera.getTransform().scale}px`,
              height: `${(token.gridH || 1) * cellSizePx * camera.getTransform().scale}px`,
              borderRadius: "50%",
              backgroundColor: "#0284c7",
              border: "2px solid #38bdf8",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#ffffff",
              fontWeight: 600,
              fontSize: "0.75rem",
              cursor: "grab",
              pointerEvents: "auto",
            }}
          >
            {token.name?.slice(0, 3) || "TOK"}
          </div>
        ))}
      </div>

      <div
        data-testid="doors-layer"
        aria-label="Interactive Doors Layer"
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      >
        {walls.filter(isDoorWall).map((door) => {
          const isOpen = isDoorOpen(door);
          const mid = { x: (door.a.x + door.b.x) * 0.5, y: (door.a.y + door.b.y) * 0.5 };
          const screenMid = camera.worldToScreen(mid);
          return (
            <button
              type="button"
              key={door.id}
              data-testid={`door-segment-${door.id}`}
              data-door-open={String(isOpen)}
              aria-label={`Interactive Door ${door.id} (${isOpen ? "Open" : "Closed"})`}
              onClick={() => handleDoorClick(door)}
              style={{
                position: "absolute",
                left: `${screenMid.x - 12}px`,
                top: `${screenMid.y - 12}px`,
                width: "24px",
                height: "24px",
                borderRadius: "4px",
                backgroundColor: isOpen ? "#10b981" : "#f59e0b",
                color: "#0f172a",
                border: "2px solid #ffffff",
                fontSize: "0.625rem",
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                pointerEvents: "auto",
              }}
            >
              {isOpen ? "O" : "D"}
            </button>
          );
        })}
      </div>

      {rulerActive && (
        <div
          data-testid="ruler-overlay"
          aria-label="3D Ruler Overlay"
          style={{
            position: "absolute",
            top: "1rem",
            right: "1rem",
            backgroundColor: "#1e293b",
            color: "#f8fafc",
            padding: "0.5rem 0.875rem",
            borderRadius: "6px",
            border: "1px solid #38bdf8",
            boxShadow: "0 4px 6px rgba(0,0,0,0.3)",
            fontSize: "0.875rem",
            zIndex: 40,
          }}
        >
          <div style={{ fontWeight: 600, color: "#38bdf8" }}>3D Elevation Ruler</div>
          <div data-testid="ruler-distance-value" style={{ marginTop: "0.25rem" }}>
            Distance: <strong>{rulerDistanceFt.toFixed(1)} ft</strong> (Euclidean)
          </div>
          <div style={{ fontSize: "0.75rem", color: "#94a3b8", marginTop: "0.125rem" }}>
            Formula: sqrt(dx^2 + dy^2 + dz^2)
          </div>
        </div>
      )}

      <div
        data-testid="pings-layer"
        aria-label="Radar Pings Layer"
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      >
        {pings.map((p) => {
          const screenPos = camera.worldToScreen({ x: p.x, y: p.y });
          return (
            <div
              key={p.id}
              data-testid="pointer-ping"
              data-ping-id={p.id}
              style={{
                position: "absolute",
                left: `${screenPos.x - 20}px`,
                top: `${screenPos.y - 20}px`,
                width: "40px",
                height: "40px",
                borderRadius: "50%",
                border: `3px solid ${p.colorHex}`,
                backgroundColor: `${p.colorHex}33`,
                pointerEvents: "none",
                animation: "pingPulse 1.2s ease-out forwards",
              }}
            />
          );
        })}
      </div>

      <div
        style={{
          position: "absolute",
          bottom: "1rem",
          left: "1rem",
          display: "flex",
          gap: "0.5rem",
          zIndex: 20,
        }}
      >
        <button
          type="button"
          data-testid="ruler-tool-btn"
          aria-label="Toggle 3D Ruler Tool"
          aria-pressed={rulerActive}
          onClick={() => {
            setRulerActive((prev) => !prev);
            if (rulerActive) {
              setRulerWaypoints([]);
              setRulerDistanceFt(0);
            }
          }}
          style={{
            padding: "0.5rem 0.75rem",
            backgroundColor: rulerActive ? "#0284c7" : "#1e293b",
            color: "#f8fafc",
            border: "1px solid #38bdf8",
            borderRadius: "4px",
            fontSize: "0.875rem",
            cursor: "pointer",
          }}
        >
          {rulerActive ? "Ruler Active" : "3D Ruler"}
        </button>
        <button
          type="button"
          data-testid="ping-tool-btn"
          aria-label="Emit Radar Ping"
          onClick={() => {
            const center = camera.screenToWorld({ x: 600, y: 400 });
            triggerPointerPing(center.x, center.y);
          }}
          style={{
            padding: "0.5rem 0.75rem",
            backgroundColor: "#1e293b",
            color: "#38bdf8",
            border: "1px solid #334155",
            borderRadius: "4px",
            fontSize: "0.875rem",
            cursor: "pointer",
          }}
        >
          Radar Ping
        </button>
        <button
          type="button"
          data-testid="recenter-camera-btn"
          aria-label="Recenter Viewport"
          onClick={recenter}
          style={{
            padding: "0.5rem 0.75rem",
            backgroundColor: "#1e293b",
            color: "#cbd5e1",
            border: "1px solid #334155",
            borderRadius: "4px",
            fontSize: "0.875rem",
            cursor: "pointer",
          }}
        >
          Recenter
        </button>
      </div>
    </section>
  );
}
