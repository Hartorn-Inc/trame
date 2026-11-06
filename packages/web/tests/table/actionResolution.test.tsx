import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { h } from "preact";
import {
  applyClassChoices,
  computeDnd5eSheetDerived,
  createDefaultActorData,
  getClassChoices,
  type DerivedFeatureRollRule,
  type Dnd5eActorData,
} from "../../../game-systems/dnd5e/src/index.ts";
import { localeSignal } from "../../src/i18n/index.ts";
import { ActionResolutionCard } from "../../src/table/ActionResolutionCard.tsx";
import {
  areaOriginSignal,
  areaTemplate,
  cancelAction,
  isReadyToApply,
  pendingActionSignal,
  pendingAreaTemplate,
  resolveTargets,
  ruleAttack,
  ruleSave,
  startAction,
  type AttackerContext,
  type DiceRoller,
  type ResolvableAction,
  type TargetContext,
  type TargetResolution,
} from "../../src/table/actionResolution.ts";
import { acceptedCoverSignal, targetTokenIdSignal } from "../../src/table/CoverSuggestionPanel.tsx";
import { TableCanvas } from "../../src/table/TableCanvas.tsx";
import { assertAbsent, assertPresent } from "../helpers/domAssert.ts";
import { CAMPAIGN, GM_ID, GOBLIN, HERO, HERO_ACTOR, PLAYER_ID, fullToken, liveTable, mount, publicToken, tableState } from "../helpers/liveTable.ts";
import { setupMockDom } from "../helpers/mockDom.ts";
import { flush } from "../helpers/mockTransport.ts";

setupMockDom();
localeSignal.value = "en";

/** Scripted server roller: answers each roll from `results` in order and records the expressions. */
function scripted(results: Array<{ total: number; natural?: number }>) {
  const calls: string[] = [];
  const roller: DiceRoller = async (expression) => {
    calls.push(expression);
    const next = results.shift();
    if (!next) throw new Error(`unexpected roll ${expression}`);
    return { total: next.total, natural: next.natural ?? null };
  };
  return { roller, calls };
}

function barbarianRolls(active: string[]): DerivedFeatureRollRule[] {
  const actor = createDefaultActorData("barbarian", "Brakka");
  actor.classId = "barbarian";
  actor.attributes.level = 2;
  actor.activeFeatureIds = active;
  return computeDnd5eSheetDerived(actor).featureRules?.rolls ?? [];
}

const longsword: ResolvableAction = {
  id: "longsword",
  name: "Longsword",
  attackBonus: 5,
  save: null,
  halfDamageOnSave: false,
  damageDice: "1d8",
  damageModifier: 3,
  damageType: "slashing",
  criticalRange: 20,
  source: "weapon_str",
  area: null,
  concentration: false,
};

const burningHands: ResolvableAction = {
  ...longsword,
  id: "srd:spell:burning_hands",
  name: "Burning Hands",
  attackBonus: null,
  save: { ability: "dex", dc: 13 },
  halfDamageOnSave: true,
  damageDice: "3d6",
  damageModifier: 0,
  damageType: "fire",
  source: "spell",
  area: { shape: "cone", sizeFt: 15 },
};

const attacker = (over: Partial<AttackerContext> = {}): AttackerContext => ({ tokenId: HERO, conditions: { conditions: [] }, featureRolls: [], ...over });

const target = (over: Partial<TargetContext> = {}): TargetContext => ({
  tokenId: GOBLIN,
  name: "Goblin",
  ac: 15,
  conditions: { conditions: [] },
  featureRolls: [],
  saveBonuses: { str: -1, dex: 2, con: 0, int: 0, wis: -1, cha: -1 },
  distanceFt: 5,
  cover: "NONE",
  ...over,
});

