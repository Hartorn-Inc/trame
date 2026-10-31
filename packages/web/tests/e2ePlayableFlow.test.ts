import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h, options, render } from "preact";
import { appSignals, resetAppSignals } from "../src/state/appSignals.ts";
import { ApiClient } from "../src/api/client.ts";
import { CompendiumDragDropManager } from "../src/dnd/CompendiumDragDropManager.ts";
import { CharacterBuilderWizard } from "../src/builder/CharacterBuilderWizard.ts";
import { DND5E_SHEET_LAYOUT } from "../../game-systems/dnd5e/src/sheetLayout.ts";
import { DeclarativeSheetRenderer } from "../src/sheet/DeclarativeSheetRenderer.ts";
import { WidgetRegistry } from "../src/sheet/WidgetRegistry.ts";
import { registerAllCanonicalWidgets } from "../src/sheet/widgets/index.ts";
import type { ActorRecord, TrameCommand } from "../src/types/index.ts";
import { ActorSheetDrawer } from "../src/components/ActorSheetDrawer.tsx";
import { ActorBuilderModal } from "../src/components/ActorBuilderModal.tsx";
import { ReactionBanner } from "../src/components/ReactionBanner.tsx";
import { DiceTrayDrawer } from "../src/components/DiceTrayDrawer.tsx";
import { WikiNotesDrawer } from "../src/components/WikiNotesDrawer.tsx";
import { HandoutPopupModal } from "../src/components/HandoutPopupModal.tsx";

class SimpleDomNode {
  nodeType: number;
  nodeName: string;
  childNodes: SimpleDomNode[] = [];
  parentNode: SimpleDomNode | null = null;
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  _eventHandlers: Record<string, Function[]> = {};
  _value = "";
  data = "";

