import { signal } from "@preact/signals";
import { mobileCompanionOverrideSignal, t } from "../i18n/index.ts";

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
      {mobileCompanionOverrideSignal.value && (
        <div
          style={{
            padding: "0.5rem 1rem",
            borderBottom: "1px solid var(--atlas-border)",
            background: "var(--atlas-surface-raised)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>Companion Mode</span>
          <button
            type="button"
            data-testid="companion-exit-button"
            aria-label="Exit companion mode"
            class="ds-btn ds-btn-secondary"
            onClick={() => {
              mobileCompanionOverrideSignal.value = false;
            }}
            style={{ padding: "0.25rem 0.5rem", fontSize: "0.8rem" }}
          >
            Exit
          </button>
        </div>
      )}

      <main style={{ flex: 1, overflowY: "auto", padding: "1rem" }}>
        {activeTab === "sheet" && <div data-testid="tab-sheet">{t("nav.sheet")}</div>}
        {activeTab === "dice" && <div data-testid="tab-dice">{t("nav.dice")}</div>}
        {activeTab === "inventory" && <div data-testid="tab-inventory">{t("nav.inventory")}</div>}
        {activeTab === "tracker" && <div data-testid="tab-tracker">{t("nav.tracker")}</div>}
        {activeTab === "journal" && <div data-testid="tab-journal">{t("nav.journal")}</div>}
      </main>

      <nav
        data-testid="mobile-companion-nav"
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
              data-testid={`tab-button-${tab.id}`}
              aria-pressed={isActive}
              class={`ds-btn ${isActive ? "ds-btn-primary active" : "ds-btn-secondary"}`}
              onClick={() => {
                activeCompanionTabSignal.value = tab.id;
              }}
              style={{
                flex: 1,
                minHeight: "44px",
                padding: "0.75rem",
                background: isActive ? "var(--atlas-action)" : "transparent",
                color: isActive ? "var(--atlas-on-action)" : "var(--atlas-text)",
                border: "none",
                borderTop: isActive ? "2px solid var(--atlas-focus)" : "2px solid transparent",
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
