import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { client as defaultClient, type ApiClient } from "../api/client.ts";
import { appSignals } from "../state/appSignals.ts";
import type { ClientDiceLogEntry } from "../types/index.ts";

export interface DiceTrayDrawerProps {
  children?: ComponentChildren;
  client?: ApiClient;
  embedded?: boolean;
  onClose?: () => void;
}

export function DiceTrayDrawer(props: DiceTrayDrawerProps): JSX.Element {
  const activeClient = props.client || defaultClient;
  const diceLogs = appSignals.diceLogSignal.value;

  const [formula, setFormula] = useState("2d20kh1+5");
  const [reason, setReason] = useState("Stealth check");
  const [isRolling, setIsRolling] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!isRolling || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const prefersReducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "var(--atlas-bg)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "var(--atlas-action)";
      ctx.lineWidth = 2;
      ctx.strokeRect(canvas.width / 2 - 25, canvas.height / 2 - 25, 50, 50);
      setIsRolling(false);
      return;
    }

    let frame = 0;
    let animId: number;
    const render = () => {
      frame++;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "var(--atlas-bg)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "var(--atlas-info)";
      ctx.lineWidth = 2;

      const angle = (frame * 15 * Math.PI) / 180;
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(angle);
      ctx.strokeRect(-25, -25, 50, 50);
      ctx.restore();

      if (frame < 25) {
        animId = requestAnimationFrame(render);
      } else {
        setIsRolling(false);
      }
    };
    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [isRolling]);

  const handleRollSubmit = (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    setIsRolling(true);
    activeClient.sendCommand({
      cmd: "ROLL_DICE",
      expression: formula,
      reason,
      visibility: "PUBLIC",
    });

  };

  return (
    <aside
      role="complementary"
      aria-label="3D Dice Tray & History"
      data-testid="dice-tray-drawer"
      style={{
        position: props.embedded ? "relative" : "fixed",
        top: props.embedded ? undefined : 0,
        right: props.embedded ? undefined : 0,
        bottom: props.embedded ? undefined : 0,
        width: props.embedded ? "100%" : "360px",
        height: props.embedded ? "100%" : undefined,
        maxWidth: "100vw",
        backgroundColor: "var(--atlas-bg)",
        borderLeft: props.embedded ? "none" : "1px solid var(--atlas-surface)",
        zIndex: props.embedded ? 1 : 50,
        display: "flex",
        flexDirection: "column",
        boxShadow: props.embedded ? "none" : undefined,
        color: "var(--atlas-text)",
      }}
    >
      <header style={{ padding: "1rem", borderBottom: "1px solid var(--atlas-surface)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: "1.125rem", color: "var(--atlas-action)" }}>Dice Tray</h2>
        {!props.embedded && (
          <button
            type="button"
            data-testid="close-dice-tray-btn"
            onClick={() => {
              appSignals.activeDrawerSignal.value = null;
              props.onClose?.();
            }}
            style={{ padding: "0.375rem 0.625rem", backgroundColor: "var(--atlas-border)", color: "var(--atlas-text)", border: "none", borderRadius: "4px", cursor: "pointer" }}
          >
            Close
          </button>
        )}
      </header>

      <div style={{ padding: "1rem", borderBottom: "1px solid var(--atlas-surface)" }}>
        <canvas
          ref={canvasRef}
          data-testid="dice-canvas-animation"
          width={320}
          height={100}
          style={{ width: "100%", height: "100px", backgroundColor: "var(--atlas-bg)", borderRadius: "6px", display: "block", marginBottom: "0.75rem" }}
        />

        <form onSubmit={handleRollSubmit} data-testid="dice-roll-form">
          <label htmlFor="dice-formula-input" style={{ display: "block", fontSize: "0.75rem", color: "var(--atlas-text-muted)", marginBottom: "0.25rem" }}>Dice Formula</label>
          <input
            id="dice-formula-input"
            type="text"
            value={formula}
            onInput={(e) => setFormula((e.target as HTMLInputElement).value)}
            data-testid="dice-formula-input"
            style={{ width: "100%", padding: "0.5rem", backgroundColor: "var(--atlas-bg)", border: "1px solid var(--atlas-border)", borderRadius: "4px", color: "var(--atlas-text)", marginBottom: "0.5rem" }}
          />
          <button
            type="submit"
            data-testid="roll-dice-btn"
            style={{ width: "100%", padding: "0.5rem", backgroundColor: "var(--atlas-action)", color: "var(--atlas-bg)", fontWeight: 600, border: "none", borderRadius: "4px", cursor: "pointer" }}
          >
            Roll Dice
          </button>
        </form>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "1rem" }}>
        <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "0.875rem", color: "var(--atlas-text-muted)" }}>Roll Log</h3>
        <div role="log" aria-label="Dice Log Entries" data-testid="dice-log-list">
          {diceLogs.map((log) => (
            <div
              key={log.rollId}
              data-testid={`dice-log-${log.rollId}`}
              style={{
                padding: "0.5rem",
                backgroundColor: "var(--atlas-surface)",
                borderRadius: "4px",
                border: "1px solid var(--atlas-surface)",
                marginBottom: "0.5rem",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <span style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>{log.reason || "Roll"}</span>
                <div style={{ fontSize: "0.875rem", color: "var(--atlas-info)" }}>{log.expression}</div>
              </div>
              <div style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--atlas-action)" }}>
                {log.total ?? "?"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
