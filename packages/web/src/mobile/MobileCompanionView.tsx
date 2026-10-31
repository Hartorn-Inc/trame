import { signal } from "@preact/signals";
import { t } from "../i18n/index.ts";

export type MobileCompanionTab = "sheet" | "dice" | "inventory" | "tracker" | "journal";

export const activeCompanionTabSignal = signal<MobileCompanionTab>("sheet");

export function MobileCompanionView() {
  const activeTab = activeCompanionTabSignal.value;

  return (
    <div data-testid="mobile-companion-view" style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100%" }}>
      <main style={{ flex: 1, overflowY: "auto", padding: "1rem" }}>
        {activeTab === "sheet" && <div data-testid="tab-sheet">{t("nav.sheet")}</div>}
        {activeTab === "dice" && <div data-testid="tab-dice">{t("nav.dice")}</div>}
        {activeTab === "inventory" && <div data-testid="tab-inventory">{t("nav.inventory")}</div>}
        {activeTab === "tracker" && <div data-testid="tab-tracker">{t("nav.tracker")}</div>}
        {activeTab === "journal" && <div data-testid="tab-journal">{t("nav.journal")}</div>}
      </main>

      <nav data-testid="mobile-companion-nav" style={{ display: "flex", borderTop: "1px solid #334155", background: "#0f172a" }}>
        <button data-testid="tab-button-sheet" onClick={() => { activeCompanionTabSignal.value = "sheet"; }} style={{ flex: 1, padding: "0.75rem" }}>{t("nav.sheet")}</button>
        <button data-testid="tab-button-dice" onClick={() => { activeCompanionTabSignal.value = "dice"; }} style={{ flex: 1, padding: "0.75rem" }}>{t("nav.dice")}</button>
        <button data-testid="tab-button-inventory" onClick={() => { activeCompanionTabSignal.value = "inventory"; }} style={{ flex: 1, padding: "0.75rem" }}>{t("nav.inventory")}</button>
        <button data-testid="tab-button-tracker" onClick={() => { activeCompanionTabSignal.value = "tracker"; }} style={{ flex: 1, padding: "0.75rem" }}>{t("nav.tracker")}</button>
        <button data-testid="tab-button-journal" onClick={() => { activeCompanionTabSignal.value = "journal"; }} style={{ flex: 1, padding: "0.75rem" }}>{t("nav.journal")}</button>
      </nav>
    </div>
  );
}
