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
  ];
  for (const c of cases) {
    it(c.id, () => {
      const offenders = files.filter((f) => c.pattern.test(f.text)).map((f) => f.path);
      assert.deepEqual(offenders, []);
    });
  }
});
