import assert from "node:assert/strict";
import module from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditSourceContent,
  CANONICAL_SECTION_TITLES,
  contrastRatio,
  extractCanonicalHeadings,
  parseDesignMdFrontmatter,
  parseYamlSubset,
  runAudit,
  validateCanonicalHeadings,
  validateDesignJson,
} from "../../../scripts/check-impeccable-design.mjs";
import {
  type AtlasThemeMode,
  type CanonicalWallKind,
  DARK_CANVAS_PALETTE,
  getCanvasThemePalette,
  LIGHT_CANVAS_PALETTE,
  type TokenDispositionKind,
} from "../src/canvas/CanvasThemePalette.ts";
import {
  LightweightElement,
  MobileCompanionLayout,
} from "../src/mobile/companionMode.ts";
import { DeclarativeSheetRenderer } from "../src/sheet/DeclarativeSheetRenderer.ts";
import { WidgetRegistry } from "../src/sheet/WidgetRegistry.ts";
import type { SheetLayoutTree } from "../src/sheet/types.ts";

if (typeof module.register === "function") {
  try {
    module.register("./tsx-loader.mjs", import.meta.url);
  } catch {
    // Optional tsx-loader hook
  }
}

const {
  ATLAS_ICON_PATHS,
  ATLAS_ICON_STROKE_WIDTH,
  renderAtlasIconSvg,
} = await import("../src/components/icons/AtlasIcons.tsx");
const {
  TRAME_LOGO_VARIANTS,
  renderTrameLogoSvg,
} = await import("../src/components/icons/TrameLogo.tsx");
const { renderEmptyStateSvg } = await import(
  "../src/components/icons/AtlasEmptyStates.tsx"
);

describe("TRAME ATLAS v1.1 & Impeccable Design System Suite", () => {
  describe("1. WCAG 2.2 AA Dual-Theme Contrast Matrix (Parameterized)", () => {
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
      { id: "light_primary_text_on_bg", fg: "#1C3041", bg: "#F4F7F9", minRatio: 4.5 },
      { id: "light_primary_text_on_surface", fg: "#1C3041", bg: "#FFFFFF", minRatio: 4.5 },
      { id: "light_primary_text_on_raised", fg: "#1C3041", bg: "#E8EFF3", minRatio: 4.5 },
      { id: "light_muted_text_on_bg", fg: "#465D6D", bg: "#F4F7F9", minRatio: 4.5 },
      { id: "light_muted_text_on_surface", fg: "#465D6D", bg: "#FFFFFF", minRatio: 4.5 },
      { id: "light_muted_text_on_raised", fg: "#465D6D", bg: "#E8EFF3", minRatio: 4.5 },
      { id: "light_on_action_white_on_amber_deep", fg: "#FFFFFF", bg: "#995817", minRatio: 4.5 },
      { id: "light_danger_on_surface", fg: "#A3333B", bg: "#FFFFFF", minRatio: 4.5 },
      { id: "light_focus_ring_on_surface", fg: "#155D77", bg: "#FFFFFF", minRatio: 3.0 },
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
      const signatures = new Set<string>();
      for (const kind of wallKinds) {
        const w = DARK_CANVAS_PALETTE.wallKinds[kind];
        const nonColorSig = `${w.strokeWidthPx}|${JSON.stringify(w.dashPatternPx)}|${w.endpointMarker}`;
        assert.ok(
          !signatures.has(nonColorSig),
          `WallKind '${kind}' must have a unique non-color stroke/endpoint signature`,
        );
        signatures.add(nonColorSig);
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

    for (const iconName of Object.keys(ATLAS_ICON_PATHS)) {
      it(`[icon_${iconName}] renders with 1.75px stroke width and aria-hidden="true"`, () => {
        const svg = renderAtlasIconSvg(iconName, 20);
        assert.equal(ATLAS_ICON_STROKE_WIDTH, 1.75);
        assert.match(svg, /stroke-width="1.75"/);
        assert.match(svg, /aria-hidden="true"/);
        assert.match(svg, new RegExp(`data-icon="${iconName}"`));
      });
    }

    const emptyStateKinds = ["campaigns", "map-atlas", "journal", "actors"] as const;
    for (const kind of emptyStateKinds) {
      it(`[empty_state_${kind}] renders theme-adaptive cartographic SVG with zero baked-in <text> elements`, () => {
        const svg = renderEmptyStateSvg(kind);
        assert.match(svg, /viewBox="0 0 160 100"/);
        assert.match(svg, /var\(--atlas-action\)/);
        assert.doesNotMatch(svg, /<text[\s>]/i);
      });
    }
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
        id: "rejects_baked_text_in_empty_state_svg",
        file: "packages/web/src/components/icons/AtlasEmptyStates.tsx",
        code: `<svg><text x="10" y="20">No items</text></svg>`,
        expectedPattern: /<text> elements inside empty-state SVGs are forbidden/,
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
    const testFilename = fileURLToPath(import.meta.url);
    const repoRoot = path.resolve(path.dirname(testFilename), "../../..");
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
});
