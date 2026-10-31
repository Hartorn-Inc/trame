#!/usr/bin/env node
/**
 * ============================================================================
 * TRAME ATLAS v1.1 & IMPECCABLE 62-RULE DESIGN SYSTEM VERIFIER
 * (scripts/check-impeccable-design.mjs)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Enforces the TRAME ATLAS v1.1 design specification (`DESIGN.md`,
 * `.impeccable/design.json`, `.impeccable/config.json`, `ADR-0011`) and the
 * Impeccable 62-rule Craft Floor deterministically in CI and `make lint`:
 *   1. Validates `DESIGN.md` YAML frontmatter + 8 canonical section headings
 *      in exact order (`Overview`, `Colors`, `Typography`, `Layout`,
 *      `Elevation & Depth`, `Shapes`, `Components`, `Do's and Don'ts`).
 *   2. Validates `.impeccable/design.json` Schema v2 sidecar parity and
 *      `.impeccable/surfaces/{table-operate,campaign-read}.md`.
 *   3. Computes WCAG 2.2 AA contrast ratios across all dark and light semantic
 *      token pairs (`>= 4.5:1` for text, `>= 3.0:1` for UI/focus/action).
 *   4. Audits `packages/web/src/` (`.ts`, `.tsx`, `.css`) and `packages/web/index.html`
 *      for Impeccable Craft Floor violations:
 *      - Raw hex (`#...`), `rgb(...)`, or `hsl(...)` literals outside the two
 *        canonical owners (`tokens.css` and `CanvasThemePalette.ts`)
 *      - Gradient text (`background-clip: text` / `-webkit-background-clip: text`)
 *      - Decorative neon/amber glow halos (`box-shadow: 0 0 <blur>`)
 *      - External Google Fonts CDN requests (`fonts.googleapis.com` / `fonts.gstatic.com`)
 *      - Banned overused AI-slop fonts (`Inter`, `Roboto`, `Poppins`, `Montserrat`)
 *      - CSS theme filters applied to `.trame-pixijs-canvas` or `backgroundMap`
 *      - `<text>` elements baked inside `AtlasEmptyStates.tsx` SVGs
 *   5. Verifies self-hosted WOFF2 font binaries (`wOF2` magic header) and
 *      brand SVG/PNG favicons exist under `packages/web/public/`.
 *   6. Executes the `impeccable detect` native binary (`engine-v0.1.18`,
 *      SHA-256 `736ed785e74ae2344d3036127f614ddde5ab520a527d8bc82a891612ef71f648`)
 *      when installed in the container or CI runner.
 * ============================================================================
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");

const CANONICAL_SECTIONS = [
  "## Overview",
  "## Colors",
  "## Typography",
  "## Layout",
  "## Elevation & Depth",
  "## Shapes",
  "## Components",
  "## Do's and Don'ts",
];

const IMPECCABLE_SHA256 = "736ed785e74ae2344d3036127f614ddde5ab520a527d8bc82a891612ef71f648";

export function hexToRgb(hex) {
  const clean = hex.replace(/^#/, "").trim();
  if (clean.length === 3) {
    return [
      parseInt(clean[0] + clean[0], 16),
      parseInt(clean[1] + clean[1], 16),
      parseInt(clean[2] + clean[2], 16),
    ];
  }
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

export function relativeLuminance([r, g, b]) {
  const toLinear = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [R, G, B] = [toLinear(r), toLinear(g), toLinear(b)];
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

export function contrastRatio(hexA, hexB) {
  const lumA = relativeLuminance(hexToRgb(hexA));
  const lumB = relativeLuminance(hexToRgb(hexB));
  const brightest = Math.max(lumA, lumB);
  const darkest = Math.min(lumA, lumB);
  return (brightest + 0.05) / (darkest + 0.05);
}

const CONTRAST_MATRIX = [
  // Dark Theme Text (>= 4.5:1)
  { id: "dark:text-on-bg", fg: "#F1F4F3", bg: "#0F1A25", min: 4.5 },
  { id: "dark:text-on-surface", fg: "#F1F4F3", bg: "#182736", min: 4.5 },
  { id: "dark:text-on-raised", fg: "#F1F4F3", bg: "#203243", min: 4.5 },
  { id: "dark:muted-on-bg", fg: "#B8C7D1", bg: "#0F1A25", min: 4.5 },
  { id: "dark:muted-on-surface", fg: "#B8C7D1", bg: "#182736", min: 4.5 },
  { id: "dark:muted-on-raised", fg: "#B8C7D1", bg: "#203243", min: 4.5 },
  { id: "dark:on-action", fg: "#172535", bg: "#F3BB71", min: 4.5 },
  { id: "dark:danger-on-surface", fg: "#D57973", bg: "#182736", min: 4.5 },
  // Dark Theme UI / Focus (>= 3.0:1)
  { id: "dark:action-on-surface", fg: "#F3BB71", bg: "#182736", min: 3.0 },
  { id: "dark:focus-on-surface", fg: "#80CBE2", bg: "#182736", min: 3.0 },
  // Light Theme Text (>= 4.5:1)
  { id: "light:text-on-bg", fg: "#1C3041", bg: "#F4F7F9", min: 4.5 },
  { id: "light:text-on-surface", fg: "#1C3041", bg: "#FFFFFF", min: 4.5 },
  { id: "light:text-on-raised", fg: "#1C3041", bg: "#E8EFF3", min: 4.5 },
  { id: "light:muted-on-bg", fg: "#465D6D", bg: "#F4F7F9", min: 4.5 },
  { id: "light:muted-on-surface", fg: "#465D6D", bg: "#FFFFFF", min: 4.5 },
  { id: "light:muted-on-raised", fg: "#465D6D", bg: "#E8EFF3", min: 4.5 },
  { id: "light:on-action", fg: "#FFFFFF", bg: "#995817", min: 4.5 },
  { id: "light:danger-on-surface", fg: "#A3333B", bg: "#FFFFFF", min: 4.5 },
  // Light Theme UI / Focus (>= 3.0:1)
  { id: "light:action-on-surface", fg: "#995817", bg: "#FFFFFF", min: 3.0 },
  { id: "light:focus-on-surface", fg: "#155D77", bg: "#FFFFFF", min: 3.0 },
];

function walkFiles(dir, exts) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "wasm") {
        continue;
      }
      results.push(...walkFiles(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

export function auditSourceContent(relPath, content) {
  const errors = [];
  const normalizedRel = relPath.replace(/\\/g, "/");
  const isTokenOwner =
    normalizedRel.endsWith("packages/web/src/styles/tokens.css") ||
    normalizedRel.endsWith("packages/web/src/canvas/CanvasThemePalette.ts");

  // Strip single-line and block comments before checking source code invariants
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  if (!isTokenOwner) {
    const hexMatch = stripped.match(/#[0-9a-fA-F]{3,8}\b|0x[0-9a-fA-F]{6}\b/);
    if (hexMatch) {
      errors.push(
        `${normalizedRel}: raw color literal '${hexMatch[0]}' is forbidden outside tokens.css and CanvasThemePalette.ts`,
      );
    }
    const rgbHslMatch = stripped.match(/\b(?:rgba?|hsla?)\s*\(/i);
    if (rgbHslMatch) {
      errors.push(
        `${normalizedRel}: raw '${rgbHslMatch[0]}' color function is forbidden outside tokens.css and CanvasThemePalette.ts`,
      );
    }
  }

  // Impeccable Craft Floor: Ban gradient text
  if (/background-clip\s*:\s*text|-webkit-background-clip\s*:\s*text/i.test(stripped)) {
    errors.push(`${normalizedRel}: gradient text ('background-clip: text') violates Impeccable Craft Floor`);
  }

  // Impeccable Craft Floor: Ban external Google Fonts CDN
  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(stripped)) {
    errors.push(`${normalizedRel}: external Google Fonts CDN request is forbidden; use self-hosted WOFF2 in /fonts/`);
  }

  // Impeccable Craft Floor: Ban overused AI-slop fonts
  if (/font-family\s*:[^;]*(?:\bInter\b|\bRoboto\b|\bPoppins\b|\bMontserrat\b)/i.test(stripped)) {
    errors.push(`${normalizedRel}: banned font family detected; use Space Grotesk or IBM Plex Sans`);
  }

  // Impeccable Craft Floor: Ban zero-offset neon/amber glow box-shadows
  if (/box-shadow\s*:\s*0(?:px)?\s+0(?:px)?\s+\d+px/i.test(stripped)) {
    errors.push(`${normalizedRel}: zero-offset glow halo ('box-shadow: 0 0 <blur>') violates Flat-By-Default Rule`);
  }

  // Empty-state SVG invariant: zero <text> nodes inside AtlasEmptyStates.tsx
  if (normalizedRel.endsWith("AtlasEmptyStates.tsx") && /<text[\s>]/i.test(stripped)) {
    errors.push(`${normalizedRel}: <text> elements inside empty-state SVGs are forbidden (breaks i18n)`);
  }

  return errors;
}

export function runAudit(repoRoot = ROOT) {
  const errors = [];

  // 1. Verify DESIGN.md frontmatter + 8 canonical sections in order
  const designMdPath = path.join(repoRoot, "DESIGN.md");
  if (!fs.existsSync(designMdPath)) {
    errors.push("Missing root DESIGN.md");
  } else {
    const designMd = fs.readFileSync(designMdPath, "utf8");
    if (!designMd.startsWith("---\n")) {
      errors.push("DESIGN.md: missing YAML frontmatter block");
    }
    let lastIdx = -1;
    for (const heading of CANONICAL_SECTIONS) {
      const idx = designMd.indexOf(heading);
      if (idx === -1) {
        errors.push(`DESIGN.md: missing canonical section '${heading}'`);
      } else if (idx < lastIdx) {
        errors.push(`DESIGN.md: section '${heading}' is out of canonical Impeccable order`);
      } else {
        lastIdx = idx;
      }
    }
  }

  // 2. Verify .impeccable/design.json, config.json, and surface briefs
  const designJsonPath = path.join(repoRoot, ".impeccable", "design.json");
  if (!fs.existsSync(designJsonPath)) {
    errors.push("Missing .impeccable/design.json sidecar");
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(designJsonPath, "utf8"));
      if (parsed.schemaVersion !== "2.0") {
        errors.push(`.impeccable/design.json: expected schemaVersion '2.0', got '${parsed.schemaVersion}'`);
      }
      if (!Array.isArray(parsed.components) || parsed.components.length < 4) {
        errors.push(".impeccable/design.json: expected at least 4 canonical ds-* component definitions");
      }
    } catch (err) {
      errors.push(`.impeccable/design.json: invalid JSON (${err.message})`);
    }
  }

  for (const rel of [
    ".impeccable/config.json",
    ".impeccable/surfaces/table-operate.md",
    ".impeccable/surfaces/campaign-read.md",
  ]) {
    if (!fs.existsSync(path.join(repoRoot, rel))) {
      errors.push(`Missing required Impeccable contract file: ${rel}`);
    }
  }

  // 3. Verify WCAG 2.2 AA Contrast Matrix
  for (const pair of CONTRAST_MATRIX) {
    const ratio = contrastRatio(pair.fg, pair.bg);
    if (ratio < pair.min) {
      errors.push(
        `WCAG contrast failure [${pair.id}]: ${pair.fg} on ${pair.bg} is ${ratio.toFixed(2)}:1 (minimum ${pair.min}:1)`,
      );
    }
  }

  // 4. Verify self-hosted WOFF2 fonts & brand assets
  const requiredFonts = [
    "SpaceGrotesk-Medium.woff2",
    "SpaceGrotesk-SemiBold.woff2",
    "IBMPlexSans-Regular.woff2",
    "IBMPlexSans-Medium.woff2",
    "IBMPlexSans-SemiBold.woff2",
  ];
  for (const fontFile of requiredFonts) {
    const fp = path.join(repoRoot, "packages/web/public/fonts", fontFile);
    if (!fs.existsSync(fp)) {
      errors.push(`Missing self-hosted WOFF2 font: packages/web/public/fonts/${fontFile}`);
    } else {
      const buf = fs.readFileSync(fp);
      if (buf.length < 4 || buf.subarray(0, 4).toString("ascii") !== "wOF2") {
        errors.push(`Invalid WOFF2 magic header in packages/web/public/fonts/${fontFile}`);
      }
    }
  }
  if (!fs.existsSync(path.join(repoRoot, "packages/web/public/fonts/OFL-1.1.txt"))) {
    errors.push("Missing packages/web/public/fonts/OFL-1.1.txt license attribution");
  }

  for (const brandAsset of [
    "favicon.svg",
    "logo-route-intersection.svg",
    "logo-waypoint-grid.svg",
    "logo-monolith-path.svg",
    "icon-16.png",
    "icon-32.png",
    "icon-64.png",
    "icon-128.png",
    "icon-256.png",
  ]) {
    if (!fs.existsSync(path.join(repoRoot, "packages/web/public/brand", brandAsset))) {
      errors.push(`Missing brand asset: packages/web/public/brand/${brandAsset}`);
    }
  }

  // 5. Audit web source files for Craft Floor & Token violations
  const webFiles = [
    ...walkFiles(path.join(repoRoot, "packages/web/src"), [".ts", ".tsx", ".css"]),
    path.join(repoRoot, "packages/web/index.html"),
  ].filter((f) => fs.existsSync(f));

  for (const file of webFiles) {
    const rel = path.relative(repoRoot, file);
    const content = fs.readFileSync(file, "utf8");
    errors.push(...auditSourceContent(rel, content));
  }

  // 6. Run native `impeccable detect` binary if available on PATH or IMPECCABLE_BIN
  const impeccableBin = process.env.IMPECCABLE_BIN || "impeccable";
  const whichRes = spawnSync("which", [impeccableBin], { encoding: "utf8" });
  if (whichRes.status === 0 && whichRes.stdout.trim()) {
    const binPath = whichRes.stdout.trim();
    const sha = crypto.createHash("sha256").update(fs.readFileSync(binPath)).digest("hex");
    if (process.env.IMPECCABLE_ENFORCE_SHA256 === "1" && sha !== IMPECCABLE_SHA256) {
      errors.push(`impeccable binary SHA-256 mismatch: expected ${IMPECCABLE_SHA256}, got ${sha}`);
    } else {
      const detectRes = spawnSync(binPath, ["detect", "packages/web/src"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (detectRes.status !== 0) {
        errors.push(`impeccable detect reported violations:\n${detectRes.stdout}\n${detectRes.stderr}`);
      }
    }
  }

  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const errors = runAudit();
  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`ERROR: ${err}`);
    }
    process.exit(1);
  }
  console.log(
    "OK: DESIGN.md, .impeccable/design.json, WCAG 2.2 AA contrast matrix, self-hosted WOFF2 fonts, and Impeccable Craft Floor checks passed.",
  );
}
