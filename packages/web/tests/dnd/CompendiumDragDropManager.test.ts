import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CompendiumDragDropManager,
  ContainerWeightCalculator,
  calculateContainerWeight,
  calculateTotalInventoryWeight,
  type InventoryContainerItem,
} from "../../src/dnd/index.ts";

describe("CompendiumDragDropManager and ContainerWeightCalculator Suite", () => {
  describe("Acyclic Container Weight Calculations", () => {
    it("WHEN calculateContainerWeight evaluates a container with direct child items, calculateContainerWeight returns the sum of child weights rounded to two decimal places.", () => {
      const containerId = "backpack-1";
      const items: InventoryContainerItem[] = [
        {
          id: containerId,
          name: "Backpack",
          isContainer: true,
          containerId: null,
        },
        {
          id: "item-torch",
          name: "Torch",
          unitWeight: 1.255,
          quantity: 2,
          containerId,
        },
        {
          id: "item-rations",
          name: "Rations",
          unitWeight: 2.341,
          quantity: 3,
          containerId,
        },
      ];

      // (1.255 * 2) = 2.51, (2.341 * 3) = 7.023 -> sum = 9.533 -> rounded = 9.53
      const weight = calculateContainerWeight(containerId, items);
      assert.equal(weight, 9.53);

      const weightFromClass = ContainerWeightCalculator.calculateContainerWeight(
        containerId,
        items,
      );
      assert.equal(weightFromClass, 9.53);
    });

    it("WHEN calculateContainerWeight evaluates a container holding an inner container with weightMultiplier 0.0, calculateContainerWeight adds zero weight from the inner container contents to the outer container.", () => {
      const outerContainerId = "backpack-main";
      const innerContainerId = "bag-of-holding";

      const items: InventoryContainerItem[] = [
        {
          id: outerContainerId,
          name: "Adventurer Backpack",
          isContainer: true,
          unitWeight: 5.0,
          containerId: null,
        },
        {
          id: "item-bedroll",
          name: "Bedroll",
          unitWeight: 7.0,
          quantity: 1,
          containerId: outerContainerId,
        },
        {
          id: innerContainerId,
          name: "Bag of Holding",
          isContainer: true,
          unitWeight: 15.0,
          quantity: 1,
          weightMultiplier: 0.0,
          containerId: outerContainerId,
        },
        {
          id: "item-heavy-anvil",
          name: "Blacksmith Anvil",
          unitWeight: 500.0,
          quantity: 2,
          containerId: innerContainerId,
        },
      ];

      // Bedroll (7.0) + Bag of Holding self tare weight (15.0) + (1000.0 anvil * 0.0) = 22.00
      const outerWeight = calculateContainerWeight(outerContainerId, items);
      assert.equal(outerWeight, 22.0);

      // Directly evaluating the Bag of Holding evaluates its direct children (1000.0)
      const bagDirectWeight = calculateContainerWeight(innerContainerId, items);
      assert.equal(bagDirectWeight, 1000.0);
    });

    it("evaluates scaled weightMultiplier for fractional reduction containers", () => {
      const haversackId = "handy-haversack";
      const items: InventoryContainerItem[] = [
        {
          id: "chest-main",
          isContainer: true,
          containerId: null,
        },
        {
          id: haversackId,
          isContainer: true,
          unitWeight: 5.0,
          quantity: 1,
          weightMultiplier: 0.5,
          containerId: "chest-main",
        },
        {
          id: "iron-ingot",
          unitWeight: 10.0,
          quantity: 4,
          containerId: haversackId,
        },
      ];

      // Haversack self (5.0) + (40.0 * 0.5) = 25.00
      const chestWeight = calculateContainerWeight("chest-main", items);
      assert.equal(chestWeight, 25.0);
    });

    it("terminates safely when cyclical container references exist in data", () => {
      const items: InventoryContainerItem[] = [
        {
          id: "container-a",
          isContainer: true,
          unitWeight: 1.0,
          containerId: "container-b",
        },
        {
          id: "container-b",
          isContainer: true,
          unitWeight: 1.0,
          containerId: "container-a",
        },
      ];

      const weight = calculateContainerWeight("container-a", items);
      assert.ok(typeof weight === "number");
      assert.ok(weight >= 0);
    });

    it("calculates container weight with nested tree hierarchy structures", () => {
      const container: InventoryContainerItem = {
        id: "root-pouch",
        isContainer: true,
        children: [
          { id: "coin-1", unitWeight: 0.02, quantity: 50 },
          {
            id: "magic-pouch",
            isContainer: true,
            unitWeight: 1.0,
            weightMultiplier: 0.0,
            children: [{ id: "boulder", unitWeight: 100.0, quantity: 1 }],
          },
        ],
      };

      // (0.02 * 50 = 1.0) + (1.0 tare + 100.0 * 0.0) = 2.0
      const weight = calculateContainerWeight(container);
      assert.equal(weight, 2.0);
    });

    it("calculates total inventory weight across uncontained items and nested containers", () => {
      const items: InventoryContainerItem[] = [
        {
          id: "sword",
          unitWeight: 3.0,
          quantity: 1,
          containerId: null,
        },
        {
          id: "sack",
          unitWeight: 0.5,
          quantity: 1,
          isContainer: true,
          containerId: null,
        },
        {
          id: "apple",
          unitWeight: 0.2,
          quantity: 5,
          containerId: "sack",
        },
      ];

      // sword (3.0) + sack self (0.5) + sack contents (1.0) = 4.5
      const totalWeight = calculateTotalInventoryWeight(items);
      assert.equal(totalWeight, 4.5);
    });
  });

  describe("Container Move Validation & Cycle Rejection", () => {
    const items: InventoryContainerItem[] = [
      { id: "backpack", isContainer: true, containerId: null },
      { id: "pouch", isContainer: true, containerId: "backpack" },
      { id: "vial", isContainer: true, containerId: "pouch" },
      { id: "chest", isContainer: true, containerId: null },
      { id: "dagger", isContainer: false, containerId: "backpack" },
    ];

    it("WHEN CompendiumDragDropManager.validateMove receives targetContainerId identical to sourceItemId, CompendiumDragDropManager returns false.", () => {
      const result = CompendiumDragDropManager.validateMove(
        "backpack",
        "backpack",
        items,
      );
      assert.equal(result, false);
    });

    it("WHEN CompendiumDragDropManager.validateMove receives targetContainerId that is a descendant of sourceItemId, CompendiumDragDropManager returns false.", () => {
      // Direct child
      const isChildMoveValid = CompendiumDragDropManager.validateMove(
        "backpack",
        "pouch",
        items,
      );
      assert.equal(isChildMoveValid, false);

      // Deep descendant
      const isGrandchildMoveValid = CompendiumDragDropManager.validateMove(
        "backpack",
        "vial",
        items,
      );
      assert.equal(isGrandchildMoveValid, false);
    });

    it("allows moving items to root inventory or non-descendant containers", () => {
      // Moving to root
      assert.equal(
        CompendiumDragDropManager.validateMove("pouch", null, items),
        true,
      );

      // Moving to sibling / unrelated container
      assert.equal(
        CompendiumDragDropManager.validateMove("pouch", "chest", items),
        true,
      );

      // Moving inner item into its own parent
      assert.equal(
        CompendiumDragDropManager.validateMove("vial", "backpack", items),
        true,
      );
    });

    it("validates moves using manager instance configuration", () => {
      const manager = new CompendiumDragDropManager({
        systemId: "dnd5e",
        items,
      });

      assert.equal(manager.validateMove("backpack", "backpack"), false);
      assert.equal(manager.validateMove("backpack", "vial"), false);
      assert.equal(manager.validateMove("vial", "chest"), true);
    });
  });

  describe("Compendium Drop Payload & System Validation", () => {
    it("WHEN a compendium payload with a mismatched systemId drops onto the actor sheet, CompendiumDragDropManager rejects the drop and dispatches zero commands.", () => {
      const dispatched: unknown[] = [];
      const manager = new CompendiumDragDropManager({
        systemId: "dnd5e",
        dispatchCommand: (cmd) => dispatched.push(cmd),
        actorId: "actor-pc-1",
      });

      const mismatchedPayload = {
        systemId: "pf2e",
        entryRef: "pf2e.spells.heal",
        entryType: "spell",
      };

      const success = manager.handleDrop(mismatchedPayload);
      assert.equal(success, false);
      assert.equal(dispatched.length, 0);
    });

    it("rejects compendium payloads missing systemId or entryRef and dispatches zero commands", () => {
      const dispatched: unknown[] = [];
      const manager = new CompendiumDragDropManager({
        systemId: "dnd5e",
        dispatchCommand: (cmd) => dispatched.push(cmd),
      });

      assert.equal(manager.handleDrop(null), false);
      assert.equal(manager.handleDrop({ systemId: "dnd5e" }), false);
      assert.equal(
        manager.handleDrop({ systemId: "dnd5e", entryRef: "   " }),
        false,
      );
      assert.equal(dispatched.length, 0);
    });

    it("rejects unknown or disallowed compendium entry types", () => {
      const dispatched: unknown[] = [];
      const manager = new CompendiumDragDropManager({
        systemId: "dnd5e",
        dispatchCommand: (cmd) => dispatched.push(cmd),
      });

      const invalidPayload = {
        systemId: "dnd5e",
        entryRef: "dnd5e.invalid.thing",
        entryType: "disallowed_system_entity",
      };

      assert.equal(manager.handleDrop(invalidPayload), false);
      assert.equal(dispatched.length, 0);
    });

    it("WHEN a valid compendium payload drops onto the actor sheet, CompendiumDragDropManager dispatches a TrameCommand.DropCompendiumEntry command containing actorId, entryRef, and targetContainerId.", () => {
      const dispatched: any[] = [];
      const manager = new CompendiumDragDropManager({
        systemId: "dnd5e",
        actorId: "actor-wizard-123",
        dispatchCommand: (cmd) => dispatched.push(cmd),
      });

      const validPayload = {
        systemId: "dnd5e",
        entryRef: "dnd5e.spells.fireball",
        entryType: "spell",
      };

      const result = manager.handleDrop(validPayload, "bag-of-spells");
      assert.equal(result, true);
      assert.equal(dispatched.length, 1);

      const cmd = dispatched[0];
      assert.equal(cmd.cmd, "DROP_COMPENDIUM_ENTRY");
      assert.equal(cmd.actorId, "actor-wizard-123");
      assert.equal(cmd.entryRef, "dnd5e.spells.fireball");
      assert.equal(cmd.targetContainerId, "bag-of-spells");
    });

    it("dispatches TrameCommand.DropCompendiumEntry with targetContainerId null when dropping onto actor root", () => {
      const dispatched: any[] = [];
      const manager = new CompendiumDragDropManager("dnd5e", (cmd) =>
        dispatched.push(cmd),
      );

      const itemPayload = {
        systemId: "dnd5e",
        entryRef: "dnd5e.items.longsword",
        entryType: "item",
        actorId: "actor-fighter-99",
      };

      assert.equal(manager.handleDrop(itemPayload), true);
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].actorId, "actor-fighter-99");
      assert.equal(dispatched[0].entryRef, "dnd5e.items.longsword");
      assert.equal(dispatched[0].targetContainerId, null);
    });
  });

  describe("Moving Items Between Containers with TrameCommand.UpdateActorSheet", () => {
    it("CompendiumDragDropManager dispatches TrameCommand.UpdateActorSheet when moving items between containers", () => {
      const dispatched: any[] = [];
      const items: InventoryContainerItem[] = [
        { id: "backpack-1", isContainer: true, containerId: null },
        { id: "potion-heal", containerId: null },
      ];

      const manager = new CompendiumDragDropManager({
        systemId: "dnd5e",
        actorId: "actor-rogue",
        items,
        dispatchCommand: (cmd) => dispatched.push(cmd),
      });

      const success = manager.moveItem("potion-heal", "backpack-1");
      assert.equal(success, true);
      assert.equal(dispatched.length, 1);

      const cmd = dispatched[0];
      assert.equal(cmd.cmd, "UPDATE_ACTOR_SHEET");
      assert.equal(cmd.itemId, "potion-heal");
      assert.equal(cmd.targetContainerId, "backpack-1");
      assert.equal(cmd.path, "items.potion-heal.containerId");
      assert.equal(items.find((i) => i.id === "potion-heal")?.containerId, "backpack-1");
    });

    it("rejects move and dispatches zero commands when moving container into itself or descendant", () => {
      const dispatched: any[] = [];
      const items: InventoryContainerItem[] = [
        { id: "outer-box", isContainer: true, containerId: null },
        { id: "inner-box", isContainer: true, containerId: "outer-box" },
      ];

      const manager = new CompendiumDragDropManager({
        systemId: "dnd5e",
        items,
        dispatchCommand: (cmd) => dispatched.push(cmd),
      });

      const selfMove = manager.moveItem("outer-box", "outer-box");
      assert.equal(selfMove, false);
      assert.equal(dispatched.length, 0);

      const descendantMove = manager.moveItem("outer-box", "inner-box");
      assert.equal(descendantMove, false);
      assert.equal(dispatched.length, 0);
    });
  });

  describe("DragEvent Serialization Helpers", () => {
    it("serializes and parses compendium drag transfer data", () => {
      const manager = new CompendiumDragDropManager("dnd5e");
      const payload = {
        systemId: "dnd5e",
        entryRef: "dnd5e.feats.alert",
        entryType: "feat",
      };

      const serialized = manager.createDragData(payload);
      assert.ok(typeof serialized === "string");

      const mockEvent = {
        dataTransfer: {
          getData: (format: string) =>
            format === "application/json" ? serialized : "",
        },
      };

      const parsed = manager.parseDragEvent(mockEvent);
      assert.deepEqual(parsed, payload);

      let prevented = false;
      manager.handleDragOver({ preventDefault: () => (prevented = true) });
      assert.equal(prevented, true);
    });
  });
});
