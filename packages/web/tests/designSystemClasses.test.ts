import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { contrastRatio } from "../../../scripts/check-impeccable-design.mjs";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(webRoot, "src/styles/tokens.css"), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[,}\\s])${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "m").exec(css);
  assert.ok(match, `${selector} must have a rule in tokens.css`);
  return match[1];
}

function themeBlock(header: string): string {
  const start = css.indexOf(header);
  assert.ok(start >= 0, `missing theme block ${header}`);
  return css.slice(start, css.indexOf("}", start));
}

function tokenValue(block: string, token: string): string {
  const match = new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{3,6})`).exec(block);
  assert.ok(match, `${token} must be a hex color in the theme block`);
  return match[1];
}

describe("ds-* classes used by components resolve to tokens.css rules", () => {
  const files = [
    "src/components/modals/LevelUpModal.tsx",
    "src/components/modals/RestModal.tsx",
    "src/components/character-sheet/CharacterSheetHeader.tsx",
    "src/compendium/CompendiumDrawer.tsx",
    "src/compendium/MonsterStatBlockView.tsx",
    "src/sheet/ActorSheetPanel.tsx",
    "src/sheet/DeclarativeSheetView.tsx",
    "src/sheet/widgets/ArmorInitiativeSpeedWidget.tsx",
    "src/sheet/widgets/AttackActionTableWidget.tsx",
    "src/sheet/widgets/ConditionBadgeStripWidget.tsx",
    "src/sheet/widgets/FeatureTraitListWidget.tsx",
    "src/sheet/widgets/HitDiceAndDeathSavesWidget.tsx",
    "src/sheet/widgets/InventoryContainerTreeWidget.tsx",
    "src/sheet/widgets/NotesMarkdownPaneWidget.tsx",
    "src/sheet/widgets/ResourceBarWidget.tsx",
    "src/sheet/widgets/SavingThrowListWidget.tsx",
    "src/sheet/widgets/SkillCheckListWidget.tsx",
    "src/sheet/widgets/SpellbookAccordionWidget.tsx",
    "src/sheet/widgets/StatBlock6Widget.tsx",
    "src/auth/AuthScreen.tsx",
    "src/lobby/CampaignLobby.tsx",
    "src/lobby/CampaignInviteDialog.tsx",
    "src/lobby/InstanceAdminPanel.tsx",
    "src/auth/OwnerSetupScreen.tsx",
    "src/auth/InviteRedemptionScreen.tsx",
    "src/auth/GuestBindPrompt.tsx",
    "src/auth/AccountSettingsDialog.tsx",
    "src/auth/accountForm.tsx",
    "src/components/ShellToggles.tsx",
    "src/workspace/DocumentsWorkspaceTab.tsx",
    "src/builder/CharacterBuilderModal.tsx",
    "src/hud/HudDrawers.tsx",
    "src/table/TableCanvas.tsx",
    "src/table/CombatTrackerBar.tsx",
    "src/table/GmOverrideToolbar.tsx",
    "src/table/TokenVitalsPanel.tsx",
    "src/table/TokenConditionsPanel.tsx",
    "src/table/TokenMenuDialog.tsx",
    "src/table/CoverSuggestionPanel.tsx",
    "src/table/ReactionBanner.tsx",
    "src/table/DiceTray.tsx",
    "src/table/TableTab.tsx",
    "src/components/RoomConnectionFeedback.tsx",
  ];

  for (const file of files) {
    it(`every ds-* class in ${file} has a CSS rule`, () => {
      const source = fs.readFileSync(path.join(webRoot, file), "utf8");
      const classes = [...new Set(source.match(/\bds-[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])];
      assert.ok(classes.length > 0, `${file} should use ds-* primitives`);
      const missing = classes.filter((cls) => !new RegExp(`\\.${cls}(?![\\w-])`).test(css));
      assert.deepEqual(missing, []);
    });
  }
});

describe("ds-* modal and hit-target primitives are wired to ATLAS tokens", () => {
  const cases = [
    { id: "backdrop fills the viewport with the scrim token", selector: ".ds-modal-backdrop", expects: ["position: fixed", "inset: 0", "var(--atlas-scrim)"] },
    { id: "modal panel uses the raised surface and overlay elevation", selector: ".ds-modal", expects: ["var(--atlas-surface", "var(--atlas-elevation-overlay)"] },
    { id: "button reset strips native button chrome", selector: ".ds-btn-reset", expects: ["appearance: none", "border: 0", "font: inherit"] },
    { id: "choice rows keep the desktop hit target", selector: ".ds-choice", expects: ["min-height: var(--atlas-hit-desktop)"] },
    { id: "tablist lays out tabs on a structural bottom border", selector: ".ds-tablist", expects: ["display: flex", "border-bottom: 1px solid var(--atlas-border)"] },
    { id: "tabs keep the desktop hit target", selector: ".ds-tab", expects: ["min-height: var(--atlas-hit-desktop)"] },
    { id: "button reset draws a visible focus ring", selector: ".ds-btn-reset:focus-visible", expects: ["var(--atlas-focus)"] },
    { id: "icon button keeps the desktop hit target both ways", selector: ".ds-icon-btn", expects: ["min-width: var(--atlas-hit-desktop)", "min-height: var(--atlas-hit-desktop)"] },
    { id: "inputs draw their border with the control token", selector: ".ds-input", expects: ["var(--atlas-border-control)"] },
    { id: "compendium drawer uses ATLAS surface and structural border tokens", selector: ".ds-compendium-drawer", expects: ["var(--atlas-surface)", "var(--atlas-border)"] },
    { id: "compendium search input uses raised surface and control border tokens", selector: ".ds-input-search", expects: ["var(--atlas-surface-raised)", "var(--atlas-border-control)", "min-height: var(--atlas-hit-desktop)"] },
    { id: "compendium category filter tab buttons use control border and desktop hit target", selector: ".ds-tab-btn", expects: ["var(--atlas-border-control)", "min-height: var(--atlas-hit-desktop)"] },
    { id: "compendium entry list strips browser list chrome", selector: ".ds-compendium-entry-list", expects: ["list-style: none", "display: flex"] },
    { id: "compendium entry card uses structural hairline divider", selector: ".ds-compendium-entry-card", expects: ["border-bottom: 1px solid var(--atlas-border)"] },
  ];

  for (const c of cases) {
    it(c.id, () => {
      const body = ruleBody(c.selector);
      for (const fragment of c.expects) {
        assert.ok(body.includes(fragment), `${c.selector} should contain ${fragment}`);
      }
    });
  }

  const touchCases = [".ds-btn", ".ds-input-search", ".ds-icon-btn", ".ds-tab", ".ds-tab-btn", ".ds-btn-add-entry", ".ds-choice", ".ds-save-roll", ".ds-skill-roll"];

  for (const selector of touchCases) {
    it(`${selector} grows to the touch hit target on narrow viewports`, () => {
      const start = css.indexOf("@media (max-width: 767px)");
      assert.ok(start >= 0, "missing narrow-viewport media query");
      const block = css.slice(start, css.indexOf("@media", start + 1));
      const rule = new RegExp(`${selector.replace(".", "\\.")}[\\s,][^{]*\\{[^}]*var\\(--atlas-hit-touch\\)`);
      assert.match(block, rule);
    });
  }
});

describe("control borders meet 3:1 non-text contrast while hairlines stay structural", () => {
  const themes = [
    { id: "dark theme control border on surface", header: '[data-theme="dark"] {', surface: "--atlas-surface" },
    { id: "dark theme control border on page background", header: '[data-theme="dark"] {', surface: "--atlas-bg" },
    { id: "light theme control border on surface", header: '[data-theme="light"] {', surface: "--atlas-surface" },
    { id: "light theme control border on page background", header: '[data-theme="light"] {', surface: "--atlas-bg" },
    { id: "system-light control border on surface", header: '[data-theme="system"] {', surface: "--atlas-surface" },
  ];

  for (const c of themes) {
    it(c.id, () => {
      const block = themeBlock(c.header);
      const ratio = contrastRatio(tokenValue(block, "--atlas-border-control"), tokenValue(block, c.surface));
      assert.ok(ratio >= 3, `contrast ${ratio.toFixed(2)} must be >= 3:1`);
    });
  }
});
