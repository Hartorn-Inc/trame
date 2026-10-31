import { useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { client, type ApiClient } from "../api/client.ts";
import { appSignals } from "../state/appSignals.ts";
import type { AmbientPreset, TableMode, TrameCommand } from "../types/index.ts";

export interface GmOverrideToolbarProps {
  children?: ComponentChildren;
  campaignId?: string;
  client?: ApiClient;
  isGm?: boolean;
  onRecenterViewport?: () => void;
  onUndo?: () => void;
  onTableModeChange?: (mode: TableMode) => void;
  onAmbientPresetChange?: (preset: AmbientPreset) => void;
  onApplyActiveEffect?: (effect: unknown) => void;
}

export function GmOverrideToolbar(props: GmOverrideToolbarProps): JSX.Element {
  const activeClient = props.client || client;
  const user = appSignals.authUserSignal.value;
  const activeCampaign = appSignals.activeCampaignSignal.value;
  const tableState = appSignals.tableStateSignal.value;
  const targetCampaignId = props.campaignId || activeCampaign?.id || "";

  const isAuthorizedGm = props.isGm ?? (user?.role === "GM" || activeCampaign?.role === "GM");

  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedEffect, setSelectedEffect] = useState<string>("Blessed");

  const currentMode: TableMode = tableState?.mode || "EXPLORATION";
  const currentPreset: AmbientPreset = tableState?.ambientLighting || "DAYLIGHT";

  const handleModeChange = (newMode: TableMode) => {
    const cmd: TrameCommand = {
      cmd: "SET_TABLE_MODE",
      mode: newMode,
      exploration_paused: false,
      initiative_order: tableState?.initiativeOrder || [],
    };
    activeClient.sendCommand(cmd);
    if (tableState) {
      appSignals.tableStateSignal.value = { ...tableState, mode: newMode };
    }
    props.onTableModeChange?.(newMode);
  };

  const handlePresetChange = (newPreset: AmbientPreset) => {
    const cmd: TrameCommand = {
      cmd: "SET_AMBIENT_LIGHTING",
      preset: newPreset,
    };
    activeClient.sendCommand(cmd);
    if (tableState) {
      appSignals.tableStateSignal.value = { ...tableState, ambientLighting: newPreset };
    }
    props.onAmbientPresetChange?.(newPreset);
  };

  const handleLoadStarterDungeon = async () => {
    if (!targetCampaignId) {
      setErrorMessage("No active campaign selected.");
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      await activeClient.loadStarterDungeon(targetCampaignId);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("recenter-viewport"));
      }
      props.onRecenterViewport?.();
      setStatusMessage("Starter dungeon loaded successfully.");
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to load starter dungeon");
    } finally {
      setLoading(false);
    }
  };

  const handleUvttUpload = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file || !targetCampaignId) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      await activeClient.importUvttMap(targetCampaignId, file);
      setStatusMessage("UVTT map uploaded successfully.");
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to upload UVTT map");
    } finally {
      setLoading(false);
      target.value = "";
    }
  };

  const handleApplyEffect = () => {
    const effect = {
      name: selectedEffect,
      durationRounds: 10,
      phase: "ADD",
    };
    props.onApplyActiveEffect?.(effect);
    setStatusMessage(`ActiveEffect '${selectedEffect}' applied.`);
  };

  const handleUndo = () => {
    const cmd: TrameCommand = {
      cmd: "UNDO_LAST_ACTION",
    };
    activeClient.sendCommand(cmd);
    props.onUndo?.();
    setStatusMessage("Last action undone.");
  };

  return (
    <div
      role={"toolbar" as unknown as undefined}
      aria-label="Game Master Override Toolbar"
      style={{
        backgroundColor: "#131a2a",
        borderBottom: "1px solid #1e293b",
        padding: "0.75rem 1rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem",
        flexWrap: "wrap",
        color: "#f8fafc",
        fontSize: "0.875rem",
      }}
    >
      {!isAuthorizedGm && (
        <div
          role="alert"
          data-testid="gm-guardrail-banner"
          style={{
            backgroundColor: "#450a0a",
            color: "#fca5a5",
            border: "1px solid #991b1b",
            borderRadius: "4px",
            padding: "0.375rem 0.75rem",
            width: "100%",
          }}
        >
          Game Master privileges required for table overrides.
        </div>
      )}

      {statusMessage && (
        <div
          role="status"
          aria-live="polite"
          data-testid="gm-status-banner"
          style={{
            backgroundColor: "#064e3b",
            color: "#6ee7b7",
            padding: "0.25rem 0.5rem",
            borderRadius: "4px",
          }}
        >
          {statusMessage}
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          aria-live="assertive"
          data-testid="gm-error-banner"
          style={{
            backgroundColor: "#450a0a",
            color: "#fca5a5",
            padding: "0.25rem 0.5rem",
            borderRadius: "4px",
          }}
        >
          {errorMessage}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span style={{ color: "#94a3b8" }}>Mode:</span>
        <button
          type="button"
          data-testid="mode-exploration-btn"
          aria-pressed={currentMode === "EXPLORATION"}
          aria-label="Exploration Mode"
          disabled={!isAuthorizedGm}
          onClick={() => handleModeChange("EXPLORATION")}
          style={{
            padding: "0.375rem 0.75rem",
            backgroundColor: currentMode === "EXPLORATION" ? "#0284c7" : "#1e293b",
            color: "#f8fafc",
            border: "1px solid #334155",
            borderRadius: "4px",
            cursor: isAuthorizedGm ? "pointer" : "not-allowed",
          }}
        >
          Exploration
        </button>
        <button
          type="button"
          data-testid="mode-turn-by-turn-btn"
          aria-pressed={currentMode === "TURN_BY_TURN"}
          aria-label="Turn-by-Turn Mode"
          disabled={!isAuthorizedGm}
          onClick={() => handleModeChange("TURN_BY_TURN")}
          style={{
            padding: "0.375rem 0.75rem",
            backgroundColor: currentMode === "TURN_BY_TURN" ? "#0284c7" : "#1e293b",
            color: "#f8fafc",
            border: "1px solid #334155",
            borderRadius: "4px",
            cursor: isAuthorizedGm ? "pointer" : "not-allowed",
          }}
        >
          Turn-by-Turn
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <label htmlFor="ambient-preset-select" style={{ color: "#94a3b8" }}>
          Ambient:
        </label>
        <select
          id="ambient-preset-select"
          data-testid="ambient-preset-select"
          aria-label="Ambient Lighting Preset"
          disabled={!isAuthorizedGm}
          value={currentPreset}
          onChange={(e) => handlePresetChange((e.target as HTMLSelectElement).value as AmbientPreset)}
          style={{
            padding: "0.375rem 0.5rem",
            backgroundColor: "#0f172a",
            color: "#f8fafc",
            border: "1px solid #334155",
            borderRadius: "4px",
            cursor: isAuthorizedGm ? "pointer" : "not-allowed",
          }}
        >
          <option value="DAYLIGHT">Daylight</option>
          <option value="DUSK">Dusk</option>
          <option value="NIGHT_MOONLIGHT">Night Moonlight</option>
          <option value="PITCH_DARKNESS">Pitch Darkness</option>
        </select>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <button
          type="button"
          data-testid="load-starter-dungeon-btn"
          aria-label="Load Starter Dungeon"
          disabled={!isAuthorizedGm || loading}
          onClick={handleLoadStarterDungeon}
          style={{
            padding: "0.375rem 0.75rem",
            backgroundColor: "#d97706",
            color: "#ffffff",
            border: "none",
            borderRadius: "4px",
            fontWeight: 600,
            cursor: isAuthorizedGm && !loading ? "pointer" : "not-allowed",
          }}
        >
          {loading ? "Loading..." : "Load Starter Dungeon"}
        </button>

        <label
          role={"button" as unknown as undefined}
          tabIndex={isAuthorizedGm ? 0 : -1}
          aria-label="Upload .uvtt Battlemap"
          data-testid="uvtt-upload-btn"
          onKeyDown={(e) => {
            if (isAuthorizedGm && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              (e.currentTarget.querySelector('input[type="file"]') as HTMLInputElement | null)?.click();
            }
          }}
          style={{
            padding: "0.375rem 0.75rem",
            backgroundColor: "#1e293b",
            color: "#38bdf8",
            border: "1px solid #38bdf8",
            borderRadius: "4px",
            cursor: isAuthorizedGm ? "pointer" : "not-allowed",
          }}
        >
          Upload .uvtt
          <input
            type="file"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="uvtt-file-input"
            accept=".uvtt,.dd2vtt"
            disabled={!isAuthorizedGm}
            onChange={handleUvttUpload}
            style={{ display: "none" }}
          />
        </label>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <select
          data-testid="active-effect-select"
          aria-label="ActiveEffect Selection"
          disabled={!isAuthorizedGm}
          value={selectedEffect}
          onChange={(e) => setSelectedEffect((e.target as HTMLSelectElement).value)}
          style={{
            padding: "0.375rem 0.5rem",
            backgroundColor: "#0f172a",
            color: "#f8fafc",
            border: "1px solid #334155",
            borderRadius: "4px",
          }}
        >
          <option value="Blessed">Blessed</option>
          <option value="Shield">Shield</option>
          <option value="Prone">Prone</option>
          <option value="Stunned">Stunned</option>
          <option value="Invisible">Invisible</option>
        </select>
        <button
          type="button"
          data-testid="apply-active-effect-btn"
          aria-label="Apply ActiveEffect"
          disabled={!isAuthorizedGm}
          onClick={handleApplyEffect}
          style={{
            padding: "0.375rem 0.75rem",
            backgroundColor: "#7c3aed",
            color: "#ffffff",
            border: "none",
            borderRadius: "4px",
            cursor: isAuthorizedGm ? "pointer" : "not-allowed",
          }}
        >
          Apply Effect
        </button>
      </div>

      <div>
        <button
          type="button"
          data-testid="undo-action-btn"
          aria-label="Undo Last Action"
          disabled={!isAuthorizedGm}
          onClick={handleUndo}
          style={{
            padding: "0.375rem 0.75rem",
            backgroundColor: "#475569",
            color: "#f8fafc",
            border: "none",
            borderRadius: "4px",
            cursor: isAuthorizedGm ? "pointer" : "not-allowed",
          }}
        >
          Undo Action
        </button>
      </div>
    </div>
  );
}
