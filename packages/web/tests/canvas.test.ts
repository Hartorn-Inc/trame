import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ApiClient } from "../src/api/client.ts";
import { Bvh2D, WasmSpatialEngine } from "../src/engine/wasmBridge.ts";
import { appSignals, resetAppSignals } from "../src/state/appSignals.ts";
import type { CampaignRoomState, TrameCommand } from "../src/types/index.ts";

if (typeof register === "function") {
  register("./tsx-loader.mjs", import.meta.url);
}

import { h, render } from "preact";
const { TableCanvas, HeadlessCanvasMock, isWebGLAvailable } = await import("../src/components/TableCanvas.tsx");
const { GmOverrideToolbar } = await import("../src/components/GmOverrideToolbar.tsx");

class SimpleDomNode {
  nodeType: number;
  nodeName: string;
  childNodes: SimpleDomNode[] = [];
  parentNode: SimpleDomNode | null = null;
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  _listeners: Record<string, Function[]> = {};
  _value = "";
  files: unknown[] = [];

  constructor(nodeType: number, nodeName: string, text = "") {
    this.nodeType = nodeType;
    this.nodeName = nodeName.toUpperCase();
    this._value = text;
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
  remove(): void {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }
  setAttribute(k: string, v: string): void {
    this.attributes[k] = String(v);
    this.attributes[k.toLowerCase()] = String(v);
  }
  removeAttribute(k: string): void {
    delete this.attributes[k];
    delete this.attributes[k.toLowerCase()];
  }
  getAttribute(k: string): string | null {
    if (k in this.attributes) return this.attributes[k];
    const lower = k.toLowerCase();
    if (lower in this.attributes) return this.attributes[lower];
    const propVal = (this as unknown as Record<string, unknown>)[k];
    if (propVal !== undefined && propVal !== null) return String(propVal);
    return null;
  }
  addEventListener(type: string, fn: Function): void {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type: string, fn: Function): void {
    if (this._listeners[type]) {
      this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
    }
  }
  dispatchEvent(ev: { type: string; target?: unknown; preventDefault?: () => void; [k: string]: unknown }): boolean {
    const eventObj = {
      ...ev,
      target: ev.target || this,
      currentTarget: this,
      preventDefault: ev.preventDefault || (() => {}),
      stopPropagation: () => {},
    };
    for (const h of this._listeners[ev.type] || []) {
      h.call(this, eventObj);
    }
    return true;
  }
  click(): void {
    this.dispatchEvent({ type: "click" });
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 };
  }
  getContext() {
    return null;
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
}

function matchSelector(node: SimpleDomNode, sel: string): boolean {
  if (sel.startsWith("[") && sel.endsWith("]")) {
    const inner = sel.slice(1, -1);
    const eqIdx = inner.indexOf("=");
    if (eqIdx !== -1) {
      const attr = inner.slice(0, eqIdx).trim();
      const val = inner.slice(eqIdx + 1).replace(/^["']|["']$/g, "").trim();
      return node.attributes[attr] === val;
    }
    return inner in node.attributes;
  }
  return node.nodeName.toLowerCase() === sel.toLowerCase();
}

function setupTestDom() {
  const listeners: Record<string, Function[]> = {};
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
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type: string, fn: Function) {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    dispatchEvent(ev: { type: string; [k: string]: unknown }) {
      for (const fn of listeners[ev.type] || []) {
        fn(ev);
      }
      return true;
    },
    requestAnimationFrame(cb: Function) { return setTimeout(cb, 0); },
    cancelAnimationFrame(id: NodeJS.Timeout) { clearTimeout(id); },
  };
  (globalThis as unknown as { document: unknown }).document = doc;
  (globalThis as unknown as { window: unknown }).window = win;
  return { doc, win };
}

const sampleTableState: CampaignRoomState = {
  campaignId: "c-canvas-1",
  mode: "EXPLORATION",
  explorationPaused: false,
  ambientLighting: "DAYLIGHT",
  cellSizePx: 100,
  feetPerCell: 5,
  tokens: {
    "tok-1": {
      id: "tok-1",
      name: "Valeros",
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
      id: "wall-solid",
      a: { x: 200, y: 50 },
      b: { x: 200, y: 150 },
      blocksMovement: true,
      blocksVision: true,
      blocksLight: true,
      blocksSound: true,
      bottomElevationFt: -100,
      topElevationFt: 100,
    },
    {
      id: "door-gate-1",
      a: { x: 300, y: 50 },
      b: { x: 300, y: 150 },
      blocksMovement: true,
      blocksVision: true,
      blocksLight: true,
      blocksSound: true,
      bottomElevationFt: -100,
      topElevationFt: 100,
      kind: "Door",
    },
  ],
  initiativeOrder: ["tok-1"],
  activeTurnIndex: 0,
  round: 1,
  mapWidthPx: 1200,
  mapHeightPx: 800,
};

describe("Interactive TableCanvas, WasmSpatialEngine & GmOverrideToolbar suite", () => {
  beforeEach(() => {
    resetAppSignals();
    setupTestDom();
  });

  afterEach(() => {
    // cleanup
  });

  it("WHEN WebAssembly.instantiateStreaming rejects during WASM loading, WasmSpatialEngine sets engineMode to TYPESCRIPT_FALLBACK and routes raycast queries to Bvh2D.", async () => {
    const origInstantiateStreaming = (globalThis as unknown as { WebAssembly?: { instantiateStreaming?: unknown } }).WebAssembly?.instantiateStreaming;
    if (typeof WebAssembly !== "undefined") {
      (WebAssembly as unknown as { instantiateStreaming: unknown }).instantiateStreaming = () =>
        Promise.reject(new Error("WASM instantiation failure"));
    }

    const testWalls = [
      {
        id: "w1",
        a: { x: 50, y: 0 },
        b: { x: 50, y: 100 },
        blocksVision: true,
        blocksMovement: true,
        bottomElevationFt: -100,
        topElevationFt: 100,
      },
    ];

    const engine = new WasmSpatialEngine(testWalls);
    await engine.load("http://localhost:4000/trame_engine.wasm");

    assert.equal(engine.engineMode, "TYPESCRIPT_FALLBACK");

    const hit = engine.raycast({ x: 0, y: 50 }, { x: 100, y: 50 });
    assert.ok(hit !== null);
    assert.equal(hit.wallId, "w1");
    assert.equal(Math.round(hit.t * 100) / 100, 0.5);

    const clear = engine.raycast({ x: 0, y: 150 }, { x: 100, y: 150 });
    assert.equal(clear, null);

    if (typeof WebAssembly !== "undefined" && origInstantiateStreaming) {
      (WebAssembly as unknown as { instantiateStreaming: unknown }).instantiateStreaming = origInstantiateStreaming;
    }
  });

  it("WHEN TableCanvas initializes in a headless environment without WebGL context support, TableCanvas mounts HeadlessCanvasMock and emits a mock-canvas-active CustomEvent on the window object.", async () => {
    let mockEventEmitted = false;
    let mockEventDetail: unknown = null;

    window.addEventListener("mock-canvas-active", (ev: { detail?: unknown }) => {
      mockEventEmitted = true;
      mockEventDetail = ev.detail;
    });

    const container = new SimpleDomNode(1, "div");
    render(h(TableCanvas, { tableState: sampleTableState }), container as unknown as Element);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(isWebGLAvailable(), false);
    assert.equal(mockEventEmitted, true);
    assert.ok(mockEventDetail !== null);
    assert.equal((mockEventDetail as { headless: boolean }).headless, true);

    const mockElement = container.querySelector('[data-testid="headless-canvas-mock"]');
    assert.ok(mockElement !== null);
    render(null, container as unknown as Element);
  });

  it("WHEN an actor token drag gesture completes on TableCanvas, TableCanvas executes a collision check against SceneGraph wall segments and dispatches a TrameCommand::MoveToken command over the WebSocket client.", async () => {
    const mockClient = new ApiClient();
    let dispatchedCommand: TrameCommand | null = null;
    mockClient.sendCommand = (cmd: TrameCommand) => {
      dispatchedCommand = cmd;
      return new Uint8Array();
    };

    let collisionDetected: boolean | null = null;
    const container = new SimpleDomNode(1, "div");
    render(
      h(TableCanvas, {
        client: mockClient,
        tableState: sampleTableState,
        onCollisionCheck: (collided) => {
          collisionDetected = collided;
        },
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    const tokenEl = container.querySelector('[data-testid="token-tok-1"]');
    assert.ok(tokenEl !== null);

    // Simulate dragging clear of wall
    tokenEl.dispatchEvent({ type: "pointerdown", clientX: 100, clientY: 100 });
    tokenEl.dispatchEvent({ type: "pointermove", clientX: 150, clientY: 100 });
    tokenEl.dispatchEvent({ type: "pointerup", clientX: 150, clientY: 100 });

    assert.equal(collisionDetected, false);
    assert.ok(dispatchedCommand !== null);
    assert.equal((dispatchedCommand as { cmd: string }).cmd, "MOVE_TOKEN");
    assert.equal((dispatchedCommand as { token_id: string }).token_id, "tok-1");
    assert.deepEqual((dispatchedCommand as { to_top_left: { x: number; y: number } }).to_top_left, {
      x: 150,
      y: 100,
    });

    // Simulate dragging across wall at x=200
    tokenEl.dispatchEvent({ type: "pointerdown", clientX: 100, clientY: 100 });
    tokenEl.dispatchEvent({ type: "pointermove", clientX: 250, clientY: 100 });
    tokenEl.dispatchEvent({ type: "pointerup", clientX: 250, clientY: 100 });
    assert.equal(collisionDetected, true);
    render(null, container as unknown as Element);
  });

  it("WHEN a user clicks on an interactive door segment on TableCanvas, TableCanvas dispatches a TrameCommand::ToggleDoor command with the target door identifier over the WebSocket client.", async () => {
    const mockClient = new ApiClient();
    let toggleCommand: TrameCommand | null = null;
    mockClient.sendCommand = (cmd: TrameCommand) => {
      toggleCommand = cmd;
      return new Uint8Array();
    };

    const container = new SimpleDomNode(1, "div");
    render(
      h(TableCanvas, {
        client: mockClient,
        tableState: sampleTableState,
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    const doorEl = container.querySelector('[data-testid="door-door-gate-1"]');
    assert.ok(doorEl !== null);

    doorEl.click();
    assert.ok(toggleCommand !== null);
    assert.equal((toggleCommand as { cmd: string }).cmd, "TOGGLE_DOOR");
    assert.equal((toggleCommand as { wall_id: string }).wall_id, "door-gate-1");
    assert.equal((toggleCommand as { is_open: boolean }).is_open, true);
    render(null, container as unknown as Element);
  });

  it("WHEN an operator activates the 3D distance ruler tool on TableCanvas, TableCanvas renders a line overlay displaying Euclidean distance calculated via sqrt(dx^2 + dy^2 + dz^2).", async () => {
    const container = new SimpleDomNode(1, "div");
    render(
      h(TableCanvas, {
        tableState: sampleTableState,
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    const rulerBtn = container.querySelector('[data-testid="tool-ruler-btn"]');
    assert.ok(rulerBtn !== null);
    rulerBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    // Enter elevation of 12 ft
    const elevInput = container.querySelector('[data-testid="ruler-elevation-input"]');
    assert.ok(elevInput !== null);
    elevInput.value = "12";
    elevInput.dispatchEvent({ type: "input", target: elevInput });

    // Click start at (0, 0) and end at (300, 400)
    // cellSizePx = 100, feetPerCell = 5 -> pxPerFt = 20
    // dxFt = 15, dyFt = 20, dzFt = 12
    // sqrt(15^2 + 20^2 + 12^2) = sqrt(225 + 400 + 144) = sqrt(769) = 27.7308...
    const canvasRoot = container.querySelector('[data-testid="table-canvas-container"]');
    assert.ok(canvasRoot !== null);
    canvasRoot.dispatchEvent({ type: "click", clientX: 0, clientY: 0 });
    canvasRoot.dispatchEvent({ type: "click", clientX: 300, clientY: 400 });
    await new Promise((r) => setTimeout(r, 15));

    const rulerOverlay = container.querySelector('[data-testid="ruler-line-overlay"]');
    assert.ok(rulerOverlay !== null);

    const distLabel = container.querySelector('[data-testid="ruler-distance-label"]');
    assert.ok(distLabel !== null);
    assert.ok(distLabel.textContent.includes("27.7 ft"));
    render(null, container as unknown as Element);
  });

  it("WHEN a participant clicks the table surface with the ping key depressed, TableCanvas renders an animated PointerPing radar pulse at the clicked coordinates and broadcasts the ping to connected peers.", async () => {
    const mockClient = new ApiClient();
    let sentPingPos: { x: number; y: number } | null = null;
    mockClient.sendPointerPing = (pos) => {
      sentPingPos = pos;
      return new Uint8Array();
    };

    const container = new SimpleDomNode(1, "div");
    render(
      h(TableCanvas, {
        client: mockClient,
        tableState: sampleTableState,
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    const canvasRoot = container.querySelector('[data-testid="table-canvas-container"]');
    assert.ok(canvasRoot !== null);

    // Click with shiftKey depressed
    canvasRoot.dispatchEvent({ type: "click", clientX: 350, clientY: 250, shiftKey: true });
    await new Promise((r) => setTimeout(r, 15));

    const pingPulse = container.querySelector('[data-testid="pointer-ping"]');
    assert.ok(pingPulse !== null);
    assert.ok(sentPingPos !== null);
    assert.equal((sentPingPos as { x: number }).x, 350);
    assert.equal((sentPingPos as { y: number }).y, 250);
    render(null, container as unknown as Element);
  });

  it("WHEN an authorized Game Master clicks the Load Starter Dungeon button in GmOverrideToolbar.tsx, GmOverrideToolbar invokes POST /api/v1/campaigns/{id}/maps/starter and re-centers the TableCanvas viewport.", async () => {
    const mockClient = new ApiClient();
    let starterLoadedCampaignId: string | null = null;
    mockClient.loadStarterDungeon = async (cid) => {
      starterLoadedCampaignId = cid;
      return { status: "ok" };
    };

    let recenterTriggered = false;
    window.addEventListener("recenter-viewport", () => {
      recenterTriggered = true;
    });

    const container = new SimpleDomNode(1, "div");
    render(
      h(GmOverrideToolbar, {
        client: mockClient,
        campaignId: "c-canvas-1",
        isGm: true,
        onRecenterViewport: () => {
          recenterTriggered = true;
        },
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    const loadBtn = container.querySelector('[data-testid="load-starter-dungeon-btn"]');
    assert.ok(loadBtn !== null);
    loadBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(starterLoadedCampaignId, "c-canvas-1");
    assert.equal(recenterTriggered, true);
    render(null, container as unknown as Element);
  });

  it("WHEN an authorized Game Master clicks the Undo Action button in GmOverrideToolbar.tsx, GmOverrideToolbar dispatches a TrameCommand::UndoLastAction command over the WebSocket client.", async () => {
    const mockClient = new ApiClient();
    let undoCommandDispatched: TrameCommand | null = null;
    mockClient.sendCommand = (cmd: TrameCommand) => {
      undoCommandDispatched = cmd;
      return new Uint8Array();
    };

    let onUndoInvoked = false;
    const container = new SimpleDomNode(1, "div");
    render(
      h(GmOverrideToolbar, {
        client: mockClient,
        isGm: true,
        onUndo: () => {
          onUndoInvoked = true;
        },
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    const undoBtn = container.querySelector('[data-testid="undo-action-btn"]');
    assert.ok(undoBtn !== null);
    undoBtn.click();

    assert.ok(undoCommandDispatched !== null);
    assert.equal((undoCommandDispatched as { cmd: string }).cmd, "UNDO_LAST_ACTION");
    assert.equal(onUndoInvoked, true);
    render(null, container as unknown as Element);
  });

  it("manages Table Mode toggles and Ambient Lighting presets with CQRS commands in GmOverrideToolbar.tsx", async () => {
    const mockClient = new ApiClient();
    const commands: TrameCommand[] = [];
    mockClient.sendCommand = (cmd: TrameCommand) => {
      commands.push(cmd);
      return new Uint8Array();
    };

    appSignals.tableStateSignal.value = { ...sampleTableState };
    const container = new SimpleDomNode(1, "div");
    render(
      h(GmOverrideToolbar, {
        client: mockClient,
        isGm: true,
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    // Mode switch
    const turnBtn = container.querySelector('[data-testid="mode-turn-by-turn-btn"]');
    assert.ok(turnBtn !== null);
    turnBtn.click();

    assert.equal(commands.length, 1);
    assert.equal((commands[0] as { cmd: string; mode: string }).mode, "TURN_BY_TURN");
    assert.equal(appSignals.tableStateSignal.value?.mode, "TURN_BY_TURN");

    // Preset switch
    const presetSelect = container.querySelector('[data-testid="ambient-preset-select"]');
    assert.ok(presetSelect !== null);
    presetSelect.value = "NIGHT_MOONLIGHT";
    presetSelect.dispatchEvent({ type: "change", target: presetSelect });

    assert.equal(commands.length, 2);
    assert.equal((commands[1] as { cmd: string; preset: string }).preset, "NIGHT_MOONLIGHT");
    assert.equal(appSignals.tableStateSignal.value?.ambientLighting, "NIGHT_MOONLIGHT");
    render(null, container as unknown as Element);
  });

  it("enforces explicit business guardrails and WCAG 2.1 AA accessibility for non-GM users", async () => {
    appSignals.authUserSignal.value = {
      id: "u-player",
      email: "player@trame.test",
      displayName: "Player One",
      username: "Player One",
      isGuest: false,
      isEphemeral: false,
      role: "PLAYER",
    };

    const container = new SimpleDomNode(1, "div");
    render(
      h(GmOverrideToolbar, {
        isGm: false,
      }),
      container as unknown as Element,
    );
    await new Promise((r) => setTimeout(r, 20));

    const alertBanner = container.querySelector('[data-testid="gm-guardrail-banner"]');
    assert.ok(alertBanner !== null);
    assert.equal(alertBanner.getAttribute("role"), "alert");
    assert.ok(alertBanner.textContent.includes("Game Master privileges required"));

    const undoBtn = container.querySelector('[data-testid="undo-action-btn"]');
    assert.ok(undoBtn !== null);
    assert.equal(undoBtn.getAttribute("disabled"), "true");
    render(null, container as unknown as Element);
  });
});
