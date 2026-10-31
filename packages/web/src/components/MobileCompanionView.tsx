import { useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { appSignals } from "../state/appSignals.ts";
import { ActorSheetDrawer } from "./ActorSheetDrawer.tsx";
import { DiceTrayDrawer } from "./DiceTrayDrawer.tsx";
import { WikiNotesDrawer } from "./WikiNotesDrawer.tsx";

export interface MobileCompanionViewProps {
  children?: ComponentChildren;
}

type MobileTab = "sheet" | "dice" | "inventory" | "journal";

export function MobileCompanionView(_props: MobileCompanionViewProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<MobileTab>("sheet");
  const actor = appSignals.actorsSignal.value[0] || null;

  return (
    <main
      role="main"
      aria-label="Mobile Companion Viewport"
      data-testid="mobile-companion-view"
      style={{
        minHeight: "100vh",
        backgroundColor: "var(--atlas-bg)",
        color: "var(--atlas-text)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          padding: "0.75rem 1rem",
          backgroundColor: "var(--atlas-bg)",
          borderBottom: "1px solid var(--atlas-surface)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <strong style={{ color: "var(--atlas-action)" }}>TRAME Companion</strong>
        <span style={{ fontSize: "0.75rem", color: "var(--atlas-text-muted)" }}>
          {actor?.name || "Touch View"}
        </span>
      </header>

      <div style={{ flex: 1, overflowY: "auto", position: "relative" }}>
        {activeTab === "sheet" && (
          <div data-testid="tab-sheet" style={{ position: "relative", height: "100%" }}>
            <ActorSheetDrawer actor={actor} embedded={true} />
          </div>
        )}
        {activeTab === "dice" && (
          <div data-testid="tab-dice" style={{ position: "relative", height: "100%" }}>
            <DiceTrayDrawer embedded={true} />
          </div>
        )}
        {activeTab === "inventory" && (
          <div data-testid="tab-inventory" style={{ position: "relative", height: "100%" }}>
            <ActorSheetDrawer actor={actor} embedded={true} />
          </div>
        )}
        {activeTab === "journal" && (
          <div data-testid="tab-journal" style={{ position: "relative", height: "100%" }}>
            <WikiNotesDrawer embedded={true} />
          </div>
        )}
      </div>

      <nav
        role="tablist"
        aria-label="Companion Tabs"
        style={{
          display: "flex",
          backgroundColor: "var(--atlas-bg)",
          borderTop: "1px solid var(--atlas-surface)",
        }}
      >
        {(['sheet', 'dice', 'inventory', 'journal'] as MobileTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            data-testid={`tab-button-${tab}`}
            onClick={() => setActiveTab(tab)}
            style={{
              flex: 1,
              minHeight: "44px",
              minWidth: "44px",
              padding: "0.75rem 0.5rem",
              backgroundColor: activeTab === tab ? "var(--atlas-surface)" : "transparent",
              color: activeTab === tab ? "var(--atlas-action)" : "var(--atlas-text-muted)",
              border: "none",
              borderTop: activeTab === tab ? "2px solid var(--atlas-action)" : "2px solid transparent",
              fontWeight: 600,
              fontSize: "0.875rem",
              cursor: "pointer",
            }}
          >
            {tab.toUpperCase()}
          </button>
        ))}
      </nav>
    </main>
  );
}
