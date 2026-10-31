import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ApiClient } from "../src/api/client.ts";
import {
  activeCampaignSignal,
  activeDrawerSignal,
  actorsSignal,
  appSignals,
  authUserSignal,
  campaignsSignal,
  companionModeSignal,
  diceLogSignal,
  mutateActorPosition,
  notesSignal,
  resetAppSignals,
  revealedHandoutSignal,
  tableStateSignal,
  timelineSignal,
} from "../src/state/appSignals.ts";
import type { CampaignRoomState } from "../src/types/index.ts";

if (typeof register === "function") {
  register("./tsx-loader.mjs", import.meta.url);
}

import { h, render } from "preact";
const { AuthScreen } = await import("../src/components/AuthScreen.tsx");
const { CampaignLobby } = await import("../src/components/CampaignLobby.tsx");

class SimpleDomNode {
  nodeType: number;
  nodeName: string;
  childNodes: SimpleDomNode[] = [];
  parentNode: SimpleDomNode | null = null;
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  _listeners: Record<string, Function[]> = {};
  _value = "";

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
  setAttribute(k: string, v: string): void {
    this.attributes[k] = String(v);
  }
  removeAttribute(k: string): void {
    delete this.attributes[k];
  }
  getAttribute(k: string): string | null {
    return this.attributes[k] ?? null;
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
    };
    for (const h of this._listeners[ev.type] || []) {
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
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(cb: Function) { return setTimeout(cb, 0); },
    cancelAnimationFrame(id: NodeJS.Timeout) { clearTimeout(id); },
  };
  (globalThis as unknown as { document: unknown }).document = doc;
  (globalThis as unknown as { window: unknown }).window = win;
  return { doc, win };
}

const originalFetch = globalThis.fetch;

