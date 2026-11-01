/**
 * ============================================================================
 * MOBILE COMPANION VIEW (mobile/MobileCompanionView.tsx)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Phone-sized companion for a player at the physical table: the board is not
 * mounted (no WebGL below 768px), and five tabs expose the player's sheet,
 * the table dice tray, the inventory, the combat tracker with reaction
 * prompts, and the journal.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Same Seams As Desktop`:
 *    - Every tab reuses the desktop component (`ActorSheetPanel`, `DiceTray`,
 *      `CombatTrackerBar`, `ReactionBanner`, `DocumentsWorkspaceTab`), so
 *      sheet saves stay versioned REST PUTs and table actions stay commands.
 * 2. `Sheet Resolution`:
 *    - The sheet shown is the selected actor, else the first sheet owned by
 *      the caller, else the first sheet the server returned. Players only
 *      receive their own sheets, so this never reveals another player's.
 * ============================================================================
 */
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { apiClient, type ApiClient } from "../api/client.ts";
import { selectedActorIdSignal } from "../api/session.ts";
import { LocaleToggle, UnitsToggle } from "../components/ShellToggles.tsx";
import { mobileCompanionOverrideSignal, t, type MessageKey } from "../i18n/index.ts";
import { ActorSheetPanel, INVENTORY_SHEET_LAYOUT } from "../sheet/ActorSheetPanel.tsx";
import { CombatTrackerBar } from "../table/CombatTrackerBar.tsx";
import { DiceTray } from "../table/DiceTray.tsx";
import { ReactionBanner } from "../table/ReactionBanner.tsx";
import { DocumentsWorkspaceTab } from "../workspace/DocumentsWorkspaceTab.tsx";

const COMPACT_TOGGLE_STYLE = { padding: "0.25rem 0.5rem", fontSize: "0.8rem", minHeight: "44px", minWidth: "44px" };

export type MobileCompanionTab = "sheet" | "dice" | "inventory" | "tracker" | "journal";

export const activeCompanionTabSignal = signal<MobileCompanionTab>("sheet");

export const MOBILE_COMPANION_TABS: Array<{ id: MobileCompanionTab; key: MessageKey }> = [
  { id: "sheet", key: "nav.sheet" },
  { id: "dice", key: "nav.dice" },
  { id: "inventory", key: "nav.inventory" },
  { id: "tracker", key: "nav.tracker" },
  { id: "journal", key: "nav.journal" },
];

export interface MobileCompanionViewProps {
  /** Campaign shown; defaults to `client.state.activeCampaignId`. */
  campaignId?: string;
  /** REST + socket gateway; defaults to the app-wide client. */
  client?: ApiClient;
  isGm?: boolean;
}

/** Actor whose sheet the companion shows (see invariant 2), or `null`. */
export function companionActorId(client: ApiClient): string | null {
  const actors = client.state.actors.value;
  const selected = selectedActorIdSignal.value;
  if (selected && actors[selected]) return selected;
  const userId = client.state.user.value?.id;
  const ids = Object.keys(actors);
  return ids.find((id) => userId && actors[id].ownerUserId === userId) ?? ids[0] ?? null;
}

export function MobileCompanionView({ campaignId: campaignIdProp, client = apiClient, isGm = false }: MobileCompanionViewProps = {}) {
  const activeTab = activeCompanionTabSignal.value;
  const campaignId = campaignIdProp ?? client.state.activeCampaignId.value ?? "";
  const actorId = companionActorId(client);

  useEffect(() => {
    if (campaignId) client.listActors(campaignId).catch(() => undefined);
  }, [client, campaignId]);

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
        <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>{t("shell.companionMode")}</span>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <LocaleToggle style={COMPACT_TOGGLE_STYLE} />
          <UnitsToggle style={COMPACT_TOGGLE_STYLE} />
          {mobileCompanionOverrideSignal.value && (
            <button
              type="button"
              data-testid="companion-exit-button"
              aria-label={t("shell.exitCompanion")}
              class="ds-btn ds-btn-secondary"
              onClick={() => {
                mobileCompanionOverrideSignal.value = false;
              }}
              style={{ padding: "0.25rem 0.5rem", fontSize: "0.8rem", minHeight: "44px", minWidth: "44px" }}
            >
              {t("shell.exit")}
            </button>
          )}
        </div>
      </header>

      <main style={{ flex: 1, overflowY: "auto", padding: "1rem" }}>
        {activeTab === "sheet" && (
          <div data-testid="tab-sheet">
            <ActorSheetPanel campaignId={campaignId} client={client} actorId={actorId} context="live_table" />
          </div>
        )}
        {activeTab === "dice" && (
          <div data-testid="tab-dice">
            <DiceTray client={client} />
          </div>
        )}
        {activeTab === "inventory" && (
          <div data-testid="tab-inventory">
            <ActorSheetPanel
              campaignId={campaignId}
              client={client}
              actorId={actorId}
              context="live_table"
              layout={INVENTORY_SHEET_LAYOUT}
            />
          </div>
        )}
        {activeTab === "tracker" && (
          <div data-testid="tab-tracker" class="ds-stack">
            <ReactionBanner client={client} isGm={isGm} />
            <CombatTrackerBar client={client} isGm={isGm} />
          </div>
        )}
        {activeTab === "journal" && (
          <div data-testid="tab-journal">
            <DocumentsWorkspaceTab isGm={isGm} currentUserId={client.state.user.value?.id ?? ""} />
          </div>
        )}
      </main>

      <nav
        data-testid="mobile-bottom-nav"
        aria-label={t("shell.mobileNav")}
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
