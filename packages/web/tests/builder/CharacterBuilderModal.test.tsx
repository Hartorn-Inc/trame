import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h, options, render } from "preact";
import { ApiClient, type CampaignActor } from "../../src/api/client.ts";
import { createSessionState } from "../../src/api/session.ts";
import { CharacterBuilderModal } from "../../src/builder/CharacterBuilderModal.tsx";
import { localeSignal } from "../../src/i18n/index.ts";
import { setupMockDom } from "../helpers/mockDom.ts";
import { actorDto, createMockTransport, flush, type RouteReply } from "../helpers/mockTransport.ts";

setupMockDom();
localeSignal.value = "en";

const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const ACTORS = `POST /api/v1/campaigns/${CAMPAIGN_ID}/actors`;

async function mount(reply: RouteReply) {
  options.debounceRendering = (cb: () => void) => cb();
  const transport = createMockTransport({ [ACTORS]: reply });
  const state = createSessionState();
  const client = new ApiClient({ transport, state });
  const doc = (globalThis as any).document;
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const created: CampaignActor[] = [];
  let closed = 0;
  render(
    h(CharacterBuilderModal, {
      campaignId: CAMPAIGN_ID,
      client,
      onClose: () => {
        closed += 1;
      },
      onCreated: (a) => created.push(a),
    }),
    container,
  );
  await flush();
  const byTestId = (id: string): any => container.querySelector(`[data-testid="${id}"]`);
  const fire = async (id: string, type: string, value?: string) => {
    const el = byTestId(id);
    assert.ok(el, `missing ${id}`);
    if (value !== undefined) el.value = value;
    el.dispatchEvent(new (globalThis as any).Event(type));
    await flush();
  };
  return { transport, state, byTestId, fire, created, closedCount: () => closed, unmount: () => render(null, container) };
}

async function walkToReview(ui: Awaited<ReturnType<typeof mount>>) {
  await ui.fire("builder-species-dwarf", "change");
  await ui.fire("builder-next", "click");
  await ui.fire("builder-class-fighter", "change");
  await ui.fire("builder-next", "click");
  await ui.fire("builder-background-soldier", "change");
  await ui.fire("builder-split-plus2_plus1", "change");
  await ui.fire("builder-next", "click");
  await ui.fire("builder-method-standardArray", "change");
  await ui.fire("builder-next", "click");
  await ui.fire("builder-skills-acrobatics", "change");
  await ui.fire("builder-skills-perception", "change");
  await ui.fire("builder-next", "click");
  await ui.fire("builder-class-equipment-A", "change");
  await ui.fire("builder-equipment-package", "change");
  await ui.fire("builder-next", "click");
  await ui.fire("builder-next", "click");
  await ui.fire("builder-name", "input", "Brakka");
}

async function walkToSkills(ui: Awaited<ReturnType<typeof mount>>, classId: string) {
  await ui.fire("builder-species-dwarf", "change");
  await ui.fire("builder-next", "click");
  await ui.fire(`builder-class-${classId}`, "change");
  await ui.fire("builder-next", "click");
  await ui.fire("builder-background-soldier", "change");
  await ui.fire("builder-next", "click");
  await ui.fire("builder-method-standardArray", "change");
  await ui.fire("builder-next", "click");
}

