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
    "src/maps/MapsStudioTab.tsx",
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
    { id: "tablist lays out tabs on a structural bottom border and wraps cleanly", selector: ".ds-tablist", expects: ["display: flex", "flex-wrap: wrap", "border-bottom: 1px solid var(--atlas-border)"] },
    { id: "tabs keep the desktop hit target", selector: ".ds-tab", expects: ["min-height: var(--atlas-hit-desktop)"] },
    { id: "button reset draws a visible focus ring", selector: ".ds-btn-reset:focus-visible", expects: ["var(--atlas-focus)"] },
    { id: "file-input label buttons draw a visible focus-within ring (W2)", selector: "label.ds-btn:focus-within", expects: ["2px solid var(--atlas-focus)", "outline-offset: 2px"] },
    { id: "icon button keeps the desktop hit target both ways", selector: ".ds-icon-btn", expects: ["min-width: var(--atlas-hit-desktop)", "min-height: var(--atlas-hit-desktop)"] },
    { id: "inputs draw their border with the control token", selector: ".ds-input", expects: ["var(--atlas-border-control)"] },
    { id: "studio numeric inputs keep 4.75rem width so 4-digit coordinates never clip (W8)", selector: ".ds-studio-num-input", expects: ["width: 4.75rem", "padding: var(--atlas-space-2xs) var(--atlas-space-xs)"] },
    { id: "standalone sheet widget buttons keep 40px desktop min-width and min-height (W4)", selector: ".ds-btn-spend-hitdie", expects: ["min-height: var(--atlas-hit-desktop)", "min-width: var(--atlas-hit-desktop)"] },
    { id: "sheet layout containers allow flex shrinking without horizontal overflow (W5)", selector: ".ds-widget-container", expects: ["min-width: 0"] },
    { id: "attack action table widget scrolls horizontally inside narrow containers (W5)", selector: ".ds-attack-table-widget", expects: ["min-width: 0", "max-width: 100%", "overflow-x: auto"] },
    { id: "compendium nested panel renders as raised hairline inset without 4-sided card border (W6)", selector: ".ds-compendium-entry-card > .ds-panel", expects: ["background-color: var(--atlas-surface-raised)", "border: 0", "border-top: 1px solid var(--atlas-border)", "border-radius: 0"] },
    { id: "sheet header nested conflict panel renders as raised hairline inset without 4-sided card border (W6)", selector: ".ds-character-sheet-header > .ds-panel", expects: ["background-color: var(--atlas-surface-raised)", "border: 0", "border-top: 1px solid var(--atlas-border)", "border-radius: 0"] },
    { id: "HUD persistence alert floats at Level-3 above z-index 20 drawers (W6)", selector: '.ds-hud-drawers-container > [role="alert"]', expects: ["position: fixed", "z-index: 30", "box-shadow: var(--atlas-elevation-overlay)"] },
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

  const touchCases = [
    ".ds-btn",
    ".ds-input-search",
    ".ds-icon-btn",
    ".ds-tab",
    ".ds-tab-btn",
    ".ds-btn-add-entry",
    ".ds-btn-spend-hitdie",
    ".ds-btn-death-save",
    ".ds-btn-unpack-item",
    ".ds-btn-attune",
    ".ds-btn-del-item",
    ".ds-btn-remove-cond",
    ".ds-spell-level-header",
    ".ds-choice",
    ".ds-save-roll",
    ".ds-skill-roll",
    ".ds-resource-input-current",
    ".ds-resource-input-max",
    ".ds-resource-input-temp",
    ".ds-currency-input",
  ];

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

