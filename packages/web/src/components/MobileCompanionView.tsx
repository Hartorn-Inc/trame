import { useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { appSignals } from "../state/appSignals.ts";
import { ActorSheetDrawer } from "./ActorSheetDrawer.tsx";
import { DiceTrayDrawer } from "./DiceTrayDrawer.tsx";
import { WikiNotesDrawer } from "./WikiNotesDrawer.tsx";

export interface MobileCompanionViewProps {
  children?: ComponentChildren;
}

type MobileTab = "sheet" | "dice" | "notes";

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
        backgroundColor: "#070b12",
        color: "#f8fafc",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header style={{ padding: "0.75rem 1rem", backgroundColor: "#0f172a", borderBottom: "1px solid #1e293b", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>TRAME Companion</strong>
        <span style={{ fontSize: "0.75rem", color: "#38bdf8" }}>{actor?.name || "Touch View"}</span>
      </header>

      <div style={{ flex: 1, overflowY: "auto", position: "relative" }}>
        {activeTab === "sheet" && (
          <div style={{ position: "relative", height: "100%" }}>
            <ActorSheetDrawer actor={actor} embedded={true} />
          </div>
        )}
        {activeTab === "dice" && (
          <div style={{ position: "relative", height: "100%" }}>
            <DiceTrayDrawer embedded={true} />
          </div>
        )}
        {activeTab === "notes" && (
          <div style={{ position: "relative", height: "100%" }}>
            <WikiNotesDrawer embedded={true} />
          </div>
        )}
      </div>

      <nav
        aria-label="Companion Tabs"
        style={{
          display: "flex",
          backgroundColor: "#0f172a",
          borderTop: "1px solid #1e293b",
        }}
      >
        {(['sheet', 'dice', 'notes'] as MobileTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            data-testid={`mobile-tab-${tab}`}
            onClick={() => setActiveTab(tab)}
            style={{
              flex: 1,
              padding: "0.75rem",
              backgroundColor: activeTab === tab ? "#1e293b" : "transparent",
              color: activeTab === tab ? "#38bdf8" : "#94a3b8",
              border: "none",
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