describe("PreactSignalState, AuthScreen, and CampaignLobby suite", () => {
  beforeEach(() => {
    resetAppSignals();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("initializes all 11 Preact signals with default values and resets them cleanly", () => {
    assert.equal(authUserSignal.value, null);
    assert.deepEqual(campaignsSignal.value, []);
    assert.equal(activeCampaignSignal.value, null);
    assert.equal(tableStateSignal.value, null);
    assert.deepEqual(actorsSignal.value, []);
    assert.deepEqual(notesSignal.value, []);
    assert.deepEqual(timelineSignal.value, []);
    assert.deepEqual(diceLogSignal.value, []);
    assert.equal(activeDrawerSignal.value, null);
    assert.equal(revealedHandoutSignal.value, null);
    assert.equal(companionModeSignal.value, false);

    authUserSignal.value = {
      id: "u-1",
      email: "test@trame.local",
      displayName: "Hero",
      username: "Hero",
      isGuest: false,
      isEphemeral: false,
      role: "PLAYER",
    };
    assert.notEqual(authUserSignal.value, null);

    resetAppSignals();
    assert.equal(authUserSignal.value, null);
  });

  it("mutateActorPosition mutates the target Actor position without replacing the root tableStateSignal reference", () => {
    const sampleState: CampaignRoomState = {
      campaignId: "c-1",
      mode: "EXPLORATION",
      explorationPaused: false,
      ambientLighting: "DAYLIGHT",
      cellSizePx: 100,
      feetPerCell: 5,
      tokens: {
        "tok-1": {
          id: "tok-1",
          name: "Valeros",
          topLeft: { x: 10, y: 20 },
          gridW: 1,
          gridH: 1,
          isSqueezing: false,
          elevationFt: 0,
          heightFt: 5,
          visibilityChannel: 1,
          invisible: false,
          hp: 20,
          maxHp: 20,
          tempHp: 0,
          speedMaxFt: 30,
          speedRemainingFt: 30,
          hasAction: true,
          hasBonusAction: true,
          hasReaction: true,
        },
      },
      walls: [],
      initiativeOrder: [],
      activeTurnIndex: 0,
      round: 1,
      actors: [
        {
          id: "tok-1",
          campaignId: "c-1",
          name: "Valeros",
          kind: "character",
          hp: 20,
          maxHp: 20,
          position: { x: 10, y: 20 },
          topLeft: { x: 10, y: 20 },
        },
      ],
    };

    tableStateSignal.value = sampleState;
    actorsSignal.value = [...(sampleState.actors || [])];
    const referenceBefore = tableStateSignal.value;

    const mutated = mutateActorPosition("tok-1", { x: 500, y: 600 }, 5, 20);
    assert.equal(mutated, true);

    assert.strictEqual(
      tableStateSignal.value,
      referenceBefore,
      "Root signal reference must remain identical",
    );
    assert.deepEqual(tableStateSignal.value?.tokens["tok-1"].topLeft, { x: 500, y: 600 });
    assert.equal(tableStateSignal.value?.tokens["tok-1"].elevationFt, 5);
    assert.equal(tableStateSignal.value?.tokens["tok-1"].speedRemainingFt, 20);
    assert.deepEqual(tableStateSignal.value?.actors?.[0].position, { x: 500, y: 600 });
  });

  it("WHEN an unauthenticated user submits the registration form in AuthScreen.tsx with valid inputs, AuthScreen calls POST /api/v1/auth/register, updates appSignals.authUserSignal, and transitions navigation to the campaign lobby.", async () => {
    setupTestDom();
    let registerCalled = false;
    const mockClient = new ApiClient();
    mockClient.register = async (data) => {
      registerCalled = true;
      assert.equal(data.email, "adventurer@trame.test");
      assert.equal(data.displayName, "Theron");
      return {
        id: "u-theron",
        email: data.email,
        displayName: data.displayName,
        username: data.displayName,
        isGuest: false,
        isEphemeral: false,
        role: "GM",
      };
    };

    let transitionedToLobby = false;
    const container = new SimpleDomNode(1, "div");
    render(
      h(AuthScreen, {
        client: mockClient,
        onNavigateToLobby: () => {
          transitionedToLobby = true;
        },
      }),
      container as unknown as Element,
    );

    const emailInput = container.querySelector('[data-testid="auth-email-input"]');
    const nameInput = container.querySelector('[data-testid="auth-display-name-input"]');
    const passInput = container.querySelector('[data-testid="auth-password-input"]');
    const form = container.querySelector('[data-testid="auth-form"]');
    assert.ok(emailInput);
    assert.ok(nameInput);
    assert.ok(passInput);
    assert.ok(form);

    emailInput.value = "adventurer@trame.test";
    emailInput.dispatchEvent({ type: "input", target: emailInput });
    nameInput.value = "Theron";
    nameInput.dispatchEvent({ type: "input", target: nameInput });
    passInput.value = "SecurePass2026!";
    passInput.dispatchEvent({ type: "input", target: passInput });

    form.dispatchEvent({ type: "submit", preventDefault() {} });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(registerCalled, true);
    assert.notEqual(appSignals.authUserSignal.value, null);
    assert.equal(appSignals.authUserSignal.value?.email, "adventurer@trame.test");
    assert.equal(transitionedToLobby, true);
  });

  it("WHEN a visitor navigates to the lobby URL with query parameter ?invite=<jwt>, CampaignLobby.tsx executes POST /api/v1/auth/magic-link/redeem, assigns the ephemeral user to appSignals.authUserSignal, and opens the invited campaign.", async () => {
    setupTestDom();
    let redeemCalled = false;
    const mockClient = new ApiClient();
    mockClient.redeemMagicLink = async (token) => {
      redeemCalled = true;
      assert.equal(token, "test-jwt-token-xyz");
      return {
        userId: "guest-user-1",
        username: "guest_1234",
        campaignId: "campaign-invited-999",
        role: "PLAYER",
        sessionId: "sess-1",
        user: {
          id: "guest-user-1",
          email: "ephemeral_guest-user-1@trame.local",
          displayName: "guest_1234",
          username: "guest_1234",
          isGuest: true,
          isEphemeral: true,
          role: "PLAYER",
        },
      };
    };

    let openedCampaignId: string | null = null;
    const container = new SimpleDomNode(1, "div");
    render(
      h(CampaignLobby, {
        client: mockClient,
        inviteToken: "test-jwt-token-xyz",
        onOpenCampaign: (id) => {
          openedCampaignId = id;
        },
      }),
      container as unknown as Element,
    );

    await new Promise((r) => setTimeout(r, 30));

    assert.equal(redeemCalled, true);
    assert.notEqual(appSignals.authUserSignal.value, null);
    assert.equal(appSignals.authUserSignal.value?.isGuest, true);
    assert.equal(appSignals.authUserSignal.value?.isEphemeral, true);
    assert.equal(openedCampaignId, "campaign-invited-999");
    assert.equal(appSignals.activeCampaignSignal.value?.id, "campaign-invited-999");
  });

  it("WHEN a Game Master clicks the Create Campaign button and submits a campaign name in CampaignLobby.tsx, CampaignLobby.tsx executes POST /api/v1/campaigns and appends the returned campaign summary to appSignals.campaignsSignal.", async () => {
    setupTestDom();
    let createCalled = false;
    const mockClient = new ApiClient();
    mockClient.createCampaign = async (req) => {
      createCalled = true;
      assert.equal(req.name, "Curse of the Crimson Citadel");
      return {
        id: "camp-crimson-1",
        name: req.name,
        system: req.system || "dnd5e",
        role: "GM",
        createdAt: "2026-03-31T00:00:00Z",
      };
    };

    const container = new SimpleDomNode(1, "div");
    render(h(CampaignLobby, { client: mockClient }), container as unknown as Element);

    const createBtn = container.querySelector('[data-testid="create-campaign-btn"]');
    assert.ok(createBtn);
    createBtn.click();

    const nameInput = container.querySelector('[data-testid="create-campaign-name-input"]');
    const createForm = container.querySelector('[data-testid="create-campaign-form"]');
    assert.ok(nameInput);
    assert.ok(createForm);

    nameInput.value = "Curse of the Crimson Citadel";
    nameInput.dispatchEvent({ type: "input", target: nameInput });

    createForm.dispatchEvent({ type: "submit", preventDefault() {} });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(createCalled, true);
    assert.equal(appSignals.campaignsSignal.value.length, 1);
    assert.equal(appSignals.campaignsSignal.value[0].name, "Curse of the Crimson Citadel");
  });

  it("enforces WCAG 2.1 AA keyboard and ARIA accessibility roles on AuthScreen and CampaignLobby", () => {
    setupTestDom();
    const authContainer = new SimpleDomNode(1, "div");
    render(h(AuthScreen, {}), authContainer as unknown as Element);
    const authMain = authContainer.querySelector('[role="main"]');
    assert.ok(authMain);
    assert.equal(authMain.getAttribute("aria-labelledby"), "auth-heading");

    const lobbyContainer = new SimpleDomNode(1, "div");
    render(h(CampaignLobby, {}), lobbyContainer as unknown as Element);
    const lobbyMain = lobbyContainer.querySelector('[role="main"]');
    assert.ok(lobbyMain);
    assert.equal(lobbyMain.getAttribute("aria-label"), "Campaign Lobby");

    const importBtn = lobbyContainer.querySelector('[data-testid="import-archive-btn"]');
    assert.ok(importBtn);
    assert.equal(importBtn.getAttribute("role"), "button");
    assert.equal(importBtn.getAttribute("tabindex"), "0");

    const importInput = lobbyContainer.querySelector('[data-testid="import-archive-input"]');
    assert.ok(importInput);
    assert.equal(importInput.getAttribute("tabindex"), "-1");
    assert.equal(importInput.getAttribute("aria-hidden"), "true");
  });
});
