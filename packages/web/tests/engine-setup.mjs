// Preloaded by `npm test` (`--import`): instantiates the browser WASM build from disk so
// synchronous engine calls through `wasmBridge.ts` work under `node --test` without fetch.
// Requires `make wasm` to have produced `src/wasm/`.
import { readFileSync } from "node:fs";
import { initEngineSync } from "../src/engine/wasmBridge.ts";

initEngineSync(readFileSync(new URL("../src/wasm/trame_engine_bg.wasm", import.meta.url)));
