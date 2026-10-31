import fs from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

if (!globalThis.__TRAME_TSX_LOADER_REGISTERED__) {
  globalThis.__TRAME_TSX_LOADER_REGISTERED__ = true;
  try {
    register(import.meta.url);
  } catch {
    // Already running inside loader worker thread
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@trame/game-system-dnd5e")) {
    const rest = specifier.slice("@trame/game-system-dnd5e".length) || "/src/index.ts";
    const resolvedPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../game-systems/dnd5e",
      rest.replace(/^\//, ""),
    );
    return {
      url: pathToFileURL(resolvedPath).href,
      format: "module",
      shortCircuit: true,
    };
  }
  const nextResult = await nextResolve(specifier, context);
  if (specifier.endsWith(".tsx") || (nextResult?.url && nextResult.url.endsWith(".tsx"))) {
    return {
      ...nextResult,
      format: "module",
      shortCircuit: true,
    };
  }
  return nextResult;
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".tsx")) {
    const filePath = fileURLToPath(url);
    const source = fs.readFileSync(filePath, "utf8");
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        jsxImportSource: "preact",
      },
      fileName: filePath,
    });
    return {
      format: "module",
      shortCircuit: true,
      source: transpiled.outputText,
    };
  }
  return nextLoad(url, context);
}
