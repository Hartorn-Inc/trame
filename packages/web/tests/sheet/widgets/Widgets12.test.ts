import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StatBlock6Widget,
  ResourceBarWidget,
  ArmorInitiativeSpeedWidget,
  SavingThrowListWidget,
  SkillCheckListWidget,
  HitDiceAndDeathSavesWidget,
  ConditionBadgeStripWidget,
  AttackActionTableWidget,
  SpellbookAccordionWidget,
  InventoryContainerTreeWidget,
  FeatureTraitListWidget,
  NotesMarkdownPaneWidget,
} from "../../../src/sheet/widgets/index.ts";

describe("12 Canonical Preact Widgets Existence & Render", () => {
  it("renders all 12 widgets without errors", () => {
    assert.ok(StatBlock6Widget({ id: "w1", boundValues: {} }));
    assert.ok(ResourceBarWidget({ id: "w2", boundValues: {} }));
    assert.ok(ArmorInitiativeSpeedWidget({ id: "w3", boundValues: {} }));
    assert.ok(SavingThrowListWidget({ id: "w4", boundValues: {} }));
    assert.ok(SkillCheckListWidget({ id: "w5", boundValues: {} }));
    assert.ok(HitDiceAndDeathSavesWidget({ id: "w6", boundValues: {} }));
    assert.ok(ConditionBadgeStripWidget({ id: "w7", boundValues: {} }));
    assert.ok(AttackActionTableWidget({ id: "w8", boundValues: {} }));
    assert.ok(SpellbookAccordionWidget({ id: "w9", boundValues: {} }));
    assert.ok(InventoryContainerTreeWidget({ id: "w10", boundValues: {} }));
    assert.ok(FeatureTraitListWidget({ id: "w11", boundValues: {} }));
    assert.ok(NotesMarkdownPaneWidget({ id: "w12", boundValues: {} }));
  });
});