describe("W7 & W8: LevelUpModal tabular-nums & MapsStudioTab ATLAS control classes", () => {
  const levelUpSrc = fs.readFileSync(path.join(webRoot, "src/components/modals/LevelUpModal.tsx"), "utf8");
  const studioSrc = fs.readFileSync(path.join(webRoot, "src/maps/MapsStudioTab.tsx"), "utf8");

  const levelUpTabularCases = [
    { id: "W7: modal title carries atlas-tabular-nums", pattern: /class:\s*"ds-modal-title atlas-tabular-nums"/ },
    { id: "W7: modal subtitle carries atlas-tabular-nums", pattern: /class:\s*"ds-modal-subtitle atlas-tabular-nums"/ },
    { id: "W7: Step 2 hit die info hint carries atlas-tabular-nums", pattern: /class:\s*"ds-hint atlas-tabular-nums"[\s\S]{0,80}levelUp\.hp\.dieInfo/ },
    { id: "W7: Step 2 fixed HP formula span carries atlas-tabular-nums", pattern: /"span",\s*\{\s*class:\s*"atlas-tabular-nums"\s*\},\s*`floor\(\$\{hitDieSize\}/ },
    { id: "W7: Step 2 rolled HP hint carries atlas-tabular-nums", pattern: /"span",\s*\{\s*class:\s*"atlas-tabular-nums"\s*\},\s*t\("levelUp\.hp\.rolledHint"/ },
    { id: "W7: Step 2 certified die roll result carries atlas-tabular-nums", pattern: /class:\s*"ds-meta atlas-tabular-nums"[\s\S]{0,60}levelUp\.hp\.dieResult/ },
    { id: "W7: Step 2 projected max HP hint carries atlas-tabular-nums", pattern: /class:\s*"ds-inset ds-hint atlas-tabular-nums"[\s\S]{0,80}levelUp\.hp\.projected/ },
    { id: "W7: Step 4 spell count heading carries atlas-tabular-nums", pattern: /class:\s*"ds-subheading atlas-tabular-nums"/ },
    { id: "W7: Step 4 spell level badge carries atlas-tabular-nums", pattern: /class:\s*"ds-meta atlas-tabular-nums"[\s\S]{0,60}levelUp\.spells\.level/ },
  ];

  for (const tc of levelUpTabularCases) {
    it(tc.id, () => {
      assert.match(levelUpSrc, tc.pattern);
    });
  }

  const studioInputIds = [
    "wall-p1x",
    "wall-p1y",
    "wall-p2x",
    "wall-p2y",
    "wall-bottom-elevation",
    "wall-top-elevation",
    "light-x",
    "light-y",
    "light-radius",
    "audio-x",
    "audio-y",
  ];

  for (const inputId of studioInputIds) {
    it(`W8: #${inputId} uses ds-input ds-studio-num-input atlas-tabular-nums without cramped 45px width`, () => {
      assert.match(
        studioSrc,
        new RegExp(`id="${inputId}"\\s+class="ds-input ds-studio-num-input atlas-tabular-nums"`),
      );
    });
  }

  it("W8: MapsStudioTab removes all cramped 45px inline input widths and styles #studio-wall-type + authoring/door buttons with ds-*", () => {
    assert.doesNotMatch(studioSrc, /width:\s*['"]45px['"]/);
    assert.match(studioSrc, /id="studio-wall-type"\s+class="ds-input"/);
    for (const btnTestId of ["toggle-revealed-btn", "add-wall-btn", "add-light-btn", "add-audio-btn"]) {
      assert.match(
        studioSrc,
        new RegExp(`class="ds-btn ds-btn-secondary ds-btn-sm"[\\s\\S]{0,120}data-testid="${btnTestId}"`),
      );
    }
    assert.match(studioSrc, /class="ds-btn ds-btn-danger ds-btn-sm"[\s\S]{0,160}data-testid=\{`delete-wall-\$\{w\.id\}`\}/);
    assert.match(studioSrc, /class="ds-btn ds-btn-danger ds-btn-sm"[\s\S]{0,160}data-testid=\{`delete-door-\$\{door\.id\}`\}/);
    assert.match(studioSrc, /class="ds-btn ds-btn-secondary ds-btn-sm"[\s\S]{0,200}data-testid=\{`toggle-lock-\$\{door\.id\}`\}/);
    assert.match(studioSrc, /class="ds-btn ds-btn-secondary ds-btn-sm"[\s\S]{0,160}data-testid=\{`toggle-door-\$\{door\.id\}`\}/);
  });
});

