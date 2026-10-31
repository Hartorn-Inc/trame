import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { Application } from "pixi.js";
import { getCanvasThemePalette } from "../canvas/CanvasThemePalette.ts";
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

function checkWebGlSupport(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  try {
    const testCanvas = document.createElement("canvas");
    if (!testCanvas || typeof testCanvas.getContext !== "function") {
      return false;
    }
    const gl =
      testCanvas.getContext("webgl") ||
      testCanvas.getContext("experimental-webgl") ||
      testCanvas.getContext("webgl2");
    return Boolean(gl);
  } catch {
    return false;
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

  const [isHeadless, setIsHeadless] = useState(() => !checkWebGlSupport());
  const [headlessMock] = useState(() => new HeadlessCanvasMock());
  const pixiAppRef = useRef<Application | null>(null);
  const camera = useMemo(() => new ViewportCamera(), []);
  const [, setCameraRevision] = useState(0);

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

  useEffect(() => {
    if (isHeadless) {
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        const ev = typeof CustomEvent !== "undefined"
          ? new CustomEvent("mock-canvas-active", { detail: { headless: true } })
          : ({ type: "mock-canvas-active", detail: { headless: true } } as unknown as Event);
        window.dispatchEvent(ev);
      }
    }
  }, [isHeadless]);

  useEffect(() => {
    if (isHeadless || !canvasRef.current) return;

    let isDestroyed = false;
    const app = new Application();
    pixiAppRef.current = app;

    app
      .init({
        canvas: canvasRef.current,
        width: 1200,
        height: 800,
        backgroundColor: getCanvasThemePalette("dark").fogUnexploredHex,
      })
      .then(() => {
        if (isDestroyed) {
          try {
            app.destroy();
          } catch {
            // ignore
          }
        }
      })
      .catch(() => {
        if (!isDestroyed) {
          setIsHeadless(true);
        }
      });

    return () => {
      isDestroyed = true;
      if (pixiAppRef.current) {
        try {
          pixiAppRef.current.destroy();
        } catch {
          // ignore
        }
        pixiAppRef.current = null;
      }
    };
  }, [isHeadless]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handlePeerPing = (event: Event) => {
      const detail = (event as CustomEvent)?.detail as
        | { pos?: { x: number; y: number }; colorHex?: string; color_hex?: string }
        | undefined;
      const pos = detail?.pos;
      if (pos) {
        const pingId = `ping-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const newPing = {
          id: pingId,
          x: pos.x,
          y: pos.y,
          colorHex: detail?.colorHex || detail?.color_hex || "var(--atlas-info)",
          timestamp: Date.now(),
        };
        setPings((prev) => [...prev, newPing]);
        setTimeout(() => {
          setPings((prev) => prev.filter((p) => p.id !== pingId));
        }, 1500);
      }
    };
    window.addEventListener("trame-pointer-ping", handlePeerPing);
    return () => window.removeEventListener("trame-pointer-ping", handlePeerPing);
  }, []);

  const recenter = useCallback(() => {
    camera.pan(-camera.getTransform().offsetX, -camera.getTransform().offsetY);
    setCameraRevision((prev) => prev + 1);
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

  const triggerPointerPing = (x: number, y: number, colorHex = "var(--atlas-info)") => {
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
    const targetElement = (canvasRef.current || (e.currentTarget as HTMLElement) || containerRef.current);
    const rect = targetElement?.getBoundingClientRect() || { left: 0, top: 0 };
    const clientX = e.clientX ?? 0;
    const clientY = e.clientY ?? 0;
    const screenPos = { x: clientX - rect.left, y: clientY - rect.top };
    const worldPos = camera.screenToWorld(screenPos);

    if (e.altKey || props.pingKeyActive) {
      triggerPointerPing(worldPos.x, worldPos.y);
      return;
    }

    if (draggingTokenId) {
      handleTokenDragComplete(draggingTokenId, worldPos);
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
          setDraggingTokenId(null);
          setDragCurrentPos(null);
          setCollisionAlert(null);
        }
      }}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: "600px",
        backgroundColor: "var(--atlas-bg)",
        overflow: "hidden",
        outline: "2px solid var(--atlas-info)",
      }}
    >
      {isHeadless ? (
        <div
          data-testid="headless-canvas-mock"
          aria-label="Headless Mock Canvas"
          onClick={handleCanvasClick}
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--atlas-text-muted)",
            cursor: draggingTokenId ? "crosshair" : "default",
          }}
        >
          <div data-testid="headless-status-badge" style={{ fontSize: "0.875rem", color: "var(--atlas-info)" }}>
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
            backgroundColor: "var(--atlas-danger)",
            color: "var(--atlas-danger)",
            padding: "0.5rem 1rem",
            borderRadius: "4px",
            zIndex: 30,
            fontSize: "0.875rem",
            border: "1px solid var(--atlas-danger)",
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
        {tokens.map((token: Token) => {
          const isSelected = token.id === draggingTokenId;
          return (
            <div
              key={token.id}
              role="button"
              tabIndex={0}
              aria-label={`Token ${token.name || token.id}`}
              aria-pressed={isSelected}
              data-testid={`token-${token.id}`}
              data-token-id={token.id}
              onClick={(e) => {
                e?.stopPropagation?.();
                if (draggingTokenId === token.id) {
                  setDraggingTokenId(null);
                  setDragCurrentPos(null);
                } else {
                  handleTokenDragStart(token.id, token.topLeft);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleTokenDragComplete(token.id, {
                    x: token.topLeft.x + cellSizePx,
                    y: token.topLeft.y,
                  });
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  handleTokenDragComplete(token.id, {
                    x: token.topLeft.x,
                    y: token.topLeft.y - cellSizePx,
                  });
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  handleTokenDragComplete(token.id, {
                    x: token.topLeft.x,
                    y: token.topLeft.y + cellSizePx,
                  });
                } else if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  handleTokenDragComplete(token.id, {
                    x: token.topLeft.x - cellSizePx,
                    y: token.topLeft.y,
                  });
                } else if (e.key === "ArrowRight") {
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
                backgroundColor: isSelected ? "var(--atlas-action)" : "var(--atlas-info)",
                border: isSelected ? "3px solid var(--atlas-action)" : "2px solid var(--atlas-info)",
                boxShadow: isSelected ? "0 0 0 3px var(--atlas-surface-raised), 0 0 12px var(--atlas-action)" : undefined,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: isSelected ? "var(--atlas-bg)" : "var(--atlas-text)",
                fontWeight: 600,
                fontSize: "0.75rem",
                cursor: isSelected ? "grabbing" : "grab",
                pointerEvents: "auto",
              }}
            >
              {token.name?.slice(0, 3) || "TOK"}
            </div>
          );
        })}
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
                backgroundColor: isOpen ? "var(--atlas-success)" : "var(--atlas-action)",
                color: "var(--atlas-bg)",
                border: "2px solid var(--atlas-text)",
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
            backgroundColor: "var(--atlas-surface)",
            color: "var(--atlas-text)",
            padding: "0.5rem 0.875rem",
            borderRadius: "6px",
            border: "1px solid var(--atlas-info)",
            boxShadow: "0 4px 6px var(--atlas-surface-raised)",
            fontSize: "0.875rem",
            zIndex: 40,
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--atlas-info)" }}>3D Elevation Ruler</div>
          <div data-testid="ruler-distance-value" style={{ marginTop: "0.25rem" }}>
            Distance: <strong>{rulerDistanceFt.toFixed(1)} ft</strong> (Euclidean)
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)", marginTop: "0.125rem" }}>
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
            backgroundColor: rulerActive ? "var(--atlas-info)" : "var(--atlas-surface)",
            color: "var(--atlas-text)",
            border: "1px solid var(--atlas-info)",
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
            backgroundColor: "var(--atlas-surface)",
            color: "var(--atlas-info)",
            border: "1px solid var(--atlas-border)",
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
            backgroundColor: "var(--atlas-surface)",
            color: "var(--atlas-text-muted)",
            border: "1px solid var(--atlas-border)",
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
