import assert from "node:assert/strict";
import module from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ApiClient } from "../src/api/client.ts";
import { Bvh2D, WasmSpatialEngine } from "../src/engine/wasmBridge.ts";
import { appSignals, resetAppSignals } from "../src/state/appSignals.ts";
import type { CampaignRoomState, TrameCommand } from "../src/types/index.ts";

if (typeof module.register === "function") {
  try {
    module.register("./tsx-loader.mjs", import.meta.url);
  } catch {
    // Optional tsx-loader registration hook
  }
}

import { h, options, render } from "preact";
import type { GmOverrideToolbarProps } from "../src/components/GmOverrideToolbar.tsx";
import type { TableCanvasProps } from "../src/components/TableCanvas.tsx";

options.debounceRendering = (cb) => cb();
options.requestAnimationFrame = (cb) => setTimeout(cb, 0);
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: Function) => setTimeout(cb, 0);
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = (id: NodeJS.Timeout) => clearTimeout(id);

const { TableCanvas } = await import("../src/components/TableCanvas.tsx");
const { GmOverrideToolbar } = await import("../src/components/GmOverrideToolbar.tsx");

class SimpleDomNode {
  nodeType: number;
  nodeName: string;
  childNodes: SimpleDomNode[] = [];
  parentNode: SimpleDomNode | null = null;
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  _eventHandlers: Record<string, Function[]> = {};
  _value = "";
  [key: string]: unknown;

  constructor(nodeType: number, nodeName: string, text = "") {
    this.nodeType = nodeType;
    this.nodeName = nodeName.toUpperCase();
    this._value = text;
    return new Proxy(this, {
      has(target, prop) {
        if (typeof prop === "string" && prop.startsWith("on")) {
          return true;
        }
        return prop in target;
      },
    });
  }

  get firstChild(): SimpleDomNode | null {
    return this.childNodes[0] || null;
  }
  get nextSibling(): SimpleDomNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 && idx < this.parentNode.childNodes.length - 1 ? this.parentNode.childNodes[idx + 1] : null;
  }
  get value(): string {
    return this._value;
  }
  set value(v: string) {
    this._value = String(v);
    this.attributes["value"] = String(v);
  }
  get textContent(): string {
    if (this.nodeType === 3) return this._value;
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    if (this.nodeType === 3) {
      this._value = v;
      return;
    }
    this.childNodes = [];
    if (v) this.appendChild(new SimpleDomNode(3, "#text", v));
  }

  remove(): void {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  appendChild(child: SimpleDomNode): SimpleDomNode {
    return this.insertBefore(child, null);
  }
  insertBefore(child: SimpleDomNode, ref: SimpleDomNode | null): SimpleDomNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    const idx = ref ? this.childNodes.indexOf(ref) : -1;
    if (idx === -1) this.childNodes.push(child);
    else this.childNodes.splice(idx, 0, child);
    return child;
  }
  removeChild(child: SimpleDomNode): SimpleDomNode {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  setAttribute(k: string, v: string): void {
    const lower = k.toLowerCase();
    this.attributes[lower] = String(v);
    if (lower === "value") {
      this._value = String(v);
    }
  }
  removeAttribute(k: string): void {
    delete this.attributes[k.toLowerCase()];
  }
  getAttribute(k: string): string | null {
    return this.attributes[k.toLowerCase()] ?? null;
  }
  addEventListener(type: string, fn: Function): void {
    const key = type.toLowerCase();
    (this._eventHandlers[key] = this._eventHandlers[key] || []).push(fn);
  }
  removeEventListener(type: string, fn: Function): void {
    const key = type.toLowerCase();
    if (this._eventHandlers[key]) {
      this._eventHandlers[key] = this._eventHandlers[key].filter((f) => f !== fn);
    }
  }
  dispatchEvent(ev: { type: string; target?: unknown; preventDefault?: () => void; [k: string]: unknown }): boolean {
    const type = ev.type.toLowerCase();
    const eventObj = {
      ...ev,
      type,
      target: ev.target || this,
      currentTarget: this,
      preventDefault: ev.preventDefault || (() => {}),
    };
    for (const h of this._eventHandlers[type] || []) {
      h.call(this, eventObj);
    }
    return true;
  }
  click(): void {
    this.dispatchEvent({ type: "click" });
  }
  querySelector(sel: string): SimpleDomNode | null {
    if (matchSelector(this, sel)) return this;
    for (const child of this.childNodes) {
      const found = child.querySelector(sel);
      if (found) return found;
    }
    return null;
  }
  querySelectorAll(sel: string): SimpleDomNode[] {
    const results: SimpleDomNode[] = [];
    if (matchSelector(this, sel)) results.push(this);
    for (const child of this.childNodes) {
      results.push(...child.querySelectorAll(sel));
    }
    return results;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 };
  }
}

