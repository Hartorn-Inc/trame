import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditSourceContent,
  CANONICAL_SECTION_TITLES,
  CANONICAL_SECTIONS,
  contrastRatio,
  CONTRAST_MATRIX,
  extractCanonicalHeadings,
  hexToRgb,
  parseDesignMdFrontmatter,
  parseYamlSubset,
  relativeLuminance,
  runAudit,
  validateCanonicalHeadings,
  validateDesignJson,
  walkFiles,
} from "../../../scripts/check-impeccable-design.mjs";
import {
  type AtlasThemeMode,
  type CanonicalWallKind,
  DARK_CANVAS_PALETTE,
  getCanvasThemePalette,
  LIGHT_CANVAS_PALETTE,
  type ResolvedAtlasTheme,
  type TokenDispositionKind,
} from "../src/canvas/CanvasThemePalette.ts";
import {
  LightweightElement,
  MobileCompanionLayout,
} from "../src/mobile/companionMode.ts";
import { DeclarativeSheetRenderer } from "../src/sheet/DeclarativeSheetRenderer.ts";
import { WidgetRegistry } from "../src/sheet/WidgetRegistry.ts";
import type { SheetLayoutTree } from "../src/sheet/types.ts";
import {
  initThemeSignal,
  readPersistedThemeMode,
  resolvedThemeSignal,
  setThemeMode,
  systemPrefersDarkSignal,
  themeModeSignal,
} from "../src/signals/themeSignal.ts";

if (typeof module.register === "function") {
  try {
    module.register("./tsx-loader.mjs", import.meta.url);
  } catch {
    // Optional tsx-loader hook
  }
}

const {
  ATLAS_ICON_PATHS,
  ATLAS_ICON_NAMES,
  ATLAS_ICON_STROKE_WIDTH,
  renderAtlasIconSvg,
} = await import("../src/components/icons/AtlasIcons.tsx");
const {
  TRAME_LOGO_VARIANTS,
  renderTrameLogoSvg,
} = await import("../src/components/icons/TrameLogo.tsx");
const {
  EMPTY_STATE_KINDS,
  renderEmptyStateSvg,
  renderEmptyStateHtml,
  AtlasEmptyStateContainer,
} = await import("../src/components/icons/AtlasEmptyStates.tsx");

const testFilename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(testFilename), "../../..");
const scriptPath = path.join(repoRoot, "scripts/check-impeccable-design.mjs");

