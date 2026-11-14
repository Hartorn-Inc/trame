/**
 * ============================================================================
 * DOM-SAFE ASSERTIONS (tests/helpers/domAssert.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * `assert.equal(node, null)` stores the node as `actual` on the
 * `AssertionError`, and both the failure message and the `node:test` reporter
 * run `util.inspect` on it. A mock DOM node links to its parent, siblings and
 * listeners, so inspecting one walks the whole cyclic tree and can allocate
 * tens of gigabytes (it took WSL down). These helpers only ever hand booleans
 * and strings to `node:assert`.
 * ============================================================================
 */
import assert from "node:assert/strict";

/** Fails with `label` unless `node` is `null` or `undefined`. */
export function assertAbsent(node: unknown, label: string): void {
  assert.ok(node === null || node === undefined, `${label} (expected absent)`);
}

/** Fails with `label` when `node` is `null` or `undefined`. */
export function assertPresent(node: unknown, label: string): void {
  assert.ok(node !== null && node !== undefined, `${label} (expected present)`);
}

/** Fails with `label` unless `actual` and `expected` are the same object (e.g. the focused node). */
export function assertSameNode(actual: unknown, expected: unknown, label: string): void {
  assert.ok(actual === expected, label);
}
