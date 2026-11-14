import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h, options, render } from "preact";
import { getSpellsByLevel } from "../../../game-systems/dnd5e/src/index.ts";
import { ApiClient, type CampaignActor } from "../../src/api/client.ts";
import { createSessionState } from "../../src/api/session.ts";
import { CharacterBuilderModal } from "../../src/builder/CharacterBuilderModal.tsx";
import { localeSignal, type LocaleCode } from "../../src/i18n/index.ts";
import { assertAbsent, assertPresent } from "../helpers/domAssert.ts";
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
  return { container, transport, state, byTestId, fire, created, closedCount: () => closed, unmount: () => render(null, container) };
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
  await ui.fire(`builder-class-fighting_style-${FIGHTING_STYLE}`, "change");
  await ui.fire("builder-next", "click");
  await ui.fire("builder-class-equipment-A", "change");
  await ui.fire("builder-equipment-package", "change");
  await ui.fire("builder-next", "click");
  await ui.fire("builder-next", "click");
  await ui.fire("builder-name", "input", "Brakka");
}

const FIGHTING_STYLE = "srd:feat:defense";

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
    assertAbsent(ui.byTestId("builder-skills-athletics"), "the background's skill is not offered");
    await ui.fire("builder-skills-acrobatics", "change");
    assert.equal(ui.byTestId("builder-skills-count").textContent, "1 of 2 chosen");
    await ui.fire("builder-skills-perception", "change");
    assert.equal(ui.byTestId("builder-skills-history").disabled, true);
    assert.equal(ui.byTestId("builder-skills-acrobatics").disabled, false);
    ui.unmount();
  });

  const fightingStyleSteps = [
    { id: "a Fighter cannot leave the skills step without a Fighting Style feat", pick: false, step: "builder-step-skills", error: /Choose a Fighting Style feat/ },
    { id: "a Fighter with a Fighting Style feat moves on to equipment", pick: true, step: "builder-step-equipment", error: null },
  ];
  for (const c of fightingStyleSteps) {
    it(c.id, async () => {
      const ui = await mount({ status: 201, body: { actor: actorDto() } });
      await walkToSkills(ui, "fighter");
      await ui.fire("builder-skills-acrobatics", "change");
      await ui.fire("builder-skills-perception", "change");
      assert.ok(ui.byTestId(`builder-class-fighting_style-${FIGHTING_STYLE}`), "the Fighting Style feats are offered as radios");
      if (c.pick) await ui.fire(`builder-class-fighting_style-${FIGHTING_STYLE}`, "change");
      await ui.fire("builder-next", "click");
      assert.ok(ui.byTestId(c.step), c.step);
      if (c.error) assert.match(ui.byTestId("builder-errors").textContent, c.error);
      ui.unmount();
    });
  }

  const spellSteps = [
    { id: "a Wizard picks cantrips and level-1 spells", classId: "wizard", skills: ["insight", "medicine"], present: ["builder-cantrips-count", "builder-spells-count"], absent: ["builder-no-spells"] },
    { id: "a Fighter is told it has no spells", classId: "fighter", skills: ["acrobatics", "perception"], present: ["builder-no-spells"], absent: ["builder-cantrips-count"] },
  ];
  for (const c of spellSteps) {
    it(c.id, async () => {
      const ui = await mount({ status: 201, body: { actor: actorDto() } });
      await walkToSkills(ui, c.classId);
      for (const skill of c.skills) await ui.fire(`builder-skills-${skill}`, "change");
      if (c.classId === "fighter") await ui.fire(`builder-class-fighting_style-${FIGHTING_STYLE}`, "change");
      await ui.fire("builder-next", "click");
      await ui.fire("builder-class-equipment-A", "change");
      await ui.fire("builder-equipment-package", "change");
      await ui.fire("builder-next", "click");
      assert.ok(ui.byTestId("builder-step-spells"));
      for (const id of c.present) assert.ok(ui.byTestId(id), id);
      for (const id of c.absent) assertAbsent(ui.byTestId(id), id);
      ui.unmount();
    });
  }

  const spellDescriptions = [
    { id: "a cantrip option shows its SRD rules text", choice: "cantrips", spell: "srd:spell:fire_bolt", text: /mote of fire/ },
    { id: "a level-1 spell option shows its SRD rules text", choice: "spells", spell: "srd:spell:burning_hands", text: /thin sheet of flames/ },
  ];
  for (const c of spellDescriptions) {
    it(c.id, async () => {
      const ui = await mount({ status: 201, body: { actor: actorDto() } });
      await walkToSkills(ui, "wizard");
      for (const skill of ["insight", "medicine"]) await ui.fire(`builder-skills-${skill}`, "change");
      await ui.fire("builder-next", "click");
      await ui.fire("builder-class-equipment-A", "change");
      await ui.fire("builder-equipment-package", "change");
      await ui.fire("builder-next", "click");
      const descriptionId = `builder-${c.choice}-${c.spell}-description`;
      const description = ui.byTestId(descriptionId);
      assertPresent(description, descriptionId);
      assert.match(description.textContent, c.text);
      assert.equal(description.getAttribute("lang"), "en");
      assert.equal(ui.byTestId(`builder-${c.choice}-${c.spell}`).getAttribute("aria-describedby"), descriptionId);
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
      assert.ok(body.data.features.includes(FIGHTING_STYLE), "the Fighting Style feat is recorded");
      assert.equal(body.data.derived.armorClass, 17, "Fighter option A equips Chain Mail (16) and Defense adds 1");
      assert.equal(ui.created.length, o.createdCount);
      assert.equal(ui.closedCount(), o.closed);
      assert.equal(Boolean(ui.byTestId("builder-step-review")), o.stillOpen);
      ui.unmount();
    });
  }
});

