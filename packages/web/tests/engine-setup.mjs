// Preloaded by `npm test` (`--import`): instantiates the browser WASM build from disk so
// synchronous engine calls through `wasmBridge.ts` work under `node --test` without fetch,
// and installs its `evaluateDerivedDag` as the D&D 5e pack evaluator, as `main.tsx` does.
// Requires `make wasm` to have produced `src/wasm/`.
import { readFileSync } from "node:fs";
import { evaluateDerivedDag, initEngineSync } from "../src/engine/wasmBridge.ts";
import { setDerivedDagEvaluator } from "../../game-systems/dnd5e/src/formulaEvaluator.ts";

initEngineSync(readFileSync(new URL("../src/wasm/trame_engine_bg.wasm", import.meta.url)));
setDerivedDagEvaluator(evaluateDerivedDag);
