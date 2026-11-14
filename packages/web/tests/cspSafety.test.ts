// Guards the production CSP (`script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
// img-src 'self'; font-src 'self'`, no 'unsafe-inline', no data:/blob:) at the source level.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "wasm" ? [] : sourceFiles(path);
    return /\.(ts|tsx|css)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }));

describe("CSP-safe source", () => {
  const cases = [
    { id: "no style attribute set through setAttribute (style-src without 'unsafe-inline')", pattern: /setAttribute\(\s*["'`]style["'`]/ },
    { id: "no HTML string injection (inline style/script would be blocked)", pattern: /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|dangerouslySetInnerHTML/ },
    { id: "no blob: or data: URLs built at runtime", pattern: /createObjectURL|readAsDataURL|toDataURL/ },
    { id: "no data: or blob: URL literals", pattern: /["'`](?:data|blob):|url\(\s*(?:data|blob):/ },
    { id: "no string-compiled code (script-src without 'unsafe-eval')", pattern: /new Function\s*\(|(?<![\w.])eval\s*\(/ },
    { id: "no PixiJS Assets loader (its texture workers start from blob: URLs)", pattern: /\bAssets\.\w+\s*\(/ },
    { id: "no PixiJS HTMLText (rasterised through a data: SVG)", pattern: /new HTMLText\b/ },
    { id: "no worker creation (worker-src falls back to script-src 'self')", pattern: /new (?:Shared)?Worker\s*\(/ },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const offenders = files.filter((f) => c.pattern.test(f.text)).map((f) => f.path);
      assert.deepEqual(offenders, []);
    });
  }
});

describe("PixiJS stays CSP-safe and lazy", () => {
  const PIXI_ADAPTER = join("table", "scene", "pixiTableRenderer.ts");
  const PIXI_LAYERS = join("table", "scene", "pixiSceneLayers.ts");
  const pixiImport = /from\s+["']pixi\.js["']|import\s+["']pixi\.js/;

  it("only the lazily loaded table adapter and its retained layers import pixi.js", () => {
    assert.deepEqual(files.filter((f) => pixiImport.test(f.text)).map((f) => f.path).sort(), [PIXI_LAYERS, PIXI_ADAPTER].sort());
  });

  it("the retained layers load only through the adapter, after its no-eval polyfills", () => {
    const layersImport = /\bfrom\s+["'][^"']*pixiSceneLayers\.ts["']/;
    assert.deepEqual(files.filter((f) => layersImport.test(f.text)).map((f) => f.path), [PIXI_ADAPTER]);
    const adapter = files.find((f) => f.path === PIXI_ADAPTER)!.text;
    assert.ok(adapter.indexOf('import "pixi.js/unsafe-eval";') < adapter.search(layersImport), "polyfill import comes first");
  });

  it("the adapter installs the no-eval polyfills before using PixiJS", () => {
    const adapter = files.find((f) => f.path === PIXI_ADAPTER)!.text;
    const polyfill = adapter.indexOf('import "pixi.js/unsafe-eval";');
    assert.ok(polyfill >= 0, "pixi.js/unsafe-eval is imported");
    assert.ok(polyfill < adapter.search(/from\s+["']pixi\.js["']/), "polyfill import comes first");
  });

  it("the adapter is reached only through a dynamic import()", () => {
    const valueImport = (line: string) => /\bfrom\s+["'][^"']*pixiTableRenderer\.ts["']/.test(line) && !/^\s*import type\b/.test(line);
    const offenders = files.filter((f) => f.text.split("\n").some(valueImport)).map((f) => f.path);
    assert.deepEqual(offenders, []);
  });
});