describe("TRAME ATLAS v1.1 & Impeccable Design System Suite", () => {
  describe("1. WCAG 2.2 AA Dual-Theme Contrast Matrix (Parameterized)", () => {
    it("ensures all text pairs in CONTRAST_MATRIX achieve >= 4.5:1 and all UI/focus/border pairs achieve >= 3.0:1", () => {
      assert.ok(CONTRAST_MATRIX.length >= 20, "CONTRAST_MATRIX must cover at least 20 canonical token pairs");
      for (const pair of CONTRAST_MATRIX) {
        const ratio = contrastRatio(pair.fg, pair.bg);
        assert.ok(
          ratio >= pair.min,
          `Token pair [${pair.id}] ${pair.fg} on ${pair.bg} has contrast ${ratio.toFixed(2)}:1, expected >= ${pair.min}:1`,
        );
      }
    });

    const contrastCases: Array<{
      id: string;
      fg: string;
      bg: string;
      minRatio: number;
    }> = [
      { id: "dark_primary_text_on_bg", fg: "#F1F4F3", bg: "#0F1A25", minRatio: 4.5 },
      { id: "dark_primary_text_on_surface", fg: "#F1F4F3", bg: "#182736", minRatio: 4.5 },
      { id: "dark_primary_text_on_raised", fg: "#F1F4F3", bg: "#203243", minRatio: 4.5 },
      { id: "dark_muted_text_on_bg", fg: "#B8C7D1", bg: "#0F1A25", minRatio: 4.5 },
      { id: "dark_muted_text_on_surface", fg: "#B8C7D1", bg: "#182736", minRatio: 4.5 },
      { id: "dark_muted_text_on_raised", fg: "#B8C7D1", bg: "#203243", minRatio: 4.5 },
      { id: "dark_on_action_ink_on_amber", fg: "#172535", bg: "#F3BB71", minRatio: 4.5 },
      { id: "dark_danger_on_surface", fg: "#D57973", bg: "#182736", minRatio: 4.5 },
      { id: "dark_focus_ring_on_surface", fg: "#80CBE2", bg: "#182736", minRatio: 3.0 },
      { id: "dark_border_control_on_surface", fg: "#678099", bg: "#182736", minRatio: 3.0 },
      { id: "light_primary_text_on_bg", fg: "#1C3041", bg: "#F4F7F9", minRatio: 4.5 },
      { id: "light_primary_text_on_surface", fg: "#1C3041", bg: "#FFFFFF", minRatio: 4.5 },
      { id: "light_primary_text_on_raised", fg: "#1C3041", bg: "#E8EFF3", minRatio: 4.5 },
      { id: "light_muted_text_on_bg", fg: "#465D6D", bg: "#F4F7F9", minRatio: 4.5 },
      { id: "light_muted_text_on_surface", fg: "#465D6D", bg: "#FFFFFF", minRatio: 4.5 },
      { id: "light_muted_text_on_raised", fg: "#465D6D", bg: "#E8EFF3", minRatio: 4.5 },
      { id: "light_on_action_white_on_amber_deep", fg: "#FFFFFF", bg: "#995817", minRatio: 4.5 },
      { id: "light_danger_on_surface", fg: "#A3333B", bg: "#FFFFFF", minRatio: 4.5 },
      { id: "light_focus_ring_on_surface", fg: "#155D77", bg: "#FFFFFF", minRatio: 3.0 },
      { id: "light_border_control_on_surface", fg: "#607788", bg: "#FFFFFF", minRatio: 3.0 },
    ];

    for (const tc of contrastCases) {
      it(`[${tc.id}] enforces contrast >= ${tc.minRatio}:1 (${tc.fg} on ${tc.bg})`, () => {
        const ratio = contrastRatio(tc.fg, tc.bg);
        assert.ok(
          ratio >= tc.minRatio,
          `Expected ${tc.id} contrast ${ratio.toFixed(2)}:1 >= ${tc.minRatio}:1`,
        );
      });
    }

    it("verifies relative luminance calculation primitives", () => {
      assert.equal(hexToRgb("#ffffff").join(","), "255,255,255");
      assert.equal(hexToRgb("#000000").join(","), "0,0,0");
      assert.equal(hexToRgb("#fff").join(","), "255,255,255");
      assert.equal(relativeLuminance([255, 255, 255]), 1.0);
      assert.equal(relativeLuminance([0, 0, 0]), 0.0);
      assert.equal(contrastRatio("#ffffff", "#000000"), 21);
      assert.equal(contrastRatio("#ffffff", "#ffffff"), 1);
    });
  });

  describe("2. Hybrid CanvasThemePalette & Non-Color Redundancy (Parameterized)", () => {
    const themeModes: Array<{
      id: string;
      mode: AtlasThemeMode;
      prefersLight: boolean;
      expectedResolved: "dark" | "light";
      expectedVoidHex: number;
    }> = [
      {
        id: "explicit_dark_mode",
        mode: "dark",
        prefersLight: false,
        expectedResolved: "dark",
        expectedVoidHex: 0x0f1a25,
      },
      {
        id: "explicit_light_mode",
        mode: "light",
        prefersLight: false,
        expectedResolved: "light",
        expectedVoidHex: 0xf4f7f9,
      },
      {
        id: "system_mode_prefers_dark",
        mode: "system",
        prefersLight: false,
        expectedResolved: "dark",
        expectedVoidHex: 0x0f1a25,
      },
      {
        id: "system_mode_prefers_light",
        mode: "system",
        prefersLight: true,
        expectedResolved: "light",
        expectedVoidHex: 0xf4f7f9,
      },
    ];

    for (const tc of themeModes) {
      it(`[${tc.id}] resolves CanvasThemePalette while preserving mapArtFilter="none" and opaque fogUnexploredHex`, () => {
        const palette = getCanvasThemePalette(tc.mode, tc.prefersLight);
        assert.equal(palette.theme, tc.expectedResolved);
        assert.equal(palette.mapArtFilter, "none");
        assert.equal(palette.canvasVoidHex, tc.expectedVoidHex);
        assert.equal(palette.fogUnexploredHex, 0x0f1a25);
      });
    }

    it("enforces unique non-color geometric discriminators across all 4 tokenDispositions", () => {
      const dispositions: TokenDispositionKind[] = ["ally", "hostile", "selected", "activeTurn"];
      for (const palette of [DARK_CANVAS_PALETTE, LIGHT_CANVAS_PALETTE]) {
        const signatures = new Set<string>();
        for (const kind of dispositions) {
          const style = palette.tokenDispositions[kind];
          const nonColorSig = `${style.ringStrokeStyle}|${style.badgeShape}|${style.badgeGlyph}|${JSON.stringify(style.dashPatternPx)}`;
          assert.ok(
            !signatures.has(nonColorSig),
            `Disposition '${kind}' in ${palette.theme} mode must have a unique non-color geometric signature`,
          );
          signatures.add(nonColorSig);
        }
        assert.equal(signatures.size, 4);
      }
    });

    it("enforces unique non-color stroke/marker discriminators across all 7 WallSegment kinds", () => {
      const wallKinds: CanonicalWallKind[] = [
        "Normal",
        "Window",
        "Terrain",
        "OneWay",
        "SecretDoor",
        "Door",
        "Illusion",
      ];
      for (const palette of [DARK_CANVAS_PALETTE, LIGHT_CANVAS_PALETTE]) {
        const signatures = new Set<string>();
        for (const kind of wallKinds) {
          const w = palette.wallKinds[kind];
          const nonColorSig = `${w.strokeWidthPx}|${JSON.stringify(w.dashPatternPx)}|${w.endpointMarker}`;
          assert.ok(
            !signatures.has(nonColorSig),
            `WallKind '${kind}' in ${palette.theme} mode must have a unique non-color stroke/endpoint signature`,
          );
          signatures.add(nonColorSig);
        }
        assert.equal(signatures.size, 7);
      }
    });

    it("verifies Ticket #105 acceptance criteria for tokenDispositions, wallKinds and mcpStagingGhost", () => {
      for (const palette of [DARK_CANVAS_PALETTE, LIGHT_CANVAS_PALETTE]) {
        assert.equal(palette.mapArtFilter, "none");
        assert.equal(palette.fogUnexploredHex, 0x0f1a25);

        assert.equal(palette.tokenDispositions.ally.ringStrokeStyle, "solid");
        assert.equal(palette.tokenDispositions.ally.badgeShape, "shield");

        assert.equal(palette.tokenDispositions.hostile.ringStrokeStyle, "dashed");
        assert.equal(palette.tokenDispositions.hostile.badgeShape, "diamond");
        assert.equal(palette.tokenDispositions.hostile.badgeGlyph, "!");

        assert.equal(palette.tokenDispositions.selected.ringStrokeStyle, "double");
        assert.equal(palette.tokenDispositions.selected.badgeShape, "corner-chevrons");

        assert.equal(palette.tokenDispositions.activeTurn.ringColorHex, 0xf59e0b);
        assert.equal(palette.tokenDispositions.activeTurn.badgeShape, "chevron-beacon");
        assert.equal(palette.tokenDispositions.activeTurn.badgeGlyph, "›");

        assert.equal(palette.mcpStagingGhost.fillAlpha, 0.55);
        assert.deepEqual(palette.mcpStagingGhost.dashPatternPx, [4, 4]);
        assert.equal(palette.mcpStagingGhost.badgeText, "STAGED");

        const wallTuples = new Set<string>();
        const kinds: CanonicalWallKind[] = [
          "Normal",
          "Window",
          "Terrain",
          "OneWay",
          "SecretDoor",
          "Door",
          "Illusion",
        ];
        for (const k of kinds) {
          const w = palette.wallKinds[k];
          const tuple = `${JSON.stringify(w.dashPatternPx)}|${w.endpointMarker}`;
          assert.ok(!wallTuples.has(tuple), `Duplicate wall tuple for ${k}`);
          wallTuples.add(tuple);
        }
        assert.equal(wallTuples.size, 7);
      }
    });
  });

  describe("3. In-House SVG Asset Suite (TrameLogo, AtlasIcons, AtlasEmptyStates)", () => {
    for (const variant of TRAME_LOGO_VARIANTS) {
      it(`[logo_${variant}] renders valid 24x24 viewBox SVG in monochrome and duotone modes`, () => {
        const duotoneSvg = renderTrameLogoSvg({ variant, mode: "duotone", size: 32 });
        const monoSvg = renderTrameLogoSvg({ variant, mode: "monochrome", size: 16 });
        assert.match(duotoneSvg, /viewBox="0 0 24 24"/);
        assert.match(duotoneSvg, /var\(--atlas-action/);
        assert.match(monoSvg, /stroke="currentColor"/);
      });
    }

    it("confirms ATLAS_ICON_PATHS contains exactly 34 canonical icons and each outputs stroke-width=1.75 with aria-hidden=true", () => {
      const iconNames = Object.keys(ATLAS_ICON_PATHS);
      assert.equal(iconNames.length, 34, `Expected exactly 34 canonical icons, found ${iconNames.length}`);
      assert.equal(ATLAS_ICON_STROKE_WIDTH, 1.75);

      for (const iconName of iconNames) {
        const svg = renderAtlasIconSvg(iconName, 20);
        assert.match(svg, /stroke-width="1.75"/, `Icon ${iconName} must have stroke-width 1.75`);
        assert.match(svg, /aria-hidden="true"/, `Icon ${iconName} must have aria-hidden='true'`);
        assert.match(svg, new RegExp(`data-icon="${iconName}"`));
      }
    });

    it("confirms EMPTY_STATE_KINDS contains exactly 4 empty states and each SVG contains zero text elements", () => {
      assert.equal(EMPTY_STATE_KINDS.length, 4, "Expected exactly 4 empty state variants");
      for (const kind of EMPTY_STATE_KINDS) {
        const svg = renderEmptyStateSvg(kind);
        assert.match(svg, /viewBox="0 0 160 100"/);
        assert.match(svg, /var\(--atlas-action\)/);
        assert.doesNotMatch(svg, /<text[\s>]/i, `Empty state '${kind}' must contain zero <text> elements`);
      }
    });

    it("confirms empty state containers expose role='status' with accessible localized text outside SVG", () => {
      const html = renderEmptyStateHtml({
        kind: "campaigns",
        heading: "No Campaigns",
        body: "Create your first campaign to begin.",
      });
      assert.match(html, /role="status"/);
      assert.match(html, /No Campaigns/);
      assert.match(html, /Create your first campaign/);
      assert.doesNotMatch(html, /<svg[^>]*>[\s\S]*?<text[\s>]/i);
    });
  });

  describe("4. DeclarativeSheetRenderer PadlockEditMode, Tabular-Nums & MobileCompanionLayout", () => {
    WidgetRegistry.registerDefaults();

    const sampleTree: SheetLayoutTree = {
      systemId: "dnd5e",
      version: "1.0.0",
      root: {
        id: "root-section",
        kind: "section",
        title: "Core Stats",
        children: [
          {
            id: "stats-6",
            kind: "widget",
            widgetType: "StatBlock6",
            bindings: { abilities: "abilities" },
          },
        ],
      },
    };

    const padLockCases = [
      {
        id: "default_locked_play_mode",
        viewer: { isOwner: true },
        expectedUnlocked: false,
        expectedAriaPressed: "false",
        expectedIcon: "PadlockLockedIcon",
      },
      {
        id: "explicit_unlocked_edit_mode",
        viewer: { isOwner: true, padlockUnlocked: true },
        expectedUnlocked: true,
        expectedAriaPressed: "true",
        expectedIcon: "PadlockUnlockedIcon",
      },
    ] as const;

    for (const tc of padLockCases) {
      it(`[${tc.id}] populates PadlockEditMode header metadata and attaches ds-panel + atlas-tabular-nums`, () => {
        const rendered = DeclarativeSheetRenderer.render(
          sampleTree,
          { abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 } },
          tc.viewer,
        );
        assert.ok(rendered.padlockEditMode);
        assert.equal(rendered.padlockEditMode.testId, "sheet-padlock-toggle");
        assert.equal(rendered.padlockEditMode.unlocked, tc.expectedUnlocked);
        assert.equal(rendered.padlockEditMode.ariaPressed, tc.expectedAriaPressed);
        assert.equal(rendered.padlockEditMode.iconName, tc.expectedIcon);
        assert.ok(rendered.root);
        assert.match(rendered.root.cssClass ?? "", /\bds-panel\b/);
        if (rendered.root.kind === "section") {
          const child = rendered.root.children[0];
          assert.match(child.cssClass ?? "", /\batlas-tabular-nums\b/);
        }
      });
    }

    it("applies ds-btn touch classes and aria-pressed state on MobileCompanionLayout (< 768px) tabs", () => {
      const container = new LightweightElement("div");
      const layout = new MobileCompanionLayout(container);
      layout.mount();
      const sheetBtn = container.querySelector('[data-testid="tab-button-sheet"]');
      const diceBtn = container.querySelector('[data-testid="tab-button-dice"]');
      assert.ok(sheetBtn);
      assert.ok(diceBtn);
      assert.match(sheetBtn.getAttribute("class") ?? "", /\bds-btn\b/);
      assert.equal(sheetBtn.getAttribute("aria-pressed"), "true");
      assert.equal(diceBtn.getAttribute("aria-pressed"), "false");
    });
  });

  describe("5. Impeccable 62-Rule & Craft Floor Static Verifier (Parameterized)", () => {
    it("passes full repository audit with zero violations", () => {
      const errors = runAudit();
      assert.deepEqual(errors, []);
    });

    const violationCases = [
      {
        id: "rejects_raw_hex_outside_token_owners",
        file: "packages/web/src/components/Sample.tsx",
        code: `export const Box = () => <div style={{ color: "#ff0055" }} />;`,
        expectedPattern: /raw color literal '#ff0055' is forbidden/,
      },
      {
        id: "rejects_raw_rgb_function_outside_token_owners",
        file: "packages/web/src/components/Sample.tsx",
        code: `export const Box = () => <div style={{ background: "rgb(255, 0, 0)" }} />;`,
        expectedPattern: /raw 'rgb\(' color function is forbidden/,
      },
      {
        id: "rejects_gradient_text_slop",
        file: "packages/web/src/styles/extra.css",
        code: `.hero-title { -webkit-background-clip: text; }`,
        expectedPattern: /gradient text/,
      },
      {
        id: "rejects_zero_offset_glow_shadow",
        file: "packages/web/src/styles/extra.css",
        code: `.glow-card { box-shadow: 0 0 24px var(--atlas-action); }`,
        expectedPattern: /zero-offset glow halo/,
      },
      {
        id: "rejects_external_google_fonts_cdn",
        file: "packages/web/index.html",
        code: `<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet" />`,
        expectedPattern: /external Google Fonts CDN/,
      },
      {
        id: "rejects_banned_ai_slop_font_inter",
        file: "packages/web/src/styles/extra.css",
        code: `body { font-family: 'Inter', sans-serif; }`,
        expectedPattern: /banned font family detected/,
      },
      {
        id: "rejects_theme_filter_applied_to_battlemap_canvas",
        file: "packages/web/src/styles/extra.css",
        code: `.trame-pixijs-canvas { filter: invert(0.9); }`,
        expectedPattern: /filters applied to backgroundMap or tactical canvas/,
      },
      {
        id: "rejects_baked_text_in_empty_state_svg",
        file: "packages/web/src/components/icons/AtlasEmptyStates.tsx",
        code: `<svg><text x="10" y="20">No items</text></svg>`,
        expectedPattern: /<text> elements inside empty-state SVGs are forbidden/,
      },
      {
        id: "rejects_uppercase_tracked_out_eyebrow_kicker",
        file: "packages/web/src/styles/extra.css",
        code: `.eyebrow { font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em; }`,
        expectedPattern: /uppercase tracked-out eyebrow kicker violates Impeccable Craft Floor/,
      },
    ];

    for (const tc of violationCases) {
      it(`[${tc.id}] detects synthetic Craft Floor violation`, () => {
        const errs = auditSourceContent(tc.file, tc.code);
        assert.ok(
          errs.some((e) => tc.expectedPattern.test(e)),
          `Expected error matching ${tc.expectedPattern}, got: ${JSON.stringify(errs)}`,
        );
      });
    }
  });

  describe("6. ATLAS Design Contracts, Impeccable Sidecar & Glossary Validation (Ticket #103)", () => {
    const glossaryPath = path.join(repoRoot, "GLOSSARY.md");
    const designMdPath = path.join(repoRoot, "DESIGN.md");
    const designJsonPath = path.join(repoRoot, ".impeccable/design.json");
    const configJsonPath = path.join(repoRoot, ".impeccable/config.json");
    const tableOperatePath = path.join(repoRoot, ".impeccable/surfaces/table-operate.md");
    const campaignReadPath = path.join(repoRoot, ".impeccable/surfaces/campaign-read.md");

    it("validates GLOSSARY.md contains unique entries and definitions for CampaignWorkspace, CanvasThemePalette, and PadlockEditMode", () => {
      const content = fs.readFileSync(glossaryPath, "utf8");
      const requiredTerms = ["CampaignWorkspace", "CanvasThemePalette", "PadlockEditMode"];
      for (const term of requiredTerms) {
        const heading = `### ${term}`;
        const headingIdx = content.indexOf(heading);
        assert.ok(headingIdx !== -1, `GLOSSARY.md must contain heading '${heading}'`);
        const firstIdx = content.indexOf(heading);
        const secondIdx = content.indexOf(heading, firstIdx + heading.length);
        assert.equal(secondIdx, -1, `GLOSSARY.md has duplicate definition for '${heading}'`);
        const slice = content.slice(headingIdx, headingIdx + 400);
        assert.match(slice, /- \*\*Definition\*\*:/, `'${heading}' must have a - **Definition**: bullet`);
        assert.match(slice, /- \*\*Allowed Context\*\*:/, `'${heading}' must specify - **Allowed Context**:`);
        assert.match(slice, /- \*\*_Avoid_\*\*:/, `'${heading}' must specify - **_Avoid_**:`);
      }
    });

    it("extracts and validates YAML frontmatter from DESIGN.md containing name, description, colors, typography, rounded, spacing, and components", () => {
      const content = fs.readFileSync(designMdPath, "utf8");
      const frontmatter = parseDesignMdFrontmatter(content);
      assert.equal(frontmatter.name, "TRAME");
      assert.equal(typeof frontmatter.description, "string");
      assert.ok(String(frontmatter.description).includes("ATLAS v1.1"));

      const colors = frontmatter.colors as Record<string, string>;
      assert.ok(colors && typeof colors === "object");
      const requiredColorKeys = ["navy", "slate", "raised", "parchment", "amber", "cyan-focus", "danger-dark"];
      for (const k of requiredColorKeys) {
        assert.ok(colors[k], `DESIGN.md colors frontmatter must define '${k}'`);
      }

      const typo = frontmatter.typography as Record<string, unknown>;
      assert.ok(typo.display && typo.headline && typo.body && typo.label);

      const rounded = frontmatter.rounded as Record<string, string>;
      assert.equal(rounded.sm, "4px");
      assert.equal(rounded.md, "6px");
      assert.equal(rounded.lg, "8px");

      const spacing = frontmatter.spacing as Record<string, string>;
      assert.equal(spacing.xs, "4px");
      assert.equal(spacing.sm, "8px");
      assert.equal(spacing.md, "16px");
      assert.equal(spacing.lg, "24px");
      assert.equal(spacing.xl, "32px");

      const components = frontmatter.components as string[];
      assert.deepEqual(components, ["button-primary", "button-secondary", "input-field", "panel-surface"]);
    });

    it("rejects DESIGN.md YAML frontmatter missing required keys or delimiters", () => {
      assert.throws(() => parseDesignMdFrontmatter("# No Frontmatter"), /Missing YAML frontmatter/);
      assert.throws(
        () => parseDesignMdFrontmatter("---\nname: \"TRAME\"\n---\n# Content"),
        /missing required fields/,
      );
    });

    it("extracts the 8 canonical section headings from DESIGN.md in exact Impeccable order", () => {
      const content = fs.readFileSync(designMdPath, "utf8");
      const headings = extractCanonicalHeadings(content);
      assert.deepEqual(headings, CANONICAL_SECTION_TITLES);
      assert.deepEqual(headings, [
        "Overview",
        "Colors",
        "Typography",
        "Layout",
        "Elevation & Depth",
        "Shapes",
        "Components",
        "Do's and Don'ts",
      ]);
      const errors = validateCanonicalHeadings(headings);
      assert.deepEqual(errors, []);
    });

    it("detects out-of-order or missing canonical section headings", () => {
      const swapped = [
        "Colors",
        "Overview",
        "Typography",
        "Layout",
        "Elevation & Depth",
        "Shapes",
        "Components",
        "Do's and Don'ts",
      ];
      const swapErrors = validateCanonicalHeadings(swapped);
      assert.ok(swapErrors.length > 0);
      assert.ok(swapErrors.some((e) => e.includes("Overview")));

      const incomplete = ["Overview", "Colors"];
      const incompleteErrors = validateCanonicalHeadings(incomplete);
      assert.ok(incompleteErrors.some((e) => e.includes("Expected 8")));
    });

    it("validates .impeccable/design.json Schema v2 structure with colorMeta, typographyMeta, shadows, motion, and breakpoints", () => {
      const parsed = JSON.parse(fs.readFileSync(designJsonPath, "utf8"));
      const errors = validateDesignJson(parsed);
      assert.deepEqual(errors, []);
      assert.equal(parsed.schemaVersion, "2.0");

      const meta = parsed.colorMeta || parsed.extensions?.colorMeta;
      assert.ok(meta);
      assert.equal(meta.slateRamp.length, 8);
      assert.equal(meta.parchmentRamp.length, 8);
      assert.equal(meta.amberRamp.length, 8);
      assert.equal(meta.cyanFocusRamp.length, 8);
      assert.equal(meta.dangerRamp.length, 8);

      const typo = parsed.typographyMeta || parsed.extensions?.typographyMeta;
      assert.ok(typo);
      assert.equal(typo.numericVariant, "tabular-nums");
      assert.equal(typo.selfHostedWoff2, true);

      const shadows = parsed.shadows || parsed.extensions?.shadows;
      assert.ok(shadows.overlay);

      const motion = parsed.motion || parsed.extensions?.motion;
      assert.equal(motion.reducedMotion, "0.01ms");

      const breakpoints = parsed.breakpoints || parsed.extensions?.breakpoints;
      assert.equal(breakpoints.tablet, "768px");
    });

    it("rejects invalid design.json schema structures", () => {
      assert.ok(validateDesignJson({ schemaVersion: "1.0" }).length > 0);
      assert.ok(validateDesignJson({ schemaVersion: "2.0", components: [] }).length > 0);
      assert.ok(
        validateDesignJson({
          schemaVersion: "2.0",
          components: [1, 2, 3, 4],
          colorMeta: { slateRamp: ["#000"] },
        }).length > 0,
      );
    });

    it("verifies .impeccable/config.json sidecar linkage and enabled detector", () => {
      const config = JSON.parse(fs.readFileSync(configJsonPath, "utf8"));
      assert.equal(config.designSystem.path, "DESIGN.md");
      assert.equal(config.designSystem.sidecar, ".impeccable/design.json");
      assert.equal(config.detector.designSystem.enabled, true);
      assert.equal(config.hook.perEditRules, "all");
    });

    it("verifies surface contracts for table-operate.md and campaign-read.md exist and specify required modes", () => {
      const tableOperate = fs.readFileSync(tableOperatePath, "utf8");
      assert.match(tableOperate, /# Surface Contract: Live Tabletop & Tactical HUD \(`Operate` Mode\)/);
      assert.match(tableOperate, />= 75%`?\s*Viewport/);
      assert.match(tableOperate, /PadlockEditMode/);

      const campaignRead = fs.readFileSync(campaignReadPath, "utf8");
      assert.match(campaignRead, /# Surface Contract: Campaign Lobby, Wiki Notes & Compendium \(`Read` Mode\)/);
      assert.match(campaignRead, /60ch–72ch/);
      assert.match(campaignRead, /Flat Structural Framing/);
    });
  });

  describe("7. Subprocess / CLI Execution & Violation Detection (AC 1 & AC 6)", () => {
    it("WHEN node scripts/check-impeccable-design.mjs executes against the repository, the script validates YAML frontmatter, 8 section headings of DESIGN.md, and exits with code 0", () => {
      const res = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      assert.equal(
        res.status,
        0,
        `check-impeccable-design.mjs failed with status ${res.status}. Output:\n${res.stdout}\n${res.stderr}`,
      );
      assert.match(res.stdout, /OK: DESIGN\.md, \.impeccable\/design\.json/);
    });

    it("WHEN a test introduces a raw hex color literal inside a Preact component file, check-impeccable-design.mjs detects the violation and exits with non-zero code 1", () => {
      const tempComponentPath = path.join(
        repoRoot,
        "packages/web/src/components/_tempHexViolationComponent.tsx",
      );

      try {
        fs.writeFileSync(
          tempComponentPath,
          'export const TempViolation = () => <div style={{ color: "#336699" }}>Violation</div>;\n',
          "utf8",
        );

        const res = spawnSync(process.execPath, [scriptPath], {
          cwd: repoRoot,
          encoding: "utf8",
        });

        assert.equal(
          res.status,
          1,
          `Expected check-impeccable-design.mjs to exit with code 1 when raw hex is present, got: ${res.status}`,
        );
        const combinedOutput = `${res.stdout}\n${res.stderr}`;
        assert.match(
          combinedOutput,
          /raw color literal '#336699' is forbidden/,
          `Expected violation error message, got:\n${combinedOutput}`,
        );
      } finally {
        if (fs.existsSync(tempComponentPath)) {
          fs.unlinkSync(tempComponentPath);
        }
      }
    });

    it("WHEN check-impeccable-design.mjs executes against an invalid root path, it returns non-zero exit code 1", () => {
      const nonExistentPath = path.join(repoRoot, "non-existent-subpath-999");
      const res = spawnSync(process.execPath, [scriptPath, nonExistentPath], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr + res.stdout, /Missing root DESIGN\.md/);
    });
  });

  describe("8. Reactive Theme Signal Architecture (themeSignal.ts) & Network Hermeticity (tokens.css)", () => {
    it("manages theme transitions across dark, light, and system without raw color literals", () => {
      setThemeMode("dark");
      assert.equal(themeModeSignal.value, "dark");
      assert.equal(resolvedThemeSignal.value, "dark");

      setThemeMode("light");
      assert.equal(themeModeSignal.value, "light");
      assert.equal(resolvedThemeSignal.value, "light");

      setThemeMode("system");
      assert.equal(themeModeSignal.value, "system");
      assert.equal(
        resolvedThemeSignal.value,
        systemPrefersDarkSignal.value ? "dark" : "light",
      );

      // Reset to default dark
      setThemeMode("dark");
      assert.equal(themeModeSignal.value, "dark");
    });

    it("verifies tokens.css defines all canonical --atlas-* custom properties and self-hosted fonts", () => {
      const tokensCssPath = path.join(repoRoot, "packages/web/src/styles/tokens.css");
      const content = fs.readFileSync(tokensCssPath, "utf8");

      const requiredTokens = [
        "--atlas-bg",
        "--atlas-surface",
        "--atlas-surface-raised",
        "--atlas-text",
        "--atlas-text-muted",
        "--atlas-border",
        "--atlas-border-control",
        "--atlas-action",
        "--atlas-on-action",
        "--atlas-focus",
        "--atlas-danger",
        "--atlas-grid",
        "--atlas-shadow",
      ];
      for (const tok of requiredTokens) {
        assert.ok(content.includes(tok), `tokens.css must declare '${tok}'`);
      }

      // Mandatory tabular nums
      assert.match(content, /\.atlas-tabular-nums\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);

      // Map-art independence rule in CSS
      assert.match(content, /\.trame-pixijs-canvas\s*\{[^}]*filter:\s*none/);

      // Zero external font CDNs in tokens.css
      assert.doesNotMatch(content, /fonts\.googleapis\.com/);
      assert.doesNotMatch(content, /fonts\.gstatic\.com/);

      // Self-hosted @font-face rules
      assert.match(content, /url\("\/fonts\/SpaceGrotesk-Medium\.woff2"\)/);
      assert.match(content, /url\("\/fonts\/IBMPlexSans-Regular\.woff2"\)/);
    });

    it("verifies index.html does not request external Google Fonts", () => {
      const indexHtmlPath = path.join(repoRoot, "packages/web/index.html");
      const content = fs.readFileSync(indexHtmlPath, "utf8");
      assert.doesNotMatch(content, /fonts\.googleapis\.com/);
      assert.doesNotMatch(content, /fonts\.gstatic\.com/);
    });

    it("scans packages/web/src/**/*.{ts,tsx,css} confirming zero raw hexadecimal or rgb literals outside tokens.css and CanvasThemePalette.ts (AC 3)", () => {
      const files = walkFiles(path.join(repoRoot, "packages/web/src"), [".ts", ".tsx", ".css"]);
      assert.ok(files.length > 10, "Should scan more than 10 source files");

      const violations: string[] = [];
      for (const f of files) {
        const rel = path.relative(repoRoot, f);
        const code = fs.readFileSync(f, "utf8");
        const errs = auditSourceContent(rel, code);
        violations.push(...errs);
      }

      assert.deepEqual(
        violations,
        [],
        `Found unexpected raw color or Craft Floor violations:\n${violations.join("\n")}`,
      );
    });
  });
});
