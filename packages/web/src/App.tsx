import { useEffect, useState } from "preact/hooks";
import { appSignals } from "./state/appSignals.ts";
import { AuthScreen } from "./components/AuthScreen.tsx";
import { CampaignLobby } from "./components/CampaignLobby.tsx";
import { TableCanvas } from "./components/TableCanvas.tsx";
import { GmOverrideToolbar } from "./components/GmOverrideToolbar.tsx";
import { CombatTrackerBar } from "./components/CombatTrackerBar.tsx";
import { ActorSheetDrawer } from "./components/ActorSheetDrawer.tsx";
import { ActorBuilderModal } from "./components/ActorBuilderModal.tsx";
import { CompendiumDrawer } from "./components/CompendiumDrawer.tsx";
import { DiceTrayDrawer } from "./components/DiceTrayDrawer.tsx";
import { WikiNotesDrawer } from "./components/WikiNotesDrawer.tsx";
import { HandoutPopupModal } from "./components/HandoutPopupModal.tsx";
import { MobileCompanionView } from "./components/MobileCompanionView.tsx";

export function App(): import("preact").JSX.Element {
  const user = appSignals.authUserSignal.value;
  const activeCampaign = appSignals.activeCampaignSignal.value;
  const activeDrawer = appSignals.activeDrawerSignal.value;
  const companionMode = appSignals.companionModeSignal.value;

  const [isBuilderOpen, setIsBuilderOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1024,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleResize = () => {
      const w = window.innerWidth;
      setViewportWidth(w);
      appSignals.companionModeSignal.value = w < 768;
    };
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  if (!user) {
    return <AuthScreen />;
  }

  if (!activeCampaign) {
    return <CampaignLobby />;
  }

  if (companionMode || viewportWidth < 768) {
    return <MobileCompanionView />;
  }

  return (
    <div
      data-testid="trame-app-root"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        backgroundColor: "var(--atlas-bg)",
        color: "var(--atlas-text)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          backgroundColor: "var(--atlas-bg)",
          borderBottom: "1px solid var(--atlas-surface)",
          padding: "0.5rem 1rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <strong style={{ color: "var(--atlas-action)" }}>TRAME VTT</strong>
          <span style={{ fontSize: "0.875rem", color: "var(--atlas-text-muted)" }}>{activeCampaign.name}</span>
          <button
            type="button"
            onClick={() => (appSignals.activeCampaignSignal.value = null)}
            data-testid="leave-campaign-btn"
            style={{
              padding: "0.25rem 0.5rem",
              backgroundColor: "var(--atlas-surface)",
              color: "var(--atlas-text-muted)",
              border: "1px solid var(--atlas-border)",
              borderRadius: "4px",
              fontSize: "0.75rem",
              cursor: "pointer",
            }}
          >
            Lobby
          </button>
        </div>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            onClick={() => (appSignals.activeDrawerSignal.value = activeDrawer === "sheet" ? null : "sheet")}
            data-testid="toggle-sheet-btn"
            style={{ padding: "0.375rem 0.625rem", backgroundColor: "var(--atlas-surface)", color: "var(--atlas-info)", border: "1px solid var(--atlas-info)", borderRadius: "4px", fontSize: "0.75rem", cursor: "pointer" }}
          >
            Character Sheet
          </button>
          <button
            type="button"
            onClick={() => setIsBuilderOpen(true)}
            data-testid="open-builder-btn"
            style={{ padding: "0.375rem 0.625rem", backgroundColor: "var(--atlas-surface)", color: "var(--atlas-action)", border: "1px solid var(--atlas-action)", borderRadius: "4px", fontSize: "0.75rem", cursor: "pointer" }}
          >
            New Character
          </button>
          <button
            type="button"
            onClick={() => (appSignals.activeDrawerSignal.value = activeDrawer === "compendium" ? null : "compendium")}
            data-testid="toggle-compendium-btn"
            style={{ padding: "0.375rem 0.625rem", backgroundColor: "var(--atlas-surface)", color: "var(--atlas-info)", border: "1px solid var(--atlas-info)", borderRadius: "4px", fontSize: "0.75rem", cursor: "pointer" }}
          >
            Compendium
          </button>
          <button
            type="button"
            onClick={() => (appSignals.activeDrawerSignal.value = activeDrawer === "dice" ? null : "dice")}
            data-testid="toggle-dice-btn"
            style={{ padding: "0.375rem 0.625rem", backgroundColor: "var(--atlas-surface)", color: "var(--atlas-success)", border: "1px solid var(--atlas-success)", borderRadius: "4px", fontSize: "0.75rem", cursor: "pointer" }}
          >
            Dice
          </button>
          <button
            type="button"
            onClick={() => (appSignals.activeDrawerSignal.value = activeDrawer === "wiki" ? null : "wiki")}
            data-testid="toggle-wiki-btn"
            style={{ padding: "0.375rem 0.625rem", backgroundColor: "var(--atlas-surface)", color: "var(--atlas-action)", border: "1px solid var(--atlas-action)", borderRadius: "4px", fontSize: "0.75rem", cursor: "pointer" }}
          >
            Wiki
          </button>
        </div>
      </header>

      <GmOverrideToolbar />
      <CombatTrackerBar />

      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <TableCanvas />
        {activeDrawer === "sheet" && (
          <ActorSheetDrawer
            onClose={() => (appSignals.activeDrawerSignal.value = null)}
            onOpenBuilder={() => setIsBuilderOpen(true)}
          />
        )}
        {activeDrawer === "compendium" && <CompendiumDrawer onClose={() => (appSignals.activeDrawerSignal.value = null)} />}
        {activeDrawer === "dice" && <DiceTrayDrawer onClose={() => (appSignals.activeDrawerSignal.value = null)} />}
        {activeDrawer === "wiki" && <WikiNotesDrawer onClose={() => (appSignals.activeDrawerSignal.value = null)} />}
        {isBuilderOpen && <ActorBuilderModal onClose={() => setIsBuilderOpen(false)} />}
        <HandoutPopupModal />
      </div>
    </div>
  );
}
