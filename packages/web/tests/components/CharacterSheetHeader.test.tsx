import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { h, render, options } from "preact";
import { createDefaultActorData, type Dnd5eActorData } from "../../../game-systems/dnd5e/src/index.ts";
import { ApiClient } from "../../src/api/client.ts";
import { createSessionState, selectedActorIdSignal } from "../../src/api/session.ts";
import { localeSignal } from "../../src/i18n/index.ts";
import { CharacterSheetHeader } from "../../src/components/character-sheet/CharacterSheetHeader.tsx";
import { HudDrawers, isSheetDrawerOpenSignal } from "../../src/hud/HudDrawers.tsx";
import { createSheetCommandDispatcher, restDiceRollService, setAtPath } from "../../src/sheet/sheetPersistence.ts";
import { setupMockDom } from "../helpers/mockDom.ts";
import { actorDto, createMockTransport, flush, type RouteReply } from "../helpers/mockTransport.ts";

setupMockDom();
localeSignal.value = "en";

const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR_URL = `/api/v1/campaigns/${CAMPAIGN_ID}/actors/${ACTOR_ID}`;

function sheet(level: number, name = "Brakka", classId = "fighter"): Dnd5eActorData {
  const actor = createDefaultActorData(ACTOR_ID, name);
  actor.classId = classId;
  actor.attributes.level = level;
  return actor;
}

function newClient(routes: Record<string, RouteReply> = {}, stored?: { version: number; data: Dnd5eActorData }) {
  const transport = createMockTransport(routes);
  const state = createSessionState();
  if (stored) state.actors.value = { [ACTOR_ID]: stored };
  return { client: new ApiClient({ transport, state }), state, transport };
}

async function mount(vnode: any) {
  options.debounceRendering = (cb: () => void) => cb();
  const doc = (globalThis as any).document;
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  render(vnode, container);
  await flush();
  return {
    container,
    byTestId: (id: string): any => container.querySelector(`[data-testid="${id}"]`),
    unmount: () => {
      render(null, container);
      container.remove();
    },
  };
}

async function click(el: any) {
  el.dispatchEvent(new (globalThis as any).Event("click"));
  await flush(4);
}

async function confirmLongRest(container: any) {
  const confirm: any = Array.from(container.querySelectorAll("button")).find((b: any) =>
    b.textContent?.includes("Confirm Long Rest"),
  );
  assert.ok(confirm, "Confirm Long Rest button must be rendered");
  await click(confirm);
}

describe("CharacterSheetHeader: labels and guardrails", () => {
  const cases = [
    { id: "workspace context shows the explicit level transition (AC1)", props: { context: "campaign_workspace" }, level: 3, label: "Level Up (Lvl 3 -> 4)", disabled: false },
    { id: "HUD drawer context shows the compact label (AC3)", props: { context: "hud_drawer" }, level: 5, label: "Level Up", disabled: false },
    { id: "level 20 disables Level Up with an explicit reason (AC6)", props: { context: "campaign_workspace" }, level: 20, label: "Level Up disabled: Maximum Level 20 reached", disabled: true },
  ];

  for (const c of cases) {
    it(c.id, async () => {
      const { client } = newClient();
      const { byTestId, container, unmount } = await mount(h(CharacterSheetHeader, { actor: sheet(c.level), client, ...(c.props as any) }));
      const levelUp = byTestId("btn-level-up");
      assert.equal(levelUp.getAttribute("aria-label"), c.label);
      assert.equal(levelUp.disabled, c.disabled);
      assert.equal(byTestId("btn-short-rest").getAttribute("aria-label"), "Short Rest");
      assert.equal(byTestId("btn-long-rest").getAttribute("aria-label"), "Long Rest");
      assert.equal(container.querySelector("[role='toolbar']")?.getAttribute("aria-label"), "Progression and Rest Actions");
      await click(levelUp);
      assert.equal(Boolean(byTestId("level-up-modal")), !c.disabled);
      unmount();
    });
  }
});