describe("resolveTargets: attack rolls", () => {
  const cases: Array<{
    id: string;
    action?: Partial<ResolvableAction>;
    attacker?: Partial<AttackerContext>;
    target?: Partial<TargetContext>;
    rolls: Array<{ total: number; natural?: number }>;
    outcome: string;
    damage: number;
    calls: string[];
  }> = [
    { id: "a total meeting AC hits and rolls damage", rolls: [{ total: 15, natural: 10 }, { total: 7 }], outcome: "hit", damage: 7, calls: ["1d20+5", "1d8+3"] },
    { id: "a total below AC misses without damage", rolls: [{ total: 14, natural: 9 }], outcome: "miss", damage: 0, calls: ["1d20+5"] },
    { id: "a natural 20 crits and doubles the dice only", rolls: [{ total: 25, natural: 20 }, { total: 12 }], outcome: "critical", damage: 12, calls: ["1d20+5", "2d8+3"] },
    { id: "Champion range 19 crits on a natural 19", action: { criticalRange: 19 }, rolls: [{ total: 24, natural: 19 }, { total: 11 }], outcome: "critical", damage: 11, calls: ["1d20+5", "2d8+3"] },
    { id: "a natural 19 is a plain hit without the Champion range", rolls: [{ total: 24, natural: 19 }, { total: 6 }], outcome: "hit", damage: 6, calls: ["1d20+5", "1d8+3"] },
    { id: "a natural 1 misses whatever the total", target: { ac: 5 }, rolls: [{ total: 6, natural: 1 }], outcome: "miss", damage: 0, calls: ["1d20+5"] },
    { id: "half cover adds 2 to AC", target: { cover: "HALF" }, rolls: [{ total: 16, natural: 11 }], outcome: "miss", damage: 0, calls: ["1d20+5"] },
    { id: "total cover blocks the attack without rolling", target: { cover: "TOTAL" }, rolls: [], outcome: "blocked", damage: 0, calls: [] },
    { id: "a hidden AC leaves the outcome to the user", target: { ac: null }, rolls: [{ total: 15, natural: 10 }], outcome: "unknown", damage: 0, calls: ["1d20+5"] },
    {
      id: "Reckless Attack gives advantage on Strength weapon attacks",
      attacker: { featureRolls: barbarianRolls(["barbarian:reckless_attack"]) },
      rolls: [{ total: 9, natural: 4 }],
      outcome: "miss",
      damage: 0,
      calls: ["2d20kh1+5"],
    },
    {
      id: "Reckless Attack advantage cancels against a prone target at range",
      attacker: { featureRolls: barbarianRolls(["barbarian:reckless_attack"]) },
      target: { conditions: { conditions: ["prone"] }, distanceFt: 30 },
      rolls: [{ total: 9, natural: 4 }],
      outcome: "miss",
      damage: 0,
      calls: ["1d20+5"],
    },
    {
      id: "a reckless target grants advantage to its attackers",
      target: { featureRolls: barbarianRolls(["barbarian:reckless_attack"]) },
      rolls: [{ total: 9, natural: 4 }],
      outcome: "miss",
      damage: 0,
      calls: ["2d20kh1+5"],
    },
    { id: "Reckless Attack does not help a spell attack", action: { source: "spell" }, attacker: { featureRolls: barbarianRolls(["barbarian:reckless_attack"]) }, rolls: [{ total: 9, natural: 4 }], outcome: "miss", damage: 0, calls: ["1d20+5"] },
  ];
  for (const c of cases) {
    it(c.id, async () => {
      const { roller, calls } = scripted([...c.rolls]);
      const [result] = await resolveTargets({ ...longsword, ...c.action }, attacker(c.attacker), [target(c.target)], roller);
      assert.equal(result.outcome, c.outcome);
      assert.equal(result.damage, c.damage);
      assert.deepEqual(calls, c.calls);
    });
  }
});

