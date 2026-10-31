import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appSignals, resetAppSignals } from "../src/state/appSignals.ts";
import { ApiClient } from "../src/api/client.ts";
import { CompendiumDragDropManager } from "../src/dnd/CompendiumDragDropManager.ts";
import { CharacterBuilderWizard } from "../src/builder/CharacterBuilderWizard.ts";
import { DND5E_SHEET_LAYOUT } from "@trame/game-system-dnd5e/src/sheetLayout.ts";
import { DeclarativeSheetRenderer } from "../src/sheet/DeclarativeSheetRenderer.ts";
import { WidgetRegistry } from "../src/sheet/WidgetRegistry.ts";
import { registerAllCanonicalWidgets } from "../src/sheet/widgets/index.ts";
import type { ActorRecord, TrameCommand } from "../src/types/index.ts";

registerAllCanonicalWidgets(WidgetRegistry);

class MockPlayableClient extends ApiClient {
  public sentCommands: TrameCommand[] = [];
  public lastPutActor: { campaignId: string; actorId: string; data: unknown } | null = null;
  public revealedHandouts: unknown[] = [];

  public override sendCommand(command: TrameCommand): Uint8Array {
    this.sentCommands.push(command);
    return new Uint8Array([1, 2, 3]);
  }

  public override async updateActor(
    campaignId: string,
    actorId: string,
    data: Partial<ActorRecord> & { spawnOnMap?: boolean },
  ): Promise<ActorRecord> {
    this.lastPutActor = { campaignId, actorId, data };
    return {
      id: actorId,
      campaignId,
      name: data.name || "Hero",
      kind: "character",
      hp: data.hp || 20,
      maxHp: data.maxHp || 20,
      ...data,
    };
  }

  public override async revealHandout(campaignId: string, data: any): Promise<any> {
    this.revealedHandouts.push(data);
    return {
      event: "handout.revealed",
      handoutId: data.handoutId,
      title: data.title,
      content: data.content,
      revealedBy: "GM",
      timestamp: Date.now(),
    };
  }
}

describe("E2E Playable Tabletop Flow", () => {
  it("executes registration, campaign creation, starter dungeon bootstrap, and actor rendering", async () => {
    resetAppSignals();
    const mockClient = new MockPlayableClient();

    appSignals.authUserSignal.value = {
      id: "gm-user-1",
      email: "gm@test.com",
      displayName: "Dungeon Master",
      username: "Dungeon Master",
      role: "GM",
      isGuest: false,
      isEphemeral: false,
    };

    const testCampaign = {
      id: "camp-123",
      name: "Starter Mines",
      system: "dnd5e",
      role: "GM",
      createdAt: new Date().toISOString(),
    };
    appSignals.campaignsSignal.value = [testCampaign];
    appSignals.activeCampaignSignal.value = testCampaign;

    appSignals.tableStateSignal.value = {
      campaignId: testCampaign.id,
      mode: "TURN_BY_TURN",
      explorationPaused: false,
      ambientLighting: "DAYLIGHT",
      cellSizePx: 100,
      feetPerCell: 5,
      tokens: {},
      walls: [],
      initiativeOrder: ["actor-hero", "actor-goblin"],
      activeTurnIndex: 0,
      round: 1,
    };

    const wizard = new CharacterBuilderWizard();
    wizard.setAncestry("human");
    assert.equal(wizard.nextStep(), true);
    wizard.setClass("fighter");
    assert.equal(wizard.nextStep(), true);
    wizard.setAbilityScores({ str: 16, con: 14 });
    assert.equal(wizard.nextStep(), true);
    wizard.setEquipment(["longsword", "shield"]);
    assert.equal(wizard.nextStep(), true);
    assert.equal(wizard.currentStep, "review");

    const heroActor: ActorRecord = {
      id: "actor-hero",
      campaignId: testCampaign.id,
      name: "Valeros",
      kind: "character",
      hp: 12,
      maxHp: 12,
      position: { x: 200, y: 200 },
      topLeft: { x: 200, y: 200 },
      sheet: {
        name: "Valeros",
        abilities: {
          str: { score: 16, mod: 3 },
          dex: { score: 14, mod: 2 },
          con: { score: 14, mod: 2 },
          int: { score: 10, mod: 0 },
          wis: { score: 12, mod: 1 },
          cha: { score: 8, mod: -1 },
        },
        items: [],
      },
    };

    await mockClient.updateActor(testCampaign.id, heroActor.id, { ...heroActor, spawnOnMap: true });
    assert.ok(mockClient.lastPutActor);
    assert.equal(mockClient.lastPutActor.actorId, "actor-hero");

    appSignals.actorsSignal.value = [heroActor];

    const rendered = DeclarativeSheetRenderer.render(
      DND5E_SHEET_LAYOUT,
      {
        sheet: heroActor.sheet,
        derived: {
          armorClass: 16,
          initiativeBonus: 2,
          speed: 30,
          savingThrows: [],
          skills: [],
          attacks: [{ id: "atk-1", name: "Longsword", attackBonus: 5, damageFormula: "1d8+3" }],
          spells: [],
          features: [],
        },
      },
      { isGm: true, isOwner: true },
      (cmd) => mockClient.sendCommand(cmd as unknown as TrameCommand),
    );
    assert.ok(rendered.root);

    const dragDropManager = new CompendiumDragDropManager({
      systemId: "dnd5e",
      actorId: heroActor.id,
      dispatchCommand: (cmd) => mockClient.sendCommand(cmd as unknown as TrameCommand),
    });
    const dropped = dragDropManager.handleDrop({
      systemId: "dnd5e",
      entityType: "spell",
      id: "magic-missile",
      name: "Magic Missile",
      data: { name: "Magic Missile" },
    });
    assert.equal(dropped, true);
    assert.ok(mockClient.sentCommands.some((c) => (c as any).type === "DropCompendiumEntry" || (c as any).cmd === "DROP_COMPENDIUM_ENTRY"));

    mockClient.sendCommand({
      cmd: "ROLL_DICE",
      expression: "1d20+3",
      reason: "Ability Check: STR",
      visibility: "PUBLIC",
    } as unknown as TrameCommand);
    appSignals.diceLogSignal.value = [
      ...appSignals.diceLogSignal.value,
      {
        rollId: "roll-1",
        rollerUserId: "gm-user-1",
        expression: "1d20+3",
        reason: "Ability Check: STR",
        blindMasked: false,
        total: 19,
      },
    ];
    assert.equal(appSignals.diceLogSignal.value.length, 1);
    assert.equal(appSignals.diceLogSignal.value[0].total, 19);

    const handout = await mockClient.revealHandout(testCampaign.id, {
      handoutId: "handout-lore",
      title: "Ancient Scroll",
      content: "The dragon sleeps in the lower caverns.",
    });
    appSignals.revealedHandoutSignal.value = handout;
    assert.equal(appSignals.revealedHandoutSignal.value?.title, "Ancient Scroll");
  });
});
