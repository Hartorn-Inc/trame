import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeclarativeSheetView } from "../../src/sheet/DeclarativeSheetView.tsx";

describe("DeclarativeSheetView Component & CoreBuildLock", () => {
  it("evaluates isLocked = true when gm_core_locked is true", () => {
    const vnode = DeclarativeSheetView({
      actorState: { sheet: { abilities: { str: 16 } } },
      gm_core_locked: true,
      coreStatsLocked: false,
    });
    assert.ok(vnode);
    assert.equal(vnode.props['data-testid'], 'declarative-sheet-view');
  });
});