describe("resolveTargets: saving throws", () => {
  const cases: Array<{
    id: string;
    action?: Partial<ResolvableAction>;
    target?: Partial<TargetContext>;
    rolls: Array<{ total: number; natural?: number }>;
    outcome: string;
    damage: number;
    calls: string[];
  }> = [
    { id: "a failed save takes the full damage", rolls: [{ total: 10 }, { total: 9, natural: 7 }], outcome: "failure", damage: 10, calls: ["3d6", "1d20+2"] },
    { id: "a successful save halves the damage (rounded down)", rolls: [{ total: 11 }, { total: 14, natural: 12 }], outcome: "success", damage: 5, calls: ["3d6", "1d20+2"] },
    { id: "a successful save negates damage without save-for-half", action: { halfDamageOnSave: false }, rolls: [{ total: 11 }, { total: 14, natural: 12 }], outcome: "success", damage: 0, calls: ["3d6", "1d20+2"] },
    { id: "Danger Sense gives advantage on Dexterity saves", target: { featureRolls: barbarianRolls([]) }, rolls: [{ total: 10 }, { total: 9, natural: 7 }], outcome: "failure", damage: 10, calls: ["3d6", "2d20kh1+2"] },
    {
      id: "Danger Sense cancels the Restrained Dexterity save disadvantage",
      target: { featureRolls: barbarianRolls([]), conditions: { conditions: ["restrained"] } },
      rolls: [{ total: 10 }, { total: 9, natural: 7 }],
      outcome: "failure",
      damage: 10,
      calls: ["3d6", "1d20+2"],
    },
    { id: "half cover adds 2 to a Dexterity save", target: { cover: "HALF" }, rolls: [{ total: 10 }, { total: 13, natural: 9 }], outcome: "success", damage: 5, calls: ["3d6", "1d20+4"] },
    { id: "cover does not help a Constitution save", action: { save: { ability: "con", dc: 13 } }, target: { cover: "HALF" }, rolls: [{ total: 10 }, { total: 9, natural: 9 }], outcome: "failure", damage: 10, calls: ["3d6", "1d20"] },
    { id: "a paralyzed target fails a Dexterity save without rolling", target: { conditions: { conditions: ["paralyzed"] } }, rolls: [{ total: 10 }], outcome: "failure", damage: 10, calls: ["3d6"] },
    { id: "an unknown save bonus leaves the outcome to the user", target: { saveBonuses: null }, rolls: [{ total: 10 }], outcome: "unknown", damage: 10, calls: ["3d6"] },
    { id: "an area without a save hits for the full damage", action: { save: null }, rolls: [{ total: 10 }], outcome: "hit", damage: 10, calls: ["3d6"] },
  ];
  for (const c of cases) {
    it(c.id, async () => {
      const { roller, calls } = scripted([...c.rolls]);
      const [result] = await resolveTargets({ ...burningHands, ...c.action }, attacker(), [target(c.target)], roller);
      assert.equal(result.outcome, c.outcome);
      assert.equal(result.damage, c.damage);
      assert.deepEqual(calls, c.calls);
    });
  }

  it("the damage is rolled once for every target of an area", async () => {
    const { roller, calls } = scripted([{ total: 12 }, { total: 5, natural: 3 }, { total: 18, natural: 16 }]);
    const results = await resolveTargets(burningHands, attacker(), [target(), target({ tokenId: HERO, name: "Mira" })], roller);
    assert.deepEqual(results.map((r) => [r.outcome, r.damage]), [["failure", 12], ["success", 6]]);
    assert.deepEqual(calls, ["3d6", "1d20+2", "1d20+2"]);
  });
});

describe("user rulings and the Apply gate", () => {
  const unknown = (over: Partial<TargetResolution> = {}): TargetResolution => ({
    tokenId: GOBLIN,
    name: "Goblin",
    mode: "normal",
    advantageSources: [],
    disadvantageSources: [],
    expression: "1d20+5",
    natural: 10,
    total: 15,
    outcome: "unknown",
    critical: false,
    rolledDamage: null,
    damage: 0,
    ...over,
  });

  const attackRulings = [
    { id: "ruled hit rolls normal damage", outcome: "hit", calls: ["1d8+3"], damage: 6, critical: false },
    { id: "ruled critical hit doubles the dice", outcome: "critical", calls: ["2d8+3"], damage: 6, critical: true },
    { id: "ruled miss rolls nothing", outcome: "miss", calls: [], damage: 0, critical: false },
  ] as const;
  for (const c of attackRulings) {
    it(c.id, async () => {
      const { roller, calls } = scripted([{ total: 6 }]);
      const ruled = await ruleAttack(unknown(), c.outcome, longsword, roller);
      assert.equal(ruled.outcome, c.outcome);
      assert.equal(ruled.damage, c.damage);
      assert.equal(ruled.critical, c.critical);
      assert.deepEqual(calls, c.calls);
    });
  }

  const saveRulings = [
    { id: "ruled save success halves the rolled damage", outcome: "success", damage: 5 },
    { id: "ruled save failure keeps the rolled damage", outcome: "failure", damage: 11 },
  ] as const;
  for (const c of saveRulings) {
    it(c.id, () => {
      const ruled = ruleSave(unknown({ rolledDamage: 11, damage: 11 }), c.outcome, burningHands);
      assert.equal(ruled.damage, c.damage);
    });
  }

  const gates = [
    { id: "no result cannot be applied", results: [], ready: false },
    { id: "an unknown outcome blocks Apply", results: [unknown(), unknown({ outcome: "hit" })], ready: false },
    { id: "every outcome known allows Apply", results: [unknown({ outcome: "hit" }), unknown({ outcome: "miss" })], ready: true },
  ];
  for (const c of gates) {
    it(c.id, () => assert.equal(isReadyToApply(c.results), c.ready));
  }
});

