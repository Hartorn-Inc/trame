import fs from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
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
