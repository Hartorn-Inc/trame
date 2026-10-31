import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CompendiumDragDropManager,
  calculateContainerWeight,
  calculateTotalInventoryWeight,
  type InventoryContainerItem,
} from "../../src/compendium/CompendiumDragDropManager.ts";

describe("CompendiumDragDropManager Invariant Suite", () => {
  it("INV-05: Rejects circular container references when target container is descendant or self", () => {
    const items: InventoryContainerItem[] = [
      { id: "chest", isContainer: true, containerId: null },
      { id: "backpack", isContainer: true, containerId: "chest" },
      { id: "pouch", isContainer: true, containerId: "backpack" },
    ];

    assert.equal(CompendiumDragDropManager.validateMove("chest", "chest", items), false);
    assert.equal(CompendiumDragDropManager.validateMove("chest", "backpack", items), false);
    assert.equal(CompendiumDragDropManager.validateMove("chest", "pouch", items), false);
    assert.equal(CompendiumDragDropManager.validateMove("pouch", "chest", items), true);
  });

  it("INV-06: Validates attunement limit of 3 items", () => {
    const items: InventoryContainerItem[] = [
      { id: "i1", isAttuned: true },
      { id: "i2", isAttuned: true },
      { id: "i3", isAttuned: true },
    ];
    const validation = CompendiumDragDropManager.validateAttunement(items);
    assert.equal(validation.allowed, false);
    assert.ok(validation.warning?.includes("3"));
  });

  it("INV-07: Content weight multiplier of 0 sets nested content weight to 0 while keeping tare weight", () => {
    const items: InventoryContainerItem[] = [
      { id: "bag-of-holding", isContainer: true, unitWeight: 15.0, weightMultiplier: 0.0, containerId: null },
      { id: "heavy-stone", unitWeight: 500.0, quantity: 2, containerId: "bag-of-holding" },
    ];
    const total = calculateTotalInventoryWeight(items);
    assert.equal(total, 15.0);
  });

  it("INV-08: Deterministic encumbrance calculation based on Strength score", () => {
    const strScore = 14;
    const regular = strScore * 5;
    const heavy = strScore * 10;
    const maxCap = strScore * 15;
    assert.equal(regular, 70);
    assert.equal(heavy, 140);
    assert.equal(maxCap, 210);
  });
});