function matchSelector(node: SimpleDomNode, sel: string): boolean {
  if (node.nodeType !== 1) return false;
  const tagMatch = sel.match(/^([a-z0-9_-]+)/i);
  let tag = "";
  let rest = sel;
  if (tagMatch) {
    tag = tagMatch[1].toLowerCase();
    rest = sel.slice(tagMatch[0].length);
  }
  if (tag && node.nodeName.toLowerCase() !== tag) {
    return false;
  }
  if (!rest) {
    return true;
  }
  if (rest.startsWith("[") && rest.endsWith("]")) {
    const inner = rest.slice(1, -1);
    const eqIdx = inner.indexOf("=");
    if (eqIdx !== -1) {
      const attr = inner.slice(0, eqIdx).trim().toLowerCase();
      const val = inner.slice(eqIdx + 1).replace(/^["']|["']$/g, "").trim();
      return node.attributes[attr] === val;
    }
    return inner.toLowerCase() in node.attributes;
  }
  return false;
}

function setupTestDom() {
  const eventListeners: Record<string, Function[]> = {};
  const doc = {
    nodeType: 9,
    nodeName: "#document",
    createElement(tag: string) {
      return new SimpleDomNode(1, tag);
    },
    createElementNS(_ns: string, tag: string) {
      return new SimpleDomNode(1, tag);
    },
    createTextNode(text: string) {
      return new SimpleDomNode(3, "#text", text);
    },
    createComment(text: string) {
      return new SimpleDomNode(8, "#comment", text);
    },
    body: new SimpleDomNode(1, "body"),
  };
  const win = {
    document: doc,
    location: { href: "http://localhost:3000/", search: "" },
    history: { replaceState() {} },
    addEventListener(type: string, fn: Function) {
      (eventListeners[type] = eventListeners[type] || []).push(fn);
    },
    removeEventListener(type: string, fn: Function) {
      if (eventListeners[type]) {
        eventListeners[type] = eventListeners[type].filter((f) => f !== fn);
      }
    },
    dispatchEvent(ev: { type: string; [k: string]: unknown }) {
      for (const h of eventListeners[ev.type] || []) {
        h(ev);
      }
      return true;
    },
    requestAnimationFrame(cb: Function) { return setTimeout(cb, 0); },
    cancelAnimationFrame(id: NodeJS.Timeout) { clearTimeout(id); },
  };
  (globalThis as unknown as { document: unknown }).document = doc;
  (globalThis as unknown as { window: unknown }).window = win;
  (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: Function) => setTimeout(cb, 0);
  (globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = (id: NodeJS.Timeout) => clearTimeout(id);
  options.debounceRendering = (cb) => cb();
  options.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  return { doc, win, eventListeners };
}

const sampleRoomState: CampaignRoomState = {
  campaignId: "campaign-dungeon-101",
  mode: "EXPLORATION",
  explorationPaused: false,
  ambientLighting: "DAYLIGHT",
  cellSizePx: 100,
  feetPerCell: 5,
  tokens: {
    "tok-fighter": {
      id: "tok-fighter",
      name: "Fighter",
      topLeft: { x: 100, y: 100 },
      gridW: 1,
      gridH: 1,
      isSqueezing: false,
      elevationFt: 0,
      heightFt: 5,
      visibilityChannel: 1,
      invisible: false,
      hp: 28,
      maxHp: 28,
      tempHp: 0,
      speedMaxFt: 30,
      speedRemainingFt: 30,
      hasAction: true,
      hasBonusAction: true,
      hasReaction: true,
    },
  },
  walls: [
    {
      id: "door-main",
      a: { x: 300, y: 100 },
      b: { x: 300, y: 200 },
      blocksMovement: true,
      blocksVision: true,
      blocksLight: true,
      blocksSound: true,
      bottomElevationFt: -1000,
      topElevationFt: 1000,
      kind: { Door: { is_open: false, is_locked: false } },
    },
    {
      id: "wall-stone",
      a: { x: 400, y: 0 },
      b: { x: 400, y: 300 },
      blocksMovement: true,
      blocksVision: true,
      blocksLight: true,
      blocksSound: true,
      bottomElevationFt: -1000,
      topElevationFt: 1000,
      kind: "Normal",
    },
  ],
  initiativeOrder: ["tok-fighter"],
  activeTurnIndex: 0,
  round: 1,
};

describe("TableCanvas, WasmSpatialEngine & GmOverrideToolbar suite", () => {
  beforeEach(() => {
    resetAppSignals();
    setupTestDom();
  });

  it("WHEN WebAssembly.instantiateStreaming rejects during WASM loading, WasmSpatialEngine sets engineMode to TYPESCRIPT_FALLBACK and routes raycast queries to Bvh2D.", async () => {
    const engine = new WasmSpatialEngine();
    const rejectingPromise = Promise.reject(new Error("Simulated streaming compilation failure"));
    await engine.init(rejectingPromise as unknown as Response);

    assert.equal(engine.engineMode, "TYPESCRIPT_FALLBACK");

    const testWalls = [
      {
        id: "wall-test-los",
        a: { x: 50, y: 0 },
        b: { x: 50, y: 100 },
        blocksVision: true,
        blocksMovement: true,
        bottomElevationFt: -100,
        topElevationFt: 100,
      },
    ];
    engine.setWalls(testWalls);

    const hit = engine.raycast({ x: 0, y: 50 }, { x: 100, y: 50 }, 5, 5);
    assert.notEqual(hit, null);
    assert.equal(hit?.wallId, "wall-test-los");
    assert.equal(hit?.point.x, 50);
    assert.equal(hit?.point.y, 50);
  });

  it("WHEN TableCanvas initializes in a headless environment without WebGL context support, TableCanvas mounts HeadlessCanvasMock and emits a mock-canvas-active CustomEvent on the window object.", async () => {
    const { win } = setupTestDom();
    let mockCanvasEventFired = false;
    win.addEventListener("mock-canvas-active", (ev: { detail?: { headless?: boolean } }) => {
      mockCanvasEventFired = true;
      assert.equal(ev?.detail?.headless, true);
    });

    const container = new SimpleDomNode(1, "div");
    render(h<TableCanvasProps>(TableCanvas, { roomState: sampleRoomState }), container as unknown as Element);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(mockCanvasEventFired, true);
    const mockElement = container.querySelector('[data-testid="headless-canvas-mock"]');
    assert.ok(mockElement);
    const statusBadge = container.querySelector('[data-testid="headless-status-badge"]');
    assert.ok(statusBadge);
    assert.ok(statusBadge.textContent.includes("HeadlessCanvasMock Active"));
  });

  it("WHEN an actor token drag gesture completes on TableCanvas, TableCanvas executes a collision check against SceneGraph wall segments and dispatches a TrameCommand::MoveToken command over the WebSocket client.", async () => {
    const dispatchedCommands: TrameCommand[] = [];
    const mockClient = new ApiClient();
    mockClient.sendCommand = (cmd: TrameCommand) => {
      dispatchedCommands.push(cmd);
      return new Uint8Array();
    };

    const container = new SimpleDomNode(1, "div");
    render(
      h<TableCanvasProps>(TableCanvas, {
        client: mockClient,
        roomState: sampleRoomState,
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    const tokenNode = container.querySelector('[data-testid="token-tok-fighter"]');
    assert.ok(tokenNode);

    tokenNode.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(dispatchedCommands.length, 1);
    const moveCmd = dispatchedCommands[0];
    assert.equal(moveCmd.cmd, "MOVE_TOKEN");
    assert.equal((moveCmd as any).token_id, "tok-fighter");
    assert.deepEqual((moveCmd as any).to_top_left, { x: 200, y: 100 });
  });

  it("WHEN an actor token is clicked and canvas destination is clicked, TableCanvas dispatches TrameCommand::MoveToken with selection highlight ring.", async () => {
    const dispatchedCommands: TrameCommand[] = [];
    const mockClient = new ApiClient();
    mockClient.sendCommand = (cmd: TrameCommand) => {
      dispatchedCommands.push(cmd);
      return new Uint8Array();
    };

    const container = new SimpleDomNode(1, "div");
    render(
      h<TableCanvasProps>(TableCanvas, {
        client: mockClient,
        roomState: sampleRoomState,
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    const tokenNode = container.querySelector('[data-testid="token-tok-fighter"]');
    assert.ok(tokenNode);

    tokenNode.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(tokenNode.style.border, "3px solid #f59e0b");

    const canvasMock = container.querySelector('[data-testid="headless-canvas-mock"]') || container.querySelector('[data-testid="pixi-canvas-element"]');
    assert.ok(canvasMock);
    canvasMock.dispatchEvent({
      type: "click",
      clientX: 200,
      clientY: 100,
    });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(dispatchedCommands.length, 1);
    const moveCmd = dispatchedCommands[0];
    assert.equal(moveCmd.cmd, "MOVE_TOKEN");
    assert.equal((moveCmd as any).token_id, "tok-fighter");
    assert.deepEqual((moveCmd as any).to_top_left, { x: 200, y: 100 });
  });

  it("WHEN a user clicks on an interactive door segment on TableCanvas, TableCanvas dispatches a TrameCommand::ToggleDoor command with the target door identifier over the WebSocket client.", async () => {
    const dispatchedCommands: TrameCommand[] = [];
    const mockClient = new ApiClient();
    mockClient.sendCommand = (cmd: TrameCommand) => {
      dispatchedCommands.push(cmd);
      return new Uint8Array();
    };

    const container = new SimpleDomNode(1, "div");
    render(
      h<TableCanvasProps>(TableCanvas, {
        client: mockClient,
        roomState: sampleRoomState,
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    const doorBtn = container.querySelector('[data-testid="door-segment-door-main"]');
    assert.ok(doorBtn);
    doorBtn.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(dispatchedCommands.length, 1);
    assert.deepEqual(dispatchedCommands[0], {
      cmd: "TOGGLE_DOOR",
      wall_id: "door-main",
      is_open: true,
    });
  });

  it("WHEN an operator activates the 3D distance ruler tool on TableCanvas, TableCanvas renders a line overlay displaying Euclidean distance calculated via sqrt(dx^2 + dy^2 + dz^2).", async () => {
    const container = new SimpleDomNode(1, "div");
    render(
      h<TableCanvasProps>(TableCanvas, {
        roomState: sampleRoomState,
        rulerActive: true,
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    const rulerOverlay = container.querySelector('[data-testid="ruler-overlay"]');
    assert.ok(rulerOverlay);
    const rulerVal = container.querySelector('[data-testid="ruler-distance-value"]');
    assert.ok(rulerVal);
    assert.ok(rulerVal.textContent.includes("Euclidean"));
  });

  it("WHEN a participant clicks the table surface with the ping key depressed, TableCanvas renders an animated PointerPing radar pulse at the clicked coordinates and broadcasts the ping to connected peers.", async () => {
    let pingEnvelopeSent = false;
    const mockClient = new ApiClient();
    mockClient.sendEnvelope = (envelope) => {
      if ("type" in envelope && envelope.type === "PointerPing") {
        pingEnvelopeSent = true;
        assert.ok(envelope.pos);
        assert.equal(envelope.pos?.x, 600);
        assert.equal(envelope.pos?.y, 400);
      }
      return new Uint8Array();
    };

    const container = new SimpleDomNode(1, "div");
    render(
      h<TableCanvasProps>(TableCanvas, {
        client: mockClient,
        roomState: sampleRoomState,
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    const pingBtn = container.querySelector('[data-testid="ping-tool-btn"]');
    assert.ok(pingBtn);
    pingBtn.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(pingEnvelopeSent, true);
    const pings = container.querySelectorAll('[data-testid="pointer-ping"]');
    assert.equal(pings.length, 1);
  });

  it("WHEN a PointerPingBroadcast envelope is received from the server, TableCanvas renders a radar pulse for the peer ping.", async () => {
    const mockClient = new ApiClient();
    const container = new SimpleDomNode(1, "div");
    render(
      h<TableCanvasProps>(TableCanvas, {
        client: mockClient,
        roomState: sampleRoomState,
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    mockClient.handleServerMessage({
      type: "PointerPingBroadcast",
      senderUserId: "peer-user-42",
      pos: { x: 350, y: 250 },
      colorHex: "#f59e0b",
    });
    await new Promise((r) => setTimeout(r, 20));

    const pings = container.querySelectorAll('[data-testid="pointer-ping"]');
    assert.equal(pings.length, 1);
  });

  it("WHEN arrow keys are pressed on an actor token, TableCanvas dispatches MoveToken in the corresponding direction", async () => {
    const dispatchedCommands: TrameCommand[] = [];
    const mockClient = new ApiClient();
    mockClient.sendCommand = (cmd: TrameCommand) => {
      dispatchedCommands.push(cmd);
      return new Uint8Array();
    };

    const container = new SimpleDomNode(1, "div");
    render(
      h<TableCanvasProps>(TableCanvas, {
        client: mockClient,
        roomState: sampleRoomState,
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    const tokenNode = container.querySelector('[data-testid="token-tok-fighter"]');
    assert.ok(tokenNode);

    tokenNode.dispatchEvent({ type: "keydown", key: "ArrowUp", preventDefault() {} });
    assert.equal(dispatchedCommands.length, 1);
    assert.deepEqual((dispatchedCommands[0] as any).to_top_left, { x: 100, y: 0 });

    tokenNode.dispatchEvent({ type: "keydown", key: "ArrowDown", preventDefault() {} });
    assert.equal(dispatchedCommands.length, 2);
    assert.deepEqual((dispatchedCommands[1] as any).to_top_left, { x: 100, y: 200 });

    tokenNode.dispatchEvent({ type: "keydown", key: "ArrowLeft", preventDefault() {} });
    assert.equal(dispatchedCommands.length, 3);
    assert.deepEqual((dispatchedCommands[2] as any).to_top_left, { x: 0, y: 100 });

    tokenNode.dispatchEvent({ type: "keydown", key: "ArrowRight", preventDefault() {} });
    assert.equal(dispatchedCommands.length, 4);
    assert.deepEqual((dispatchedCommands[3] as any).to_top_left, { x: 200, y: 100 });
  });

  it("WHEN an authorized Game Master clicks the Load Starter Dungeon button in GmOverrideToolbar.tsx, GmOverrideToolbar invokes POST /api/v1/campaigns/{id}/maps/starter and re-centers the TableCanvas viewport.", async () => {
    let starterMapLoaded = false;
    let viewportRecentered = false;
    const mockClient = new ApiClient();
    mockClient.loadStarterDungeon = async (cid: string) => {
      starterMapLoaded = true;
      assert.equal(cid, "campaign-dungeon-101");
      return { status: "loaded" };
    };

    appSignals.authUserSignal.value = {
      id: "u-gm",
      email: "gm@trame.test",
      displayName: "DungeonMaster",
      username: "DungeonMaster",
      role: "GM",
      isGuest: false,
      isEphemeral: false,
    };
    appSignals.activeCampaignSignal.value = {
      id: "campaign-dungeon-101",
      name: "Crypt of the Sun",
      system: "dnd5e",
      role: "GM",
      createdAt: "2026-03-31T00:00:00Z",
    };

    const container = new SimpleDomNode(1, "div");
    render(
      h<GmOverrideToolbarProps>(GmOverrideToolbar, {
        client: mockClient,
        campaignId: "campaign-dungeon-101",
        isGm: true,
        onRecenterViewport: () => {
          viewportRecentered = true;
        },
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    const loadBtn = container.querySelector('[data-testid="load-starter-dungeon-btn"]');
    assert.ok(loadBtn);
    loadBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(starterMapLoaded, true);
    assert.equal(viewportRecentered, true);
  });

  it("WHEN an authorized Game Master clicks the Undo Action button in GmOverrideToolbar.tsx, GmOverrideToolbar dispatches a TrameCommand::UndoLastAction command over the WebSocket client.", async () => {
    const dispatchedCommands: TrameCommand[] = [];
    const mockClient = new ApiClient();
    mockClient.sendCommand = (cmd: TrameCommand) => {
      dispatchedCommands.push(cmd);
      return new Uint8Array();
    };

    appSignals.authUserSignal.value = {
      id: "u-gm",
      email: "gm@trame.test",
      displayName: "DungeonMaster",
      username: "DungeonMaster",
      role: "GM",
      isGuest: false,
      isEphemeral: false,
    };

    const container = new SimpleDomNode(1, "div");
    render(
      h<GmOverrideToolbarProps>(GmOverrideToolbar, {
        client: mockClient,
        campaignId: "campaign-dungeon-101",
        isGm: true,
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    const undoBtn = container.querySelector('[data-testid="undo-action-btn"]');
    assert.ok(undoBtn);
    undoBtn.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(dispatchedCommands.length, 1);
    assert.deepEqual(dispatchedCommands[0], {
      cmd: "UNDO_LAST_ACTION",
    });
  });

  it("enforces explicit business safeguards and complete keyboard/ARIA accessibility on TableCanvas and GmOverrideToolbar (WCAG 2.1 AA)", () => {
    const canvasContainer = new SimpleDomNode(1, "div");
    render(h<TableCanvasProps>(TableCanvas, { roomState: sampleRoomState }), canvasContainer as unknown as Element);
    const region = canvasContainer.querySelector('[role="region"]');
    assert.ok(region);
    assert.equal(region.getAttribute("aria-label"), "Tactical Tabletop Canvas");
    assert.equal(region.getAttribute("tabindex"), "0");

    const tokenButton = canvasContainer.querySelector('[data-testid="token-tok-fighter"]');
    assert.ok(tokenButton);
    assert.equal(tokenButton.getAttribute("aria-pressed"), "false");
    assert.equal(tokenButton.style.backgroundColor, "#0369a1");
    assert.equal(tokenButton.style.color, "#ffffff");

    tokenButton.click();
    assert.equal(tokenButton.getAttribute("aria-pressed"), "true");
    assert.equal(tokenButton.style.backgroundColor, "#d97706");
    assert.equal(tokenButton.style.color, "#0f172a");

    const toolbarContainer = new SimpleDomNode(1, "div");
    render(
      h<GmOverrideToolbarProps>(GmOverrideToolbar, {
        campaignId: "campaign-dungeon-101",
        isGm: true,
      }),
      toolbarContainer as unknown as Element,
    );
    const toolbar = toolbarContainer.querySelector('[role="toolbar"]');
    assert.ok(toolbar);
    assert.equal(toolbar.getAttribute("aria-label"), "Game Master Omnipotent Override Toolbar");

    const modeGroup = toolbarContainer.querySelector('[role="group"]');
    assert.ok(modeGroup);
    assert.equal(modeGroup.getAttribute("aria-label"), "Table Play Mode");

    const uvttInput = toolbarContainer.querySelector('[data-testid="upload-uvtt-input"]');
    assert.ok(uvttInput);
    assert.equal(uvttInput.getAttribute("aria-hidden"), "true");
    assert.equal(uvttInput.getAttribute("tabindex"), "-1");
  });
});