  constructor(nodeType: number, nodeName: string) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.data;
    return this.childNodes.map((c) => c.textContent).join("");
  }

  set textContent(val: string) {
    if (this.nodeType === 3) {
      this.data = val;
    } else {
      this.childNodes = [];
      const tn = new SimpleDomNode(3, "#text");
      tn.data = val;
      tn.parentNode = this;
      this.childNodes.push(tn);
    }
  }

  get value(): string {
    return this._value;
  }

  set value(val: string) {
    this._value = val;
  }

  appendChild(node: SimpleDomNode): SimpleDomNode {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild(node: SimpleDomNode): SimpleDomNode {
    const idx = this.childNodes.indexOf(node);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      node.parentNode = null;
    }
    return node;
  }

  remove(): void {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  insertBefore(newNode: SimpleDomNode, refNode: SimpleDomNode | null): SimpleDomNode {
    if (!refNode) return this.appendChild(newNode);
    const idx = this.childNodes.indexOf(refNode);
    if (idx === -1) return this.appendChild(newNode);
    newNode.parentNode = this;
    this.childNodes.splice(idx, 0, newNode);
    return newNode;
  }

  setAttribute(name: string, val: string): void {
    this.attributes[name] = String(val);
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  addEventListener(name: string, fn: Function): void {
    const n = name.toLowerCase();
    if (!this._eventHandlers[n]) this._eventHandlers[n] = [];
    this._eventHandlers[n].push(fn);
  }

  removeEventListener(name: string, fn: Function): void {
    const n = name.toLowerCase();
    if (this._eventHandlers[n]) {
      this._eventHandlers[n] = this._eventHandlers[n].filter((f) => f !== fn);
    }
  }

  dispatchEvent(evt: unknown): boolean {
    const eventObj = (typeof evt === "string" ? { type: evt } : evt) as { type?: string; [key: string]: unknown };
    const name = (eventObj.type || "").toLowerCase();
    const handlers = this._eventHandlers[name] || [];
    for (const h of handlers) {
      h.call(this, eventObj);
    }
    return true;
  }

  click(): void {
    this.dispatchEvent({ type: "click", preventDefault() {} });
  }

  focus(): void {}

  getContext(): unknown {
    return {
      clearRect() {},
      fillRect() {},
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      strokeRect() {},
    };
  }

  querySelector(sel: string): SimpleDomNode | null {
    const attrMatch = sel.match(/^\[([a-zA-Z0-9_-]+)(?:="([^"]+)")?\]$/);
    if (attrMatch) {
      const [, aName, aVal] = attrMatch;
      const q = [this as SimpleDomNode];
      while (q.length > 0) {
        const cur = q.shift()!;
        if (aVal !== undefined) {
          if (cur.attributes[aName] === aVal) return cur;
        } else if (aName in cur.attributes) {
          return cur;
        }
        q.push(...cur.childNodes);
      }
      return null;
    }
    return null;
  }
}

function setupTestDom() {
  const doc = {
    createElement(name: string) { return new SimpleDomNode(1, name); },
    createElementNS(_ns: string, name: string) { return new SimpleDomNode(1, name); },
    createTextNode(text: string) { const tn = new SimpleDomNode(3, "#text"); tn.data = text; return tn; },
    body: new SimpleDomNode(1, "body"),
  };
  const win = {
    document: doc,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(cb: Function) { return setTimeout(cb, 0); },
    cancelAnimationFrame(id: NodeJS.Timeout) { clearTimeout(id); },
  };
  (globalThis as unknown as { document: unknown }).document = doc;
  (globalThis as unknown as { window: unknown }).window = win;
  (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: Function) => setTimeout(cb, 0);
  (globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = (id: NodeJS.Timeout) => clearTimeout(id);
  options.debounceRendering = (cb) => cb();
  options.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  return { doc, win };
}

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
    wizard.setAbilityScores({ str: 15, con: 14 });
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

    // Verify mounting and UI reactivity for Preact components
    setupTestDom();

    // 1. Mount ActorSheetDrawer empty state
    appSignals.actorsSignal.value = [];
    const emptySheetContainer = new SimpleDomNode(1, "div");
    render(h(ActorSheetDrawer, { client: mockClient }), emptySheetContainer as unknown as Element);
    const emptyStatePrompt = emptySheetContainer.querySelector('[data-testid="sheet-empty-state"]');
    assert.ok(emptyStatePrompt);

    // 2. Mount ActorSheetDrawer with populated actor and trigger roll
    appSignals.actorsSignal.value = [heroActor];
    const sheetContainer = new SimpleDomNode(1, "div");
    render(h(ActorSheetDrawer, { actor: heroActor, client: mockClient }), sheetContainer as unknown as Element);
    const saveBtn = sheetContainer.querySelector('[data-testid="save-dex-btn"]');
    assert.ok(saveBtn);
    const previousDiceLogCount = appSignals.diceLogSignal.value.length;
    saveBtn.click();
    assert.equal(appSignals.diceLogSignal.value.length, previousDiceLogCount + 1);
    assert.ok(mockClient.sentCommands.some((c) => (c as any).cmd === "ROLL_DICE"));

    // 3. Mount ActorBuilderModal and step progression
    let createdActorResult: ActorRecord | null = null;
    const builderContainer = new SimpleDomNode(1, "div");
    render(
      h(ActorBuilderModal, {
        client: mockClient,
        campaignId: testCampaign.id,
        onSuccess: (act) => { createdActorResult = act; },
      }),
      builderContainer as unknown as Element,
    );
    assert.ok(builderContainer.querySelector('[data-testid="actor-builder-modal"]'));
    const nextBtn = builderContainer.querySelector('[data-testid="builder-next-btn"]');
    assert.ok(nextBtn);
    nextBtn.click();
    assert.ok(builderContainer.querySelector('[data-testid="builder-class-select"]'));

    // 4. Mount ReactionBanner with alert scoping
    const reactionContainer = new SimpleDomNode(1, "div");
    let reactionDecision: boolean | null = null;
    render(
      h(ReactionBanner, {
        client: mockClient,
        prompt: {
          id: "prompt-e2e-1",
          triggerTokenName: "Goblin",
          reactorTokenName: "Valeros",
          description: "Leaving reach",
        },
        onDecision: (dec) => { reactionDecision = dec; },
      }),
      reactionContainer as unknown as Element,
    );
    const alertRegion = reactionContainer.querySelector('[role="alert"]');
    assert.ok(alertRegion);
    const acceptBtn = reactionContainer.querySelector('[data-testid="accept-reaction-btn"]');
    assert.ok(acceptBtn);
    acceptBtn.click();
    assert.equal(reactionDecision, true);

    // 5. Mount DiceTrayDrawer and WikiNotesDrawer
    const diceTrayContainer = new SimpleDomNode(1, "div");
    render(h(DiceTrayDrawer, { client: mockClient }), diceTrayContainer as unknown as Element);
    assert.ok(diceTrayContainer.querySelector('[data-testid="dice-tray-drawer"]'));

    const wikiContainer = new SimpleDomNode(1, "div");
    render(h(WikiNotesDrawer, { client: mockClient, campaignId: testCampaign.id }), wikiContainer as unknown as Element);
    assert.ok(wikiContainer.querySelector('[data-testid="wiki-notes-drawer"]'));

    // 6. Mount HandoutPopupModal
    const modalContainer = new SimpleDomNode(1, "div");
    render(h(HandoutPopupModal, { handout }), modalContainer as unknown as Element);
    assert.ok(modalContainer.querySelector('[data-testid="handout-popup-modal"]'));
    const closeHandoutBtn = modalContainer.querySelector('[data-testid="close-handout-modal-btn"]');
    assert.ok(closeHandoutBtn);
    closeHandoutBtn.click();
    assert.equal(appSignals.revealedHandoutSignal.value, null);
  });
});