describe("areaTemplate: spell areas as engine templates", () => {
  const caster = { center: { x: 75, y: 75 }, radiusFt: 2.5 };
  const point = { x: 75, y: 300 };
  const cases = [
    { id: "a sphere is centred on the placed point", area: { shape: "sphere", sizeFt: 20 }, caster, origin: { x: 75, y: 300 }, shape: { shape: "SPHERE", radius_ft: 20 } },
    { id: "a cube is centred on the placed point", area: { shape: "cube", sizeFt: 15 }, caster, origin: { x: 75, y: 300 }, shape: { shape: "CUBE", side_ft: 15, rotation_deg: 0 } },
    { id: "a line starts at the caster and aims at the point", area: { shape: "line", sizeFt: 60, widthFt: 5 }, caster, origin: { x: 75, y: 75 }, shape: { shape: "LINE", length_ft: 60, width_ft: 5, direction_deg: 90 } },
    { id: "a cone without a caster token starts at the point", area: { shape: "cone", sizeFt: 15 }, caster: null, origin: { x: 75, y: 300 }, shape: { shape: "CONE", length_ft: 15, direction_deg: 0 } },
    { id: "an emanation reaches past the caster footprint", area: { shape: "emanation", sizeFt: 10 }, caster, origin: { x: 75, y: 75 }, shape: { shape: "SPHERE", radius_ft: 12.5 } },
    { id: "a cylinder keeps its height", area: { shape: "cylinder", sizeFt: 10, heightFt: 40 }, caster, origin: { x: 75, y: 300 }, shape: { shape: "CYLINDER", radius_ft: 10, height_ft: 40 } },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const template = areaTemplate(c.area, point, c.caster, "tpl", null);
      assert.deepEqual(template.origin, c.origin);
      for (const [key, value] of Object.entries(c.shape)) assert.equal((template.shape as Record<string, unknown>)[key], value, key);
    });
  }

  it("a cone aimed at the point spans the SRD width (about 53 degrees)", () => {
    const template = areaTemplate({ shape: "cone", sizeFt: 15 }, point, caster, "tpl", null);
    const shape = template.shape as { angle_deg: number; direction_deg: number };
    assert.equal(shape.direction_deg, 90);
    assert.ok(Math.abs(shape.angle_deg - 53.13) < 0.01);
  });

  const pendingCases = [
    { id: "a concentration area binds the caster's token", spellId: "srd:spell:faerie_fire", caster: HERO, origin: { x: 500, y: 500 } },
    { id: "an instantaneous cone starts at the caster without concentration", spellId: "srd:spell:burning_hands", caster: null, origin: { x: 125, y: 75 } },
  ];
  for (const c of pendingCases) {
    it(c.id, () => {
      const state = tableState({ tokens: { [HERO]: fullToken(HERO, "Mira", { actor_id: HERO_ACTOR, top_left: { x: 100, y: 50 } }) } });
      startAction({ kind: "area", actorId: HERO_ACTOR, spellId: c.spellId });
      areaOriginSignal.value = { x: 500, y: 500 };
      const template = pendingAreaTemplate(state);
      assert.equal(template?.concentration_caster_id, c.caster);
      assert.deepEqual(template?.origin, c.origin);
      cancelAction();
    });
  }
});