describe("CharacterBuilderModal: creation through the actor route", () => {
  it("is an accessible dialog that starts on the species step", async () => {
    const ui = await mount({ status: 201, body: { actor: actorDto() } });
    const dialog = ui.byTestId("character-builder-modal");
    assert.equal(dialog.getAttribute("role"), "dialog");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.ok(dialog.getAttribute("aria-labelledby"));
    assert.ok(ui.byTestId("builder-step-species"));
    ui.unmount();
  });

  it("announces validation errors and stays on the step when Next is pressed too early", async () => {
    const ui = await mount({ status: 201, body: { actor: actorDto() } });
    await ui.fire("builder-next", "click");
    assert.ok(ui.byTestId("builder-step-species"));
    assert.equal(ui.byTestId("builder-errors").getAttribute("role"), "alert");
    assert.match(ui.byTestId("builder-errors").textContent, /Choose a species/);
    ui.unmount();
  });

  it("shows final scores with the background split applied on the ability step", async () => {
    const ui = await mount({ status: 201, body: { actor: actorDto() } });
    await ui.fire("builder-species-dwarf", "change");
    await ui.fire("builder-next", "click");
    await ui.fire("builder-class-fighter", "change");
    await ui.fire("builder-next", "click");
    await ui.fire("builder-background-soldier", "change");
    await ui.fire("builder-split-plus2_plus1", "change");
    await ui.fire("builder-next", "click");
    await ui.fire("builder-method-standardArray", "change");
    assert.equal(ui.byTestId("builder-final-str").textContent, "Final 17");
    assert.equal(ui.byTestId("builder-final-dex").textContent, "Final 15");
    ui.unmount();
  });

  it("caps class skill picks: unpicked boxes disable once the count is reached", async () => {
    const ui = await mount({ status: 201, body: { actor: actorDto() } });
    await walkToSkills(ui, "fighter");
    assert.ok(ui.byTestId("builder-step-skills"));
    assert.equal(ui.byTestId("builder-skills-athletics"), null, "the background's skill is not offered");
    await ui.fire("builder-skills-acrobatics", "change");
    assert.equal(ui.byTestId("builder-skills-count").textContent, "1 of 2 chosen");
    await ui.fire("builder-skills-perception", "change");
    assert.equal(ui.byTestId("builder-skills-history").disabled, true);
    assert.equal(ui.byTestId("builder-skills-acrobatics").disabled, false);
    ui.unmount();
  });

  const spellSteps = [
    { id: "a Wizard picks cantrips and level-1 spells", classId: "wizard", skills: ["insight", "medicine"], present: ["builder-cantrips-count", "builder-spells-count"], absent: ["builder-no-spells"] },
    { id: "a Fighter is told it has no spells", classId: "fighter", skills: ["acrobatics", "perception"], present: ["builder-no-spells"], absent: ["builder-cantrips-count"] },
  ];
  for (const c of spellSteps) {
    it(c.id, async () => {
      const ui = await mount({ status: 201, body: { actor: actorDto() } });
      await walkToSkills(ui, c.classId);
      for (const skill of c.skills) await ui.fire(`builder-skills-${skill}`, "change");
      await ui.fire("builder-next", "click");
      await ui.fire("builder-class-equipment-A", "change");
      await ui.fire("builder-equipment-package", "change");
      await ui.fire("builder-next", "click");
      assert.ok(ui.byTestId("builder-step-spells"));
      for (const id of c.present) assert.ok(ui.byTestId(id), id);
      for (const id of c.absent) assert.equal(ui.byTestId(id), null, id);
      ui.unmount();
    });
  }

  const outcomes: Array<{ id: string; reply: RouteReply; createdCount: number; closed: number; stillOpen: boolean }> = [
    { id: "201 stores the actor, notifies the caller, and closes", reply: { status: 201, body: { actor: actorDto({ name: "Brakka" }) } }, createdCount: 1, closed: 1, stillOpen: false },
    { id: "a server error keeps the dialog open on review with an alert", reply: { status: 500, body: { code: "STORAGE_ERROR", error: "db down" } }, createdCount: 0, closed: 0, stillOpen: true },
  ];

  for (const o of outcomes) {
    it(o.id, async () => {
      const ui = await mount(o.reply);
      await walkToReview(ui);
      await ui.fire("builder-create", "click");
      const call = ui.transport.calls.find((c) => c.method === "POST");
      assert.ok(call, "POST .../actors must be sent");
      const body = call.body as Record<string, any>;
      assert.equal(body.name, "Brakka");
      assert.equal(body.id, body.data.id, "the sheet id is reused as the actor id");
      assert.equal(body.data.abilities.str.score, 17);
      assert.equal(body.data.backgroundId, "srd:background:soldier");
      assert.equal(body.data.skills.perception.proficiencyRank, 1);
      assert.equal(body.data.derived.armorClass, 16, "Fighter option A equips Chain Mail");
      assert.equal(ui.created.length, o.createdCount);
      assert.equal(ui.closedCount(), o.closed);
      assert.equal(Boolean(ui.byTestId("builder-step-review")), o.stillOpen);
      ui.unmount();
    });
  }
});
