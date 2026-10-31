import { useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { client as defaultClient, type ApiClient } from "../api/client.ts";
import { AMBIENT_PRESETS, type AmbientPreset } from "../hud/gmOverrideToolbar.ts";
import { appSignals } from "../state/appSignals.ts";
import type { TableMode } from "../types/index.ts";

export interface GmOverrideToolbarProps {
  children?: ComponentChildren;
  client?: ApiClient;
  campaignId?: string;
  isGm?: boolean;
  onRecenterViewport?: () => void;
}

export function GmOverrideToolbar(props: GmOverrideToolbarProps): JSX.Element | null {
  const activeClient = props.client || defaultClient;
  const user = appSignals.authUserSignal.value;
  const activeCampaign = appSignals.activeCampaignSignal.value;
  const currentRoomState = appSignals.tableStateSignal.value;

  const isGm = Boolean(props.isGm || user?.role === "GM" || activeCampaign?.role === "GM");
  const campaignId = props.campaignId || activeCampaign?.id || currentRoomState?.campaignId || "";

  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeEffectDesc, setActiveEffectDesc] = useState("");

  if (!isGm) {
    return null;
  }

  const currentMode: TableMode = currentRoomState?.mode || "EXPLORATION";
  const currentAmbient: AmbientPreset = currentRoomState?.ambientLighting || "DAYLIGHT";

  const handleModeToggle = (targetMode: TableMode) => {
    activeClient.sendCommand({
      cmd: "SET_TABLE_MODE",
      mode: targetMode,
      exploration_paused: false,
      initiative_order: currentRoomState?.initiativeOrder || [],
    });
    if (appSignals.tableStateSignal.value) {
      appSignals.tableStateSignal.value = {
        ...appSignals.tableStateSignal.value,
        mode: targetMode,
      };
    }
    setStatusMessage(`Table mode set to ${targetMode}`);
  };

  const handleAmbientChange = (preset: AmbientPreset) => {
    activeClient.sendCommand({
      cmd: "SET_AMBIENT_LIGHTING",
      preset,
    });
    if (appSignals.tableStateSignal.value) {
      appSignals.tableStateSignal.value = {
        ...appSignals.tableStateSignal.value,
        ambientLighting: preset,
      };
    }
    setStatusMessage(`Ambient lighting updated to ${preset}`);
  };

  const handleLoadStarterDungeon = async () => {
    if (!campaignId) {
      setErrorMessage("No active campaign selected to load starter dungeon.");
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      await activeClient.loadStarterDungeon(campaignId);
      props.onRecenterViewport?.();
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        window.dispatchEvent(new CustomEvent("recenter-canvas-viewport"));
      }
      setStatusMessage("Starter dungeon loaded successfully and viewport re-centered.");
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to load starter dungeon");
    } finally {
      setLoading(false);
    }
  };

  const handleUvttUpload = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file || !campaignId) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      await activeClient.importUvttMap(campaignId, file);
      props.onRecenterViewport?.();
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        window.dispatchEvent(new CustomEvent("recenter-canvas-viewport"));
      }
      setStatusMessage(`UVTT battlemap "${file.name}" imported successfully.`);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to upload UVTT battlemap");
    } finally {
      setLoading(false);
      target.value = "";
    }
  };

  const handleApplyActiveEffect = () => {
    if (!activeEffectDesc.trim()) return;
    activeClient.sendCommand({
      cmd: "APPLY_ACTIVE_EFFECT",
      effect: {
        description: activeEffectDesc.trim(),
        appliedBy: user?.displayName || "GM",
        timestamp: Date.now(),
      },
    });
    setStatusMessage(`ActiveEffect "${activeEffectDesc.trim()}" applied.`);
    setActiveEffectDesc("");
  };

  const handleUndo = () => {
    activeClient.sendCommand({
      cmd: "UNDO_LAST_ACTION",
    });
    setStatusMessage("Dispatched UndoLastAction to table server.");
  };

  return (
    <aside
      role="toolbar"
      aria-label="Game Master Omnipotent Override Toolbar"
      data-testid="gm-override-toolbar"
      style={{
        backgroundColor: "#0f172a",
        border: "1px solid #1e293b",
        borderRadius: "6px",
        padding: "0.75rem 1rem",
        color: "#f8fafc",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "0.75rem",
        boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.4)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "#f59e0b", textTransform: "uppercase" }}>
          GM Mode
        </span>
        <div role="group" aria-label="Table Play Mode" style={{ display: "flex", borderRadius: "4px", overflow: "hidden" }}>
          <button
            type="button"
            data-testid="mode-exploration-btn"
            aria-pressed={currentMode === "EXPLORATION"}
            onClick={() => handleModeToggle("EXPLORATION")}
            style={{
              padding: "0.375rem 0.75rem",
              backgroundColor: currentMode === "EXPLORATION" ? "#f59e0b" : "#1e293b",
              color: currentMode === "EXPLORATION" ? "#0f172a" : "#cbd5e1",
              border: "none",
              fontWeight: 600,
              fontSize: "0.75rem",
              cursor: "pointer",
            }}
          >
            Exploration
          </button>
          <button
            type="button"
            data-testid="mode-turn-by-turn-btn"
            aria-pressed={currentMode === "TURN_BY_TURN"}
            onClick={() => handleModeToggle("TURN_BY_TURN")}
            style={{
              padding: "0.375rem 0.75rem",
              backgroundColor: currentMode === "TURN_BY_TURN" ? "#f59e0b" : "#1e293b",
              color: currentMode === "TURN_BY_TURN" ? "#0f172a" : "#cbd5e1",
              border: "none",
              fontWeight: 600,
              fontSize: "0.75rem",
              cursor: "pointer",
            }}
          >
            Turn-by-Turn
          </button>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
        <label htmlFor="ambient-preset-select" style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
          Lighting:
        </label>
        <select
          id="ambient-preset-select"
          data-testid="ambient-preset-select"
          value={currentAmbient}
          onChange={(e) => handleAmbientChange((e.target as HTMLSelectElement).value as AmbientPreset)}
          style={{
            backgroundColor: "#1e293b",
            color: "#f8fafc",
            border: "1px solid #334155",
            borderRadius: "4px",
            padding: "0.375rem 0.5rem",
            fontSize: "0.75rem",
          }}
        >
          {Object.keys(AMBIENT_PRESETS).map((preset) => (
            <option key={preset} value={preset}>
              {preset}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <button
          type="button"
          data-testid="load-starter-dungeon-btn"
          disabled={loading}
          onClick={handleLoadStarterDungeon}
          style={{
            padding: "0.375rem 0.75rem",
            backgroundColor: "#0284c7",
            color: "#ffffff",
            border: "none",
            borderRadius: "4px",
            fontSize: "0.75rem",
            fontWeight: 600,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Loading..." : "Load Starter Dungeon"}
        </button>

        <label
          role={"button" as any}
          data-testid="upload-uvtt-btn"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              (e.currentTarget.querySelector('input[type="file"]') as HTMLInputElement | null)?.click();
            }
          }}
          style={{
            position: "relative",
            padding: "0.375rem 0.75rem",
            backgroundColor: "#1e293b",
            color: "#38bdf8",
            border: "1px solid #38bdf8",
            borderRadius: "4px",
            fontSize: "0.75rem",
            fontWeight: 600,
            cursor: "pointer",
            display: "inline-block",
          }}
        >
          Upload .uvtt
          <input
            type="file"
            tabIndex={-1}
            aria-hidden="true"
            aria-label="Upload .uvtt Battlemap"
            accept=".uvtt,.dd2vtt,.json"
            onChange={handleUvttUpload}
            data-testid="upload-uvtt-input"
            style={{
              position: "absolute",
              width: "1px",
              height: "1px",
              padding: 0,
              margin: "-1px",
              overflow: "hidden",
              clip: "rect(0, 0, 0, 0)",
              border: 0,
            }}
          />
        </label>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
        <input
          type="text"
          placeholder="ActiveEffect (e.g. Blessed)"
          value={activeEffectDesc}
          onInput={(e) => setActiveEffectDesc((e.target as HTMLInputElement).value)}
          data-testid="active-effect-input"
          aria-label="ActiveEffect Description"
          style={{
            padding: "0.375rem 0.5rem",
            backgroundColor: "#1e293b",
            border: "1px solid #334155",
            borderRadius: "4px",
            color: "#f8fafc",
            fontSize: "0.75rem",
          }}
        />
        <button
          type="button"
          data-testid="apply-active-effect-btn"
          onClick={handleApplyActiveEffect}
          style={{
            padding: "0.375rem 0.625rem",
            backgroundColor: "#7c3aed",
            color: "#ffffff",
            border: "none",
            borderRadius: "4px",
            fontSize: "0.75rem",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Apply
        </button>
      </div>

      <div style={{ marginLeft: "auto" }}>
        <button
          type="button"
          data-testid="undo-action-btn"
          onClick={handleUndo}
          style={{
            padding: "0.375rem 0.75rem",
            backgroundColor: "#334155",
            color: "#f8fafc",
            border: "1px solid #475569",
            borderRadius: "4px",
            fontSize: "0.75rem",
            cursor: "pointer",
          }}
        >
          Undo Action
        </button>
      </div>

      {statusMessage && (
        <div
          role="status"
          aria-live="polite"
          data-testid="gm-toolbar-status"
          style={{ width: "100%", fontSize: "0.75rem", color: "#34d399", marginTop: "0.25rem" }}
        >
          {statusMessage}
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          aria-live="polite"
          data-testid="gm-toolbar-error"
          style={{ width: "100%", fontSize: "0.75rem", color: "#f87171", marginTop: "0.25rem" }}
        >
          {errorMessage}
        </div>
      )}
    </aside>
  );
}