/** Level-1 Wizard knowing Fire Bolt and Burning Hands (other picks: first options). */
function wizard(): Dnd5eActorData {
  const base = createDefaultActorData(HERO_ACTOR, "Mira");
  const choices = getClassChoices("wizard", { actor: base });
  const selections: Record<string, string[]> = Object.fromEntries(choices.map((c) => [c.id, c.options.slice(0, c.count).map((o) => o.id)]));
  const pick = (id: string, wanted: string) => {
    const choice = choices.find((c) => c.id === id)!;
    return [wanted, ...choice.options.map((o) => o.id).filter((o) => o !== wanted)].slice(0, choice.count);
  };
  selections.cantrips = pick("cantrips", "srd:spell:fire_bolt");
  selections.spells = pick("spells", "srd:spell:burning_hands");
  return applyClassChoices(base, "wizard", selections);
}

const GOBLIN_BLOCK = { name: "Goblin", abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 } };
const hero = () => fullToken(HERO, "Mira", { owner_user_id: PLAYER_ID, actor_id: HERO_ACTOR, top_left: { x: 100, y: 50 } });
const gmView = () => tableState({ tokens: { [HERO]: hero(), [GOBLIN]: fullToken(GOBLIN, "Goblin", { top_left: { x: 300, y: 300 }, ac: 13, stat_block: GOBLIN_BLOCK }) } });
const playerView = () => tableState({ tokens: { [HERO]: hero() }, public_tokens: { [GOBLIN]: publicToken(GOBLIN, "Goblin", { top_left: { x: 300, y: 300 } }) } });

function table(role: "GM" | "player", roller: DiceRoller) {
  const isGm = role === "GM";
  const live = liveTable(isGm ? GM_ID : PLAYER_ID, isGm ? gmView() : playerView());
  live.client.state.actors.value = { [HERO_ACTOR]: { version: 1, data: wizard() } as any };
  const ui = mount(
    h("div", null, h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm }), h(ActionResolutionCard, { campaignId: CAMPAIGN, client: live.client, isGm, roller })),
  );
  return { live, ui };
}

beforeEach(() => {
  cancelAction();
  targetTokenIdSignal.value = null;
  acceptedCoverSignal.value = null;
});

describe("ActionResolutionCard: attacks from the sheet", () => {
  it("GM targets by clicking the board, rolls, adjusts and applies typed damage", async () => {
    const { roller } = scripted([{ total: 17, natural: 12 }, { total: 6 }]);
    const { live, ui } = table("GM", roller);
    startAction({ kind: "attack", actorId: HERO_ACTOR, attackId: "srd:spell:fire_bolt" });
    ui.click(`token-${GOBLIN}`);
    assert.match(ui.byTestId(`token-${GOBLIN}`).getAttribute("aria-label"), /targeted/);
    assert.equal(ui.byTestId(`action-target-${GOBLIN}`).checked, true);
    ui.click("action-roll");
    await flush(6);
    assert.equal(ui.byTestId(`action-outcome-${GOBLIN}`).textContent, "Hit");
    assert.equal(ui.byTestId(`action-damage-${GOBLIN}`).value, "6");
    ui.input(`action-damage-${GOBLIN}`, "4");
    ui.click("action-apply");
    assert.deepEqual(live.commands(), [{ cmd: "APPLY_DAMAGE", token_id: GOBLIN, raw_damage: 4, affinity: "NORMAL", is_critical: false, damage_type: "fire" }]);
    assert.equal(pendingActionSignal.value, null);
    assertAbsent(ui.byTestId("action-card"), "action-card");
    ui.unmount();
  });

  it("player rules a hidden AC and leaves damage to an enemy to the GM", async () => {
    const { roller } = scripted([{ total: 17, natural: 12 }, { total: 6 }]);
    const { live, ui } = table("player", roller);
    startAction({ kind: "attack", actorId: HERO_ACTOR, attackId: "srd:spell:fire_bolt" });
    ui.input(`action-target-${GOBLIN}`, "on", "change");
    assert.match(ui.byTestId(`token-${GOBLIN}`).getAttribute("aria-label"), /targeted/);
    ui.click("action-roll");
    await flush(6);
    assert.equal(ui.byTestId(`action-outcome-${GOBLIN}`).textContent, "Unknown: rule it");
    assert.equal(ui.byTestId("action-apply").disabled, true);
    ui.click(`action-rule-${GOBLIN}-hit`);
    await flush(6);
    assert.equal(ui.byTestId(`action-outcome-${GOBLIN}`).textContent, "Hit");
    assert.equal(ui.byTestId(`action-damage-${GOBLIN}`).textContent, "6 damage");
    assert.match(ui.byTestId(`action-result-${GOBLIN}`).textContent, /Game Master applies/);
    assert.equal(ui.byTestId("action-apply").disabled, true);
    assert.deepEqual(live.commands(), []);
    ui.unmount();
  });
});