describe("CharacterSheetHeader: versioned REST save (AC2, AC4)", () => {
  const cases: Array<{
    id: string;
    context: "campaign_workspace" | "hud_drawer";
    reply: RouteReply;
    expectConflict: boolean;
    expectedVersionAfter: number;
  }> = [
    {
      id: "a long rest in the workspace PUTs { expected_version, name, data } and stores the new version",
      context: "campaign_workspace",
      reply: { status: 200, body: { actor: actorDto({ version: 5, data: sheet(2) }) } },
      expectConflict: false,
      expectedVersionAfter: 5,
    },
    {
      id: "a long rest from the live-table HUD uses the same REST PUT, never a table command",
      context: "hud_drawer",
      reply: { status: 200, body: { actor: actorDto({ version: 5, data: sheet(2) }) } },
      expectConflict: false,
      expectedVersionAfter: 5,
    },
    {
      id: "a stale version shows the conflict alert and keeps the stored sheet",
      context: "campaign_workspace",
      reply: { status: 409, body: { code: "VERSION_CONFLICT", error: "stale", current_version: 7 } },
      expectConflict: true,
      expectedVersionAfter: 4,
    },
  ];

  for (const c of cases) {
    it(c.id, async () => {
      const { client, state, transport } = newClient({ [`PUT ${ACTOR_URL}`]: c.reply }, { version: 4, data: sheet(2) });
      const saved: Dnd5eActorData[] = [];
      const { container, byTestId, unmount } = await mount(
        h(CharacterSheetHeader, {
          actor: sheet(2),
          actorId: ACTOR_ID,
          campaignId: CAMPAIGN_ID,
          client,
          context: c.context,
          onSave: (a) => {
            saved.push(a);
          },
        }),
      );
      await click(byTestId("btn-long-rest"));
      await confirmLongRest(container);

      assert.equal(transport.calls.length, 1);
      assert.equal(transport.calls[0].method, "PUT");
      assert.equal(transport.calls[0].url, ACTOR_URL);
      const body = transport.calls[0].body as Record<string, any>;
      assert.equal(body.expected_version, 4);
      assert.equal(body.name, "Brakka");
      assert.equal(body.data.id, ACTOR_ID);
      assert.equal(state.actors.value[ACTOR_ID].version, c.expectedVersionAfter);
      assert.equal(Boolean(byTestId("sheet-version-conflict")), c.expectConflict);
      assert.equal(saved.length, c.expectConflict ? 0 : 1);
      if (c.expectConflict) {
        assert.equal(byTestId("sheet-version-conflict").getAttribute("role"), "alert");
        assert.match(byTestId("sheet-version-conflict").textContent, /version 7/);
      }
      unmount();
    });
  }

  const resolutions = [
    {
      id: "Reload latest re-reads the sheet and dismisses the conflict",
      button: "btn-conflict-reload",
      route: `GET ${ACTOR_URL}`,
      reply: { status: 200, body: { actor: actorDto({ version: 7, data: sheet(6, "Brakka Remote") }) } },
      expectedPutVersions: [4],
    },
    {
      id: "Overwrite retries the PUT with the server's current_version",
      button: "btn-conflict-overwrite",
      route: `PUT ${ACTOR_URL}`,
      reply: { status: 200, body: { actor: actorDto({ version: 8, data: sheet(2) }) } },
      expectedPutVersions: [4, 7],
    },
  ];

  for (const r of resolutions) {
    it(r.id, async () => {
      const { client, state, transport } = newClient(
        { [`PUT ${ACTOR_URL}`]: { status: 409, body: { code: "VERSION_CONFLICT", error: "stale", current_version: 7 } } },
        { version: 4, data: sheet(2) },
      );
      const { container, byTestId, unmount } = await mount(
        h(CharacterSheetHeader, { actor: sheet(2), actorId: ACTOR_ID, campaignId: CAMPAIGN_ID, client }),
      );
      await click(byTestId("btn-long-rest"));
      await confirmLongRest(container);
      transport.routes[r.route] = r.reply;
      await click(byTestId(r.button));

      const putVersions = transport.calls.filter((call) => call.method === "PUT").map((call) => (call.body as any).expected_version);
      assert.deepEqual(putVersions, r.expectedPutVersions);
      assert.equal(byTestId("sheet-version-conflict"), null);
      assert.equal(state.actors.value[ACTOR_ID].version, r.reply.body.actor.version);
      unmount();
    });
  }
});

describe("CharacterSheetHeader: ActorUpdated broadcasts re-render the sheet (AC5)", () => {
  const cases = [
    { id: "a newer broadcast replaces the displayed name and level", version: 5, name: "Krag the Victorious", level: 3, expectedSummary: "Level 3 barbarian" },
    { id: "a stale broadcast is ignored", version: 1, name: "Old Krag", level: 1, expectedSummary: "Level 2 barbarian" },
  ];

  for (const c of cases) {
    it(c.id, async () => {
      const { client } = newClient({}, { version: 2, data: sheet(2, "Krag", "barbarian") });
      const { byTestId, unmount } = await mount(
        h(CharacterSheetHeader, { actor: sheet(2, "Krag", "barbarian"), actorId: ACTOR_ID, campaignId: CAMPAIGN_ID, client, context: "live_table" }),
      );
      client.applyServerEnvelope({ type: "ActorUpdated", actorId: ACTOR_ID, version: c.version, data: sheet(c.level, c.name, "barbarian") });
      await flush();
      assert.equal(byTestId("sheet-actor-summary").textContent, c.expectedSummary);
      unmount();
    });
  }
});

