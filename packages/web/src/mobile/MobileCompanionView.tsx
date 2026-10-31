import { signal } from "@preact/signals";
import {
  localeSignal,
  mobileCompanionOverrideSignal,
  t,
  unitSystemSignal,
} from "../i18n/index.ts";
import { DocumentsWorkspaceTab } from "../workspace/DocumentsWorkspaceTab.tsx";

export type MobileCompanionTab = "sheet" | "dice" | "inventory" | "tracker" | "journal";

export const activeCompanionTabSignal = signal<MobileCompanionTab>("sheet");

export const MOBILE_COMPANION_TABS: Array<{ id: MobileCompanionTab; key: string }> = [
  { id: "sheet", key: "nav.sheet" },
  { id: "dice", key: "nav.dice" },
  { id: "inventory", key: "nav.inventory" },
  { id: "tracker", key: "nav.tracker" },
  { id: "journal", key: "nav.journal" },
];

export function MobileCompanionView() {
  const activeTab = activeCompanionTabSignal.value;

  return (
    <div
      data-testid="mobile-companion-view"
      style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100%" }}
    >
      <header
        data-testid="mobile-companion-header"
        style={{
          padding: "0.5rem 1rem",
          borderBottom: "1px solid var(--atlas-border)",
          background: "var(--atlas-surface-raised)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>Companion Mode</span>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <button
            type="button"
            data-testid="header-locale-toggle"
            aria-label={`Toggle language: ${localeSignal.value === "fr" ? "FR" : "EN"}`}
            class="ds-btn ds-btn-secondary"
            onClick={() => {
              localeSignal.value = localeSignal.value === "en" ? "fr" : "en";
            }}
            style={{ padding: "0.25rem 0.5rem", fontSize: "0.8rem", minHeight: "44px", minWidth: "44px" }}
          >
            {localeSignal.value === "fr" ? "FR" : "EN"}
          </button>
          <button
            type="button"
            data-testid="header-units-toggle"
            aria-label={`Toggle grid units: ${unitSystemSignal.value === "imperial_ft" ? "5 ft" : "1.5 m"}`}
            class="ds-btn ds-btn-secondary"
            onClick={() => {
              unitSystemSignal.value =
                unitSystemSignal.value === "imperial_ft" ? "metric_m" : "imperial_ft";
            }}
            style={{ padding: "0.25rem 0.5rem", fontSize: "0.8rem", minHeight: "44px", minWidth: "44px" }}
          >
            {unitSystemSignal.value === "imperial_ft" ? "5 ft" : "1.5 m"}
          </button>
          {mobileCompanionOverrideSignal.value && (
            <button
              type="button"
              data-testid="companion-exit-button"
              aria-label="Exit companion mode"
              class="ds-btn ds-btn-secondary"
              onClick={() => {
                mobileCompanionOverrideSignal.value = false;
              }}
              style={{ padding: "0.25rem 0.5rem", fontSize: "0.8rem", minHeight: "44px", minWidth: "44px" }}
            >
              Exit
            </button>
          )}
        </div>
      </header>

      <main style={{ flex: 1, overflowY: "auto", padding: "1rem" }}>
        {activeTab === "sheet" && <div data-testid="tab-sheet">{t("nav.sheet")}</div>}
        {activeTab === "dice" && <div data-testid="tab-dice">{t("nav.dice")}</div>}
        {activeTab === "inventory" && <div data-testid="tab-inventory">{t("nav.inventory")}</div>}
        {activeTab === "tracker" && <div data-testid="tab-tracker">{t("nav.tracker")}</div>}
        {activeTab === "journal" && (
          <div data-testid="tab-journal">
            <DocumentsWorkspaceTab />
          </div>
        )}
      </main>

      <nav
        data-testid="mobile-bottom-nav"
        aria-label="Mobile companion navigation"
        style={{
          display: "flex",
          borderTop: "1px solid var(--atlas-border)",
          background: "var(--atlas-surface)",
        }}
      >
        {MOBILE_COMPANION_TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              type="button"
              key={tab.id}
              data-testid={`nav-${tab.id}`}
              aria-pressed={isActive}
              class={`ds-btn ${isActive ? "ds-btn-primary active" : "ds-btn-secondary"}`}
              onClick={() => {
                activeCompanionTabSignal.value = tab.id;
              }}
              style={{
                flex: 1,
                minHeight: "44px",
                padding: "0.75rem",
                background: isActive ? "var(--atlas-surface-raised)" : "transparent",
                color: isActive ? "var(--atlas-text)" : "var(--atlas-text-muted)",
                border: "none",
                borderTop: isActive ? "2px solid var(--atlas-action)" : "2px solid transparent",
              }}
            >
              {t(tab.key)}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
