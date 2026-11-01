/**
 * ============================================================================
 * TRAME ATLAS v1.1 IMPECCABLE DESIGN AUDITOR (check-impeccable-design.mjs)
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRepoRoot = path.resolve(__dirname, "..");

export function hexToRgb(hex) {
  let clean = hex.replace(/^#/, "").trim();
  if (clean.length === 3) {
    clean = clean
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const num = parseInt(clean.slice(0, 6), 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

export function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(hexA, hexB) {
  const l1 = relativeLuminance(hexToRgb(hexA));
  const l2 = relativeLuminance(hexToRgb(hexB));
  const max = Math.max(l1, l2);
  const min = Math.min(l1, l2);
  return (max + 0.05) / (min + 0.05);
}

export const CANONICAL_SECTION_TITLES = [
  "Overview",
  "Colors",
  "Typography",
  "Layout",
  "Elevation & Depth",
  "Shapes",
  "Components",
  "Do's and Don'ts",
];

export const CANONICAL_SECTIONS = CANONICAL_SECTION_TITLES.map((t) => `## ${t}`);

export const CONTRAST_MATRIX = [
  { id: "dark_primary_text_on_bg", fg: "#F1F4F3", bg: "#0F1A25", min: 4.5 },
  { id: "dark_primary_text_on_surface", fg: "#F1F4F3", bg: "#182736", min: 4.5 },
  { id: "dark_primary_text_on_raised", fg: "#F1F4F3", bg: "#203243", min: 4.5 },
  { id: "dark_muted_text_on_bg", fg: "#B8C7D1", bg: "#0F1A25", min: 4.5 },
  { id: "dark_muted_text_on_surface", fg: "#B8C7D1", bg: "#182736", min: 4.5 },
  { id: "dark_muted_text_on_raised", fg: "#B8C7D1", bg: "#203243", min: 4.5 },
  { id: "dark_on_action_ink_on_amber", fg: "#172535", bg: "#F3BB71", min: 4.5 },
  { id: "dark_danger_on_surface", fg: "#E0827D", bg: "#182736", min: 4.5 },
  { id: "dark_danger_on_raised", fg: "#E0827D", bg: "#203243", min: 4.5 },
  { id: "dark_focus_ring_on_surface", fg: "#80CBE2", bg: "#182736", min: 3.0 },
  { id: "dark_border_control_on_surface", fg: "#678099", bg: "#182736", min: 3.0 },
  { id: "light_primary_text_on_bg", fg: "#1C3041", bg: "#F4F7F9", min: 4.5 },
  { id: "light_primary_text_on_surface", fg: "#1C3041", bg: "#FFFFFF", min: 4.5 },
  { id: "light_primary_text_on_raised", fg: "#1C3041", bg: "#E8EFF3", min: 4.5 },
  { id: "light_muted_text_on_bg", fg: "#465D6D", bg: "#F4F7F9", min: 4.5 },
  { id: "light_muted_text_on_surface", fg: "#465D6D", bg: "#FFFFFF", min: 4.5 },
  { id: "light_muted_text_on_raised", fg: "#465D6D", bg: "#E8EFF3", min: 4.5 },
  { id: "light_on_action_white_on_amber_deep", fg: "#FFFFFF", bg: "#995817", min: 4.5 },
  { id: "light_danger_on_surface", fg: "#A3333B", bg: "#FFFFFF", min: 4.5 },
  { id: "light_danger_on_raised", fg: "#A3333B", bg: "#E8EFF3", min: 4.5 },
  { id: "light_focus_ring_on_surface", fg: "#155D77", bg: "#FFFFFF", min: 3.0 },
  { id: "light_border_control_on_surface", fg: "#607788", bg: "#FFFFFF", min: 3.0 },
];

export function walkFiles(dir, exts = [".ts", ".tsx", ".css"]) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of list) {
    if (
      entry.name.startsWith(".") ||
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "target" ||
      entry.name === "wasm"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, exts));
    } else if (entry.isFile()) {
      if (exts.some((ext) => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }
  return results;
}

export function parseYamlSubset(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, obj: root, isList: false }];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const indent = rawLine.search(/\S/);

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const current = stack[stack.length - 1];

    if (trimmed.startsWith("- ")) {
      const itemVal = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
      if (Array.isArray(current.obj)) {
        current.obj.push(itemVal);
      }
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim().replace(/^["']|["']$/g, "");
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (rest === "") {
      let nextLine = "";
      for (let j = lineIndex + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t && !t.startsWith("#")) {
          nextLine = t;
          break;
        }
      }
      if (nextLine.startsWith("- ")) {
        const arr = [];
        current.obj[key] = arr;
        stack.push({ indent, obj: arr, isList: true });
      } else {
        const nestedObj = {};
        current.obj[key] = nestedObj;
        stack.push({ indent, obj: nestedObj, isList: false });
      }
    } else {
      const val = rest.replace(/^["']|["']$/g, "");
      current.obj[key] = val;
    }
  }

  return root;
}

export function parseDesignMdFrontmatter(content) {
  if (!content.startsWith("---")) {
    throw new Error("Missing YAML frontmatter: document does not start with '---'");
  }
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) {
    throw new Error("Missing YAML frontmatter: closing '---' delimiter not found");
  }
  const yamlText = content.slice(3, endIdx).trim();
  const parsed = parseYamlSubset(yamlText);
  const requiredFields = ["name", "description", "colors", "typography", "rounded", "spacing", "components"];
  const missing = requiredFields.filter((f) => !(f in parsed));
  if (missing.length > 0) {
    throw new Error(`YAML frontmatter missing required fields: ${missing.join(", ")}`);
  }
  return parsed;
}

export function extractCanonicalHeadings(content) {
  const headings = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^##\s+([^#\r\n]+)$/);
    if (match) {
      headings.push(match[1].trim());
    }
  }
  return headings;
}

export function validateCanonicalHeadings(headings) {
  const errors = [];
  if (headings.length !== CANONICAL_SECTION_TITLES.length) {
    errors.push(`Expected 8 canonical headings, found ${headings.length}`);
  }
  for (let i = 0; i < CANONICAL_SECTION_TITLES.length; i++) {
    const expected = CANONICAL_SECTION_TITLES[i];
    const actual = headings[i];
    if (actual !== expected) {
      errors.push(`Heading at position ${i + 1} mismatch: expected '${expected}', got '${actual ?? "missing"}'`);
    }
  }
  return errors;
}

export function validateDesignJson(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== "object") {
    return ["design.json must be an object"];
  }
  if (parsed.schemaVersion !== "2.0") {
    errors.push(`Expected schemaVersion '2.0', got '${parsed.schemaVersion}'`);
  }
  if (!Array.isArray(parsed.components) || parsed.components.length === 0) {
    errors.push("design.json components must be a non-empty array");
  } else {
    for (const comp of parsed.components) {
      if (!comp || typeof comp !== "object" || typeof comp.id !== "string") {
        errors.push("Each component in design.json must be an object with an 'id'");
      }
    }
  }
  const colorMeta = parsed.colorMeta || parsed.extensions?.colorMeta;
  if (!colorMeta) {
    errors.push("design.json missing colorMeta");
  } else {
    const requiredRamps = ["slateRamp", "parchmentRamp", "amberRamp", "cyanFocusRamp", "dangerRamp"];
    for (const ramp of requiredRamps) {
      if (!Array.isArray(colorMeta[ramp]) || colorMeta[ramp].length !== 8) {
        errors.push(`colorMeta.${ramp} must be an array of 8 color hex strings`);
      }
    }
  }
  const typo = parsed.typographyMeta || parsed.extensions?.typographyMeta;
  if (!typo) {
    errors.push("design.json missing typographyMeta");
  }
  const shadows = parsed.shadows || parsed.extensions?.shadows;
  if (!shadows) {
    errors.push("design.json missing shadows");
  }
  const motion = parsed.motion || parsed.extensions?.motion;
  if (!motion) {
    errors.push("design.json missing motion");
  }
  const breakpoints = parsed.breakpoints || parsed.extensions?.breakpoints;
  if (!breakpoints) {
    errors.push("design.json missing breakpoints");
  }
  return errors;
}

export function auditSourceContent(relPath, content) {
  const errors = [];
  const normalizedPath = relPath.replace(/\\/g, "/");
  const isTokenOwner =
    normalizedPath.endsWith("tokens.css") ||
    normalizedPath.endsWith("CanvasThemePalette.ts");

  if (!isTokenOwner) {
    const hexRegex = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
    let m;
    while ((m = hexRegex.exec(content)) !== null) {
      errors.push(
        `${normalizedPath}: raw color literal '${m[0]}' is forbidden outside tokens.css and CanvasThemePalette.ts`,
      );
    }

    if (/\brgb\s*\(|\brgba\s*\(|\bhsl\s*\(/i.test(content)) {
      errors.push(
        `${normalizedPath}: raw 'rgb(' color function is forbidden outside tokens.css and CanvasThemePalette.ts`,
      );
    }
  }

  if (
    /background-clip:\s*text/i.test(content) ||
    /-webkit-background-clip:\s*text/i.test(content)
  ) {
    errors.push(`${normalizedPath}: gradient text is forbidden`);
  }

  if (/box-shadow:[^;]*\b0\s+0\s+\d+px/i.test(content)) {
    errors.push(`${normalizedPath}: zero-offset glow halo is forbidden`);
  }

  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(content)) {
    errors.push(`${normalizedPath}: external Google Fonts CDN is forbidden`);
  }

  if (
    /\bfont-family:[^;]*['"]?Inter['"]?/i.test(content) ||
    /['"]Inter['"]/i.test(content)
  ) {
    errors.push(`${normalizedPath}: banned font family detected (Inter)`);
  }

  const filterMatch = content.match(
    /(\.trame-pixijs-canvas|backgroundMap)[^{]*\{[^}]*filter:\s*([^;]+);/i,
  );
  if (filterMatch) {
    const val = filterMatch[2].trim().toLowerCase();
    if (val !== "none") {
      errors.push(
        `${normalizedPath}: filters applied to backgroundMap or tactical canvas are forbidden`,
      );
    }
  }

  if (
    normalizedPath.includes("EmptyState") ||
    normalizedPath.includes("empty-state")
  ) {
    if (/<text[\s>]/i.test(content)) {
      errors.push(
        `${normalizedPath}: <text> elements inside empty-state SVGs are forbidden`,
      );
    }
  }

  if (
    /text-transform:\s*uppercase/i.test(content) &&
    /letter-spacing:\s*0\.\d+em/i.test(content)
  ) {
    errors.push(
      `${normalizedPath}: uppercase tracked-out eyebrow kicker violates Impeccable Craft Floor`,
    );
  }

  return errors;
}

export function runAudit(root = defaultRepoRoot) {
  const errors = [];
  const designMdPath = path.join(root, "DESIGN.md");
  if (!fs.existsSync(designMdPath)) {
    errors.push(`Missing root DESIGN.md at ${designMdPath}`);
    return errors;
  }
  const designMdContent = fs.readFileSync(designMdPath, "utf8");
  try {
    parseDesignMdFrontmatter(designMdContent);
  } catch (err) {
    errors.push(err.message);
  }
  const headings = extractCanonicalHeadings(designMdContent);
  errors.push(...validateCanonicalHeadings(headings));

  const designJsonPath = path.join(root, ".impeccable/design.json");
  if (fs.existsSync(designJsonPath)) {
    try {
      const designJson = JSON.parse(fs.readFileSync(designJsonPath, "utf8"));
      errors.push(...validateDesignJson(designJson));
    } catch (err) {
      errors.push(`Failed to parse .impeccable/design.json: ${err.message}`);
    }
  }

  for (const pair of CONTRAST_MATRIX) {
    const ratio = contrastRatio(pair.fg, pair.bg);
    if (ratio < pair.min) {
      errors.push(
        `Contrast ratio for ${pair.id} (${pair.fg} on ${pair.bg}) is ${ratio.toFixed(2)}:1, expected >= ${pair.min}:1`,
      );
    }
  }

  const srcDir = path.join(root, "packages/web/src");
  if (fs.existsSync(srcDir)) {
    const files = walkFiles(srcDir, [".ts", ".tsx", ".css"]);
    for (const file of files) {
      const rel = path.relative(root, file);
      const content = fs.readFileSync(file, "utf8");
      errors.push(...auditSourceContent(rel, content));
    }
  }

  return errors;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const designMdPath = path.join(targetDir, "DESIGN.md");
  if (!fs.existsSync(designMdPath)) {
    console.error(`ERROR: Missing root DESIGN.md at ${designMdPath}`);
    process.exit(1);
  }
  const errors = runAudit(targetDir);
  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`ERROR: ${err}`);
    }
    process.exit(1);
  }
  console.log(
    "OK: DESIGN.md, .impeccable/design.json, and source files passed Impeccable Design System audit.",
  );
  process.exit(0);
}