describe("ActionResolutionCard: area spells", () => {
  it("a board click places the area until it is projected", () => {
    const { ui } = table("player", scripted([]).roller);
    startAction({ kind: "area", actorId: HERO_ACTOR, spellId: "srd:spell:burning_hands" });
    ui.byTestId("table-board").getBoundingClientRect = () => ({ left: 10, top: 20 });
    ui.click("table-board", { clientX: 110, clientY: 220 });
    assert.deepEqual(areaOriginSignal.value, { x: 100, y: 200 });
    assert.equal(ui.byTestId("action-area-hint").textContent, "Area placed. Click again to move it, then project it.");
    ui.unmount();
  });

  it("GM projects Burning Hands, the engine lists the targets, the save halves the damage", async () => {
    const { roller, calls } = scripted([{ total: 10 }, { total: 15, natural: 13 }]);
    const { live, ui } = table("GM", roller);
    startAction({ kind: "area", actorId: HERO_ACTOR, spellId: "srd:spell:burning_hands" });
    ui.input("action-area-token", GOBLIN, "change");
    ui.click("action-area-project");
    const [projected] = live.commands();
    assert.equal(projected.cmd, "PROJECT_AOE");
    assert.equal(projected.persist_zone, false);
    assert.equal(projected.template.concentration_caster_id, null);
    assert.equal(projected.template.shape.shape, "CONE");
    assert.equal(ui.byTestId("action-area-hint").textContent, "Waiting for the table…");

    live.client.applyServerEnvelope({
      type: "CommandAccepted",
      seqId: 50,
      state: gmView(),
      events: [{ event: "AOE_PROJECTED", template: projected.template, affected_cells: [], affected_token_ids: [GOBLIN], persisted: false }],
    } as any);
    await flush(6);
    assert.deepEqual(calls, ["3d6", "1d20+2"]);
    assert.equal(ui.byTestId(`action-outcome-${GOBLIN}`).textContent, "Save succeeded");
    ui.click("action-apply");
    assert.deepEqual(live.commands()[1], { cmd: "APPLY_DAMAGE", token_id: GOBLIN, raw_damage: 5, affinity: "NORMAL", is_critical: false, damage_type: "fire" });
    ui.unmount();
  });

  it("an area that reaches nobody says so and Apply stays disabled", async () => {
    const { live, ui } = table("GM", scripted([{ total: 10 }]).roller);
    startAction({ kind: "area", actorId: HERO_ACTOR, spellId: "srd:spell:burning_hands" });
    ui.input("action-area-token", GOBLIN, "change");
    ui.click("action-area-project");
    const [projected] = live.commands();
    live.client.applyServerEnvelope({
      type: "CommandAccepted",
      seqId: 50,
      state: gmView(),
      events: [{ event: "AOE_PROJECTED", template: projected.template, affected_cells: [], affected_token_ids: [], persisted: false }],
    } as any);
    await flush(6);
    assertPresent(ui.byTestId("action-none-affected"), "action-none-affected");
    assert.equal(ui.byTestId("action-apply").disabled, true);
    ui.click("action-cancel");
    assertAbsent(ui.byTestId("action-card"), "action-card");
    ui.unmount();
  });
});
