/**
 * WASM half of the Rust/WASM parity check: every case in the shared fixture file is run through
 * the Node build of `trame-engine` and must equal the outcome recorded by the native Rust test
 * (`crates/trame-engine/tests/wasm_parity_test.rs`), bit for bit.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as engine from "../../../trame-engine-node/trame_engine.js";

type ExportName =
  | "computeVisibilityPolygon"
  | "previewAoeCells"
  | "previewMove"
  | "suggestCover"
  | "countSoundOccludingWalls"
  | "evaluateDerivedDag";

interface ParityCase {
  id: string;
  export: ExportName;
  request: unknown;
  expected: { ok: unknown } | { error: string };
}

const cases: ParityCase[] = JSON.parse(
  readFileSync(
    new URL("../../../../crates/trame-engine/tests/fixtures/wasm_parity.json", import.meta.url),
    "utf8",
  ),
);

function outcome(c: ParityCase): { ok: unknown } | { error: string } {
  try {
    return { ok: JSON.parse(engine[c.export](JSON.stringify(c.request))) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

describe("trame-engine WASM (Node target) matches native Rust parity fixtures", () => {
  it("loads a non-empty fixture set", () => {
    assert.ok(cases.length > 0);
  });

  for (const c of cases) {
    it(c.id, () => {
      assert.deepStrictEqual(outcome(c), c.expected);
    });
  }
});