describe("CharacterBuilderModal: Origin feat choices on background step (G1)", () => {
  const clericCantrips = getSpellsByLevel(0, "cleric").map((s) => s.id);
  const [clericSpell1] = getSpellsByLevel(1, "cleric").map((s) => s.id);

  const originFeatCases: Array<{
    id: string;
    backgroundId: string;
    setupPicks: (ui: Awaited<ReturnType<typeof mount>>) => Promise<void>;
    verifyCreated: (data: Record<string, any>) => void;
  }> = [
    {
      id: "[G1-modal-acolyte-magic-initiate] Acolyte gates on Magic Initiate choices and submits Cleric featSpells",
      backgroundId: "acolyte",
      setupPicks: async (ui) => {
        const listRadio = ui.byTestId("builder-feat-spell_list-cleric");
        assertPresent(listRadio, "Cleric spell list radio is rendered");
        assert.equal(listRadio.checked, true, "Fixed Cleric spell list is pre-selected");
        await ui.fire("builder-feat-spellcasting_ability-wis", "change");
        await ui.fire(`builder-feat-cantrips-${clericCantrips[0]}`, "change");
        await ui.fire(`builder-feat-cantrips-${clericCantrips[1]}`, "change");
        assert.equal(ui.byTestId("builder-feat-cantrips-count").textContent, "2 of 2 chosen");
        if (clericCantrips[2]) {
          assert.equal(ui.byTestId(`builder-feat-cantrips-${clericCantrips[2]}`).disabled, true, "unpicked cantrips disable at cap");
        }
        await ui.fire(`builder-feat-level_1_spell-${clericSpell1}`, "change");
      },
      verifyCreated: (data) => {
        assert.equal(data.featChoices?.length, 1);
        assert.equal(data.featChoices[0].featId, "srd:feat:magic_initiate");
        assert.deepEqual(data.featChoices[0].selections.spellcasting_ability, ["wis"]);
        assert.equal(data.derived.spells.featSpells[0].ability, "wis");
        assert.equal(data.derived.spells.featSpells[0].spells.length, 3);
      },
    },
    {
      id: "[G1-modal-caravan-guide-skilled] Caravan Guide gates on 3 Skilled picks and submits skill and tool proficiencies",
      backgroundId: "caravan_guide",
      setupPicks: async (ui) => {
        assertAbsent(ui.byTestId("builder-feat-proficiencies-survival"), "background skill is excluded from Skilled");
        await ui.fire("builder-feat-proficiencies-stealth", "change");
        await ui.fire("builder-feat-proficiencies-arcana", "change");
        await ui.fire("builder-feat-proficiencies-tool:Thieves' Tools", "change");
        assert.equal(ui.byTestId("builder-feat-proficiencies-count").textContent, "3 of 3 chosen");
      },
      verifyCreated: (data) => {
        assert.equal(data.featChoices?.length, 1);
        assert.equal(data.featChoices[0].featId, "srd:feat:skilled");
        assert.equal(data.skills.stealth.proficiencyRank, 1);
        assert.equal(data.skills.arcana.proficiencyRank, 1);
        assert.ok(data.proficiencies.tools.includes("Thieves' Tools"));
      },
    },
    {
      id: "[ADR-0038-modal-artisan-skilled] Artisan gates on 3 Skilled picks and excludes Smith's Tools and investigation",
      backgroundId: "artisan",
      setupPicks: async (ui) => {
        assertAbsent(ui.byTestId("builder-feat-proficiencies-investigation"), "Artisan skill is excluded from Skilled");
        assertAbsent(ui.byTestId("builder-feat-proficiencies-tool:Smith's Tools"), "Artisan tool is excluded from Skilled");
        await ui.fire("builder-feat-proficiencies-stealth", "change");
        await ui.fire("builder-feat-proficiencies-arcana", "change");
        await ui.fire("builder-feat-proficiencies-tool:Brewer's Supplies", "change");
        assert.equal(ui.byTestId("builder-feat-proficiencies-count").textContent, "3 of 3 chosen");
      },
      verifyCreated: (data) => {
        assert.equal(data.backgroundId, "srd:background:artisan");
        assert.equal(data.skills.investigation.proficiencyRank, 1);
        assert.equal(data.skills.persuasion.proficiencyRank, 1);
        assert.equal(data.skills.stealth.proficiencyRank, 1);
        assert.ok(data.proficiencies.tools.includes("Smith's Tools"));
        assert.ok(data.proficiencies.tools.includes("Brewer's Supplies"));
      },
    },
    {
      id: "[ADR-0038-modal-merchant-skilled] Merchant gates on 3 Skilled picks and excludes Navigator's Tools and persuasion",
      backgroundId: "merchant",
      setupPicks: async (ui) => {
        assertAbsent(ui.byTestId("builder-feat-proficiencies-persuasion"), "Merchant skill is excluded from Skilled");
        assertAbsent(ui.byTestId("builder-feat-proficiencies-tool:Navigator's Tools"), "Merchant tool is excluded from Skilled");
        await ui.fire("builder-feat-proficiencies-stealth", "change");
        await ui.fire("builder-feat-proficiencies-arcana", "change");
        await ui.fire("builder-feat-proficiencies-tool:Cartographer's Tools", "change");
        assert.equal(ui.byTestId("builder-feat-proficiencies-count").textContent, "3 of 3 chosen");
      },
      verifyCreated: (data) => {
        assert.equal(data.backgroundId, "srd:background:merchant");
        assert.equal(data.skills.persuasion.proficiencyRank, 1);
        assert.equal(data.skills.insight.proficiencyRank, 1);
        assert.ok(data.proficiencies.tools.includes("Navigator's Tools"));
        assert.ok(data.proficiencies.tools.includes("Cartographer's Tools"));
      },
    },
  ];

  for (const c of originFeatCases) {
    it(c.id, async () => {
      localeSignal.value = "en";
      const ui = await mount({ status: 201, body: { actor: actorDto({ name: "OriginHero" }) } });
      await ui.fire("builder-species-dwarf", "change");
      await ui.fire("builder-next", "click");
      await ui.fire("builder-class-fighter", "change");
      await ui.fire("builder-next", "click");
      await ui.fire(`builder-background-${c.backgroundId}`, "change");
      await ui.fire("builder-next", "click");
      assert.ok(ui.byTestId("builder-step-background"), "incomplete Origin feat choices block advancing");
      assert.match(ui.byTestId("builder-errors").textContent, /Complete your origin feat choices/);
      await c.setupPicks(ui);
      await ui.fire("builder-next", "click");
      assert.ok(ui.byTestId("builder-step-abilityScores"), "valid Origin feat choices advance to abilityScores");
      await ui.fire("builder-method-standardArray", "change");
      await ui.fire("builder-next", "click");
      await ui.fire("builder-skills-acrobatics", "change");
      await ui.fire("builder-skills-perception", "change");
      await ui.fire(`builder-class-fighting_style-${FIGHTING_STYLE}`, "change");
      await ui.fire("builder-next", "click");
      await ui.fire("builder-class-equipment-A", "change");
      await ui.fire("builder-equipment-package", "change");
      await ui.fire("builder-next", "click");
      await ui.fire("builder-next", "click");
      await ui.fire("builder-name", "input", "OriginHero");
      await ui.fire("builder-create", "click");
      const post = ui.transport.calls.find((call) => call.method === "POST");
      assert.ok(post);
      c.verifyCreated((post.body as Record<string, any>).data);
      ui.unmount();
    });
  }
});