describe("HudDrawers: selected actor sheet", () => {
  beforeEach(() => {
    isSheetDrawerOpenSignal.value = true;
  });

  const cases = [
    { id: "a selected actor with a readable sheet mounts the header and the 12-widget view", selected: ACTOR_ID, expectSheet: true },
    { id: "a selected token without a readable sheet shows the no-sheet hint", selected: "44444444-4444-4444-8444-444444444444", expectSheet: false },
  ];

  for (const c of cases) {
    it(c.id, async () => {
      const { client } = newClient({}, { version: 1, data: sheet(2) });
      selectedActorIdSignal.value = c.selected;
      const { byTestId, unmount } = await mount(h(HudDrawers, { campaignId: CAMPAIGN_ID, client }));
      assert.equal(Boolean(byTestId("character-sheet-header")), c.expectSheet);
      assert.equal(Boolean(byTestId("declarative-sheet-view")), c.expectSheet);
      assert.equal(Boolean(byTestId("hud-no-sheet")), !c.expectSheet);
      unmount();
      selectedActorIdSignal.value = null;
    });
  }

  it("Escape inside the sheet drawer closes it", async () => {
    const { client } = newClient({}, { version: 1, data: sheet(2) });
    const { byTestId, unmount } = await mount(h(HudDrawers, { campaignId: CAMPAIGN_ID, client, actorId: ACTOR_ID }));
    byTestId("hud-sheet-drawer").dispatchEvent(new (globalThis as any).Event("keydown", { key: "Escape" }));
    assert.equal(isSheetDrawerOpenSignal.value, false);
    unmount();
  });
});

describe("sheet widget commands route to REST", () => {
  it("ROLL_DICE becomes POST /dice/roll with mapped visibility", async () => {
    const roll = `POST /api/v1/campaigns/${CAMPAIGN_ID}/dice/roll`;
    const { client, transport } = newClient({ [roll]: { status: 200, body: { roll: { total: 12, terms: [] } } } });
    createSheetCommandDispatcher({ client, campaignId: CAMPAIGN_ID, actorId: ACTOR_ID })({
      cmd: "ROLL_DICE",
      expression: "1d20+3",
      visibility: "PUBLIC",
      reason: "Stealth",
    });
    await flush();
    assert.deepEqual(transport.calls[0].body, { expression: "1d20+3", visibility: "Public", reason: "Stealth" });
  });

  it("UPDATE_ACTOR_SHEET { path, value } saves the whole sheet with the stored version", async () => {
    const { client, transport } = newClient(
      { [`PUT ${ACTOR_URL}`]: { status: 200, body: { actor: actorDto({ version: 3 }) } } },
      { version: 2, data: sheet(2) },
    );
    createSheetCommandDispatcher({ client, campaignId: CAMPAIGN_ID, actorId: ACTOR_ID })({
      cmd: "UPDATE_ACTOR_SHEET",
      path: "sheet.attributes.hp.current",
      value: 4,
    });
    await flush();
    const body = transport.calls[0].body as Record<string, any>;
    assert.equal(body.expected_version, 2);
    assert.equal(body.data.attributes.hp.current, 4);
    assert.equal(body.data.attributes.hp.max, 10);
  });

  it("restDiceRollService returns the total and the kept dice", async () => {
    const roll = `POST /api/v1/campaigns/${CAMPAIGN_ID}/dice/roll`;
    const { client } = newClient({
      [roll]: { status: 200, body: { roll: { total: 9, expression: "1d10", terms: [{ kept_rolls: [9] }] } } },
    });
    assert.deepEqual(await restDiceRollService(client, CAMPAIGN_ID).roll("1d10"), { total: 9, rolls: [9], formula: "1d10" });
  });

  const paths = [
    { id: "strips the sheet. binding prefix", path: "sheet.attributes.level", expected: { attributes: { level: 4, hp: 1 } } },
    { id: "creates missing intermediate objects", path: "notes.private", expected: { attributes: { level: 1, hp: 1 }, notes: { private: 4 } } },
  ];
  for (const p of paths) {
    it(`setAtPath ${p.id}`, () => {
      assert.deepEqual(setAtPath({ attributes: { level: 1, hp: 1 } }, p.path, 4), p.expected);
    });
  }
});