describe("CharacterBuilderModal: Point-Buy label semantics and tabular numerals (F6)", () => {
  function assertZeroOrphanedLabels(container: any) {
    const labels = container.querySelectorAll("label");
    for (const label of labels) {
      const targetId = label.getAttribute("for");
      if (targetId !== null) {
        const target = container.querySelector(`#${targetId}`);
        assertPresent(target, `<label for="${targetId}"> must resolve to a control with id="${targetId}"`);
        assert.equal(target.hasAttribute("aria-label"), false, `control #${targetId} must not override its <label> with aria-label`);
      }
    }
  }

  const localeCases: Array<{
    id: string;
    locale: LocaleCode;
    strLabel: string;
    decStrAria: string;
    incStrAria: string;
  }> = [
    {
      id: "[F6-pointbuy-en-labels-and-groups] English Point-Buy exposes role=group + aria-labelledby + localized button names with zero orphaned labels",
      locale: "en",
      strLabel: "Strength (STR)",
      decStrAria: "Decrease Strength (STR)",
      incStrAria: "Increase Strength (STR)",
    },
    {
      id: "[F6-pointbuy-fr-labels-and-groups] French Point-Buy exposes role=group + aria-labelledby + localized button names with zero orphaned labels",
      locale: "fr",
      strLabel: "Force (FOR)",
      decStrAria: "Diminuer Force (FOR)",
      incStrAria: "Augmenter Force (FOR)",
    },
  ];

  for (const c of localeCases) {
    it(c.id, async () => {
      localeSignal.value = c.locale;
      const ui = await mount({ status: 201, body: { actor: actorDto() } });
      await ui.fire("builder-species-dwarf", "change");
      await ui.fire("builder-next", "click");
      await ui.fire("builder-class-fighter", "change");
      await ui.fire("builder-next", "click");
      await ui.fire("builder-background-soldier", "change");
      await ui.fire("builder-next", "click");
      assert.ok(ui.byTestId("builder-step-abilityScores"));

      assertZeroOrphanedLabels(ui.container);
      const stepper = ui.byTestId("builder-stepper-str");
      assertPresent(stepper, "Point-Buy stepper group");
      assert.equal(stepper.getAttribute("role"), "group");
      const labelId = stepper.getAttribute("aria-labelledby");
      assert.equal(labelId, "builder-ability-label-str");
      const labelSpan = ui.container.querySelector(`#${labelId}`);
      assertPresent(labelSpan, "ability label element referenced by aria-labelledby");
      assert.equal(labelSpan.textContent, c.strLabel);
      assert.equal(ui.byTestId("builder-dec-str").getAttribute("aria-label"), c.decStrAria);
      assert.equal(ui.byTestId("builder-inc-str").getAttribute("aria-label"), c.incStrAria);

      assert.equal(ui.byTestId("builder-point-buy-remaining").classList.contains("atlas-tabular-nums"), true);
      assert.equal(ui.byTestId("builder-base-str").classList.contains("atlas-tabular-nums"), true);
      assert.equal(ui.byTestId("builder-final-str").classList.contains("atlas-tabular-nums"), true);
      assert.equal(ui.byTestId("builder-mod-str").classList.contains("atlas-tabular-nums"), true);

      await ui.fire("builder-inc-str", "click");
      assert.equal(ui.byTestId("builder-base-str").textContent, "9");
      assert.equal(ui.byTestId("builder-mod-str").textContent, "(+0)");

      ui.unmount();
      localeSignal.value = "en";
    });
  }

  it("[F6-standard-array-labels-and-tabular-nums] Standard Array associates <label for> with <select id> and keeps .atlas-tabular-nums", async () => {
    localeSignal.value = "en";
    const ui = await mount({ status: 201, body: { actor: actorDto() } });
    await ui.fire("builder-species-dwarf", "change");
    await ui.fire("builder-next", "click");
    await ui.fire("builder-class-fighter", "change");
    await ui.fire("builder-next", "click");
    await ui.fire("builder-background-soldier", "change");
    await ui.fire("builder-next", "click");
    await ui.fire("builder-method-standardArray", "change");

    assertZeroOrphanedLabels(ui.container);
    const select = ui.byTestId("builder-score-str");
    assertPresent(select, "Standard Array select");
    assert.equal(select.id, "builder-score-str");
    assert.equal(select.classList.contains("atlas-tabular-nums"), true);
    const label = ui.container.querySelector('label[for="builder-score-str"]');
    assertPresent(label, "label associated with builder-score-str");
    assert.equal(ui.byTestId("builder-final-str").classList.contains("atlas-tabular-nums"), true);
    assert.equal(ui.byTestId("builder-mod-str").classList.contains("atlas-tabular-nums"), true);
    assert.equal(ui.byTestId("builder-mod-str").textContent, "(+3)");
    ui.unmount();
  });

  const trameOriginLocaleCases: Array<{
    id: string;
    locale: LocaleCode;
    speciesId: string;
    speciesLabel: string;
    backgroundId: string;
    backgroundLabel: string;
  }> = [
    {
      id: "[ADR-0038-en-half-elf-house-guardian] renders Half-Elf and House Guardian in English",
      locale: "en",
      speciesId: "half_elf",
      speciesLabel: "Half-Elf",
      backgroundId: "house_guardian",
      backgroundLabel: "House Guardian",
    },
    {
      id: "[ADR-0038-fr-radiant-scion-merchant] renders Radiant Scion and Merchant in French",
      locale: "fr",
      speciesId: "radiant_scion",
      speciesLabel: "Héritier radieux",
      backgroundId: "merchant",
      backgroundLabel: "Marchand",
    },
  ];

  for (const c of trameOriginLocaleCases) {
    it(c.id, async () => {
      localeSignal.value = c.locale;
      const ui = await mount({ status: 201, body: { actor: actorDto() } });
      const speciesInput = ui.byTestId(`builder-species-${c.speciesId}`);
      assertPresent(speciesInput, `species radio ${c.speciesId}`);
      assert.ok(speciesInput.closest("label")?.textContent.includes(c.speciesLabel));
      await ui.fire(`builder-species-${c.speciesId}`, "change");
      await ui.fire("builder-next", "click");
      await ui.fire("builder-class-paladin", "change");
      await ui.fire("builder-next", "click");
      const bgInput = ui.byTestId(`builder-background-${c.backgroundId}`);
      assertPresent(bgInput, `background radio ${c.backgroundId}`);
      assert.ok(bgInput.closest("label")?.textContent.includes(c.backgroundLabel));
      ui.unmount();
      localeSignal.value = "en";
    });
  }
});
