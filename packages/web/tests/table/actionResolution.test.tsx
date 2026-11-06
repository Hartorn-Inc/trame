import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { h } from "preact";
import {
  applyClassChoices,
  CompendiumResolver,
  computeDnd5eSheetDerived,
  createDefaultActorData,
  getClassChoices,
  type DerivedFeatureRollRule,
  type Dnd5eActorData,
  type MonsterAction,
  type MonsterStatBlock,
} from "../../../game-systems/dnd5e/src/index.ts";
import { selectedTokenIdSignal } from "../../src/api/session.ts";
import type { ProjectedTableState, WirePendingResolution, WireResolvedTarget } from "../../src/api/wire.ts";
import { monsterStatBlockOf, type CompendiumEntry } from "../../src/compendium/CompendiumDrawer.tsx";
import { localeSignal } from "../../src/i18n/index.ts";
import { ActionResolutionCard } from "../../src/table/ActionResolutionCard.tsx";
import {
  areaOriginSignal,
  areaTemplate,
  buildActionRequest,
  cancelAction,
  footprintDistanceFt,
  pendingActionSignal,
  pendingAreaTemplate,
  resolvableFromMonsterAction,
  splitDamage,
  startAction,
  type AttackerContext,
  type ResolvableAction,
  type TargetContext,
} from "../../src/table/actionResolution.ts";
import { ConcentrationCheckPrompt } from "../../src/table/ConcentrationCheckPrompt.tsx";
import { acceptedCoverSignal, targetTokenIdSignal } from "../../src/table/CoverSuggestionPanel.tsx";
import { MonsterTurnPanel } from "../../src/table/MonsterTurnPanel.tsx";
import { PendingResolutionsPanel } from "../../src/table/PendingResolutionsPanel.tsx";
import { TableCanvas } from "../../src/table/TableCanvas.tsx";
import type { TableToken } from "../../src/table/tableView.ts";
import { assertAbsent, assertPresent } from "../helpers/domAssert.ts";
import { CAMPAIGN, GM_ID, GOBLIN, HERO, HERO_ACTOR, PLAYER_ID, fullToken, liveTable, mount, publicToken, tableState, type LiveTable } from "../helpers/liveTable.ts";
import { setupMockDom } from "../helpers/mockDom.ts";
import { flush } from "../helpers/mockTransport.ts";

setupMockDom();
localeSignal.value = "en";

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
  conditions: { conditions: [] },
  featureRolls: [],
  distanceFt: 5,
  cover: "NONE",
  ...over,
});

describe("buildActionRequest: what the client sends the server", () => {
  const cases: Array<{
    id: string;
    action: ResolvableAction;
    attacker?: Partial<AttackerContext>;
    target?: Partial<TargetContext>;
    check: Record<string, unknown>;
    rollMode: string;
    cover?: string;
  }> = [
    { id: "an attack sends the sheet bonus and crit range, never a target AC", action: longsword, check: { kind: "ATTACK", attack_bonus: 5, critical_range: 20 }, rollMode: "NORMAL" },
    { id: "Champion crit range travels with the attack", action: { ...longsword, criticalRange: 19 }, check: { kind: "ATTACK", attack_bonus: 5, critical_range: 19 }, rollMode: "NORMAL" },
    { id: "Reckless Attack sends advantage on a Strength weapon attack", action: longsword, attacker: { featureRolls: barbarianRolls(["barbarian:reckless_attack"]) }, check: { kind: "ATTACK", attack_bonus: 5, critical_range: 20 }, rollMode: "ADVANTAGE" },
    { id: "a prone target within 5 ft gives advantage", action: longsword, target: { conditions: { conditions: ["prone"] }, distanceFt: 5 }, check: { kind: "ATTACK", attack_bonus: 5, critical_range: 20 }, rollMode: "ADVANTAGE" },
    { id: "a prone target beyond 5 ft gives disadvantage", action: longsword, target: { conditions: { conditions: ["prone"] }, distanceFt: 30 }, check: { kind: "ATTACK", attack_bonus: 5, critical_range: 20 }, rollMode: "DISADVANTAGE" },
    { id: "a prone target at an unknown distance changes nothing", action: longsword, target: { conditions: { conditions: ["prone"] }, distanceFt: null }, check: { kind: "ATTACK", attack_bonus: 5, critical_range: 20 }, rollMode: "NORMAL" },
    { id: "the accepted cover is sent for the server to add", action: longsword, target: { cover: "HALF" }, check: { kind: "ATTACK", attack_bonus: 5, critical_range: 20 }, rollMode: "NORMAL", cover: "HALF" },
    { id: "a save sends the DC and save-for-half, never a save bonus", action: burningHands, check: { kind: "SAVE", ability: "dex", dc: 13, half_on_success: true }, rollMode: "NORMAL" },
    { id: "Danger Sense sends advantage on a Dexterity save", action: burningHands, target: { featureRolls: barbarianRolls([]) }, check: { kind: "SAVE", ability: "dex", dc: 13, half_on_success: true }, rollMode: "ADVANTAGE" },
    { id: "an action without attack or save hits automatically", action: { ...burningHands, save: null }, check: { kind: "AUTOMATIC" }, rollMode: "NORMAL" },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const request = buildActionRequest(c.action, attacker(c.attacker), [target(c.target)], "res-1");
      assert.deepEqual(request.check, c.check);
      assert.deepEqual(request.targets, [{ token_id: GOBLIN, roll_mode: c.rollMode, cover: c.cover ?? "NONE" }]);
      assert.equal(request.resolution_id, "res-1");
      assert.equal(request.attacker_token_id, HERO);
    });
  }

  it("flat damage terms move into the modifier", () => {
    const request = buildActionRequest({ ...longsword, damageDice: "2d6+1d8-1" }, attacker(), [target()], "res-1");
    assert.equal(request.damage_dice, "2d6+1d8");
    assert.equal(request.damage_modifier, 2);
  });
});

describe("splitDamage", () => {
  const cases = [
    { id: "dice plus a flat bonus", expression: "1d10 + 8", dice: "1d10", modifier: 8 },
    { id: "several dice terms and a penalty", expression: "2d6+1d8-1", dice: "2d6+1d8", modifier: -1 },
    { id: "a flat number only", expression: "1", dice: "", modifier: 1 },
    { id: "a bare d6 gets an explicit count", expression: "d6", dice: "1d6", modifier: 0 },
  ];
  for (const c of cases) {
    it(c.id, () => assert.deepEqual(splitDamage(c.expression), { dice: c.dice, modifier: c.modifier }));
  }
});

describe("footprintDistanceFt: 3D distance between tokens", () => {
  const token = (x: number, y: number, elevationFt = 0, size = 1) =>
    ({ topLeft: { x, y }, gridW: size, gridH: size, elevationFt }) as TableToken;
  const cases = [
    { id: "adjacent tokens are 5 ft apart", a: token(0, 0), b: token(50, 0), feet: 5 },
    { id: "one empty cell between tokens is 10 ft", a: token(0, 0), b: token(100, 0), feet: 10 },
    { id: "an adjacent flyer 30 ft up is 30 ft away", a: token(0, 0), b: token(50, 0, 30), feet: 30 },
    { id: "an adjacent token 5 ft up stays within 5 ft", a: token(0, 0), b: token(50, 0, 5), feet: 5 },
    { id: "a large token touching a small one is 5 ft away", a: token(0, 0, 0, 2), b: token(100, 50), feet: 5 },
  ];
  for (const c of cases) {
    it(c.id, () => assert.equal(footprintDistanceFt(c.a, c.b, 50, 5), c.feet));
  }
});

describe("resolvableFromMonsterAction", () => {
  const base: MonsterAction = { id: "a", name: "A", description: "", automation: "full" };
  const cases: Array<{ id: string; action: MonsterAction; expect: Partial<ResolvableAction> | null }> = [
    {
      id: "a melee attack keeps its to-hit and splits the damage",
      action: { ...base, attack: { kind: "melee", toHit: 4 }, damage: [{ dice: "1d6 + 2", average: 5, type: "slashing" }] },
      expect: { attackBonus: 4, save: null, damageDice: "1d6", damageModifier: 2, damageType: "slashing", source: "weapon_str" },
    },
    {
      id: "a ranged attack counts as a Dexterity weapon",
      action: { ...base, attack: { kind: "ranged", toHit: 4 }, damage: [{ dice: "1d6 + 2", average: 5, type: "piercing" }] },
      expect: { source: "weapon_dex" },
    },
    {
      id: "a breath weapon is a save with half damage",
      action: { ...base, save: { ability: "dex", dc: 13, onSuccess: "half" }, damage: [{ dice: "7d6", average: 24, type: "fire" }] },
      expect: { attackBonus: null, save: { ability: "dex", dc: 13 }, halfDamageOnSave: true, damageDice: "7d6", damageModifier: 0 },
    },
    {
      id: "an attack with a rider save keeps the attack and describes the save",
      action: { ...base, attack: { kind: "melee", toHit: 5 }, save: { ability: "con", dc: 11, onSuccess: "none" }, damage: [{ dice: "1d8 + 3", average: 7, type: "piercing" }] },
      expect: { attackBonus: 5, save: null, secondarySave: { ability: "con", dc: 11 } },
    },
    {
      id: "a second damage type is left to the text",
      action: { ...base, attack: { kind: "melee", toHit: 5 }, damage: [{ dice: "1d8 + 3", average: 7, type: "piercing" }, { dice: "2d6", average: 7, type: "poison" }] },
      expect: { damageDice: "1d8", damageModifier: 3, damageType: "piercing", otherDamageTypes: ["poison"] },
    },
    { id: "a prose-only action (Multiattack) cannot be resolved", action: { ...base, automation: "text" }, expect: null },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const resolvable = resolvableFromMonsterAction(c.action);
      if (c.expect === null) {
        assert.equal(resolvable, null);
        return;
      }
      for (const [key, value] of Object.entries(c.expect)) assert.deepEqual((resolvable as unknown as Record<string, unknown>)[key], value, key);
    });
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

const GOBLIN_BLOCK = monsterStatBlockOf(CompendiumResolver.getDefault().get("srd:monster:goblin") as CompendiumEntry) as MonsterStatBlock;
const GOBLIN_ATTACK = GOBLIN_BLOCK.actions.find((a) => a.attack)!;
const hero = () => fullToken(HERO, "Mira", { owner_user_id: PLAYER_ID, actor_id: HERO_ACTOR, top_left: { x: 100, y: 50 } });
const gmView = (over: Partial<ProjectedTableState> = {}) =>
  tableState({ tokens: { [HERO]: hero(), [GOBLIN]: fullToken(GOBLIN, "Goblin", { top_left: { x: 300, y: 300 }, ac: 15, stat_block: GOBLIN_BLOCK as unknown as Record<string, unknown> }) }, ...over });
const playerView = (over: Partial<ProjectedTableState> = {}) =>
  tableState({ tokens: { [HERO]: hero() }, public_tokens: { [GOBLIN]: publicToken(GOBLIN, "Goblin", { top_left: { x: 300, y: 300 } }) }, ...over });

const resolvedTarget = (over: Partial<WireResolvedTarget> = {}): WireResolvedTarget => ({
  token_id: GOBLIN,
  roll_mode: "NORMAL",
  outcome: "HIT",
  d20_rolls: [],
  total: null,
  damage: 7,
  is_critical: false,
  applied: false,
  ...over,
});

const pendingResolution = (id: string, targets: WireResolvedTarget[], over: Partial<WirePendingResolution> = {}): WirePendingResolution => ({
  id,
  issuer_user_id: PLAYER_ID,
  attacker_token_id: HERO,
  action_name: "Fire Bolt",
  check: { kind: "ATTACK", attack_bonus: 5, critical_range: 20 },
  damage_type: "fire",
  damage_expression: "1d10",
  targets,
  sequence: 1,
  ...over,
});

let seq = 50;
/** Answers the last `RESOLVE_ACTION` as the room would: the projected entry and its `ACTION_RESOLVED` event. */
function answer(live: LiveTable, view: (over: Partial<ProjectedTableState>) => ProjectedTableState, targets: WireResolvedTarget[]) {
  const request = live.commands().filter((c) => c.cmd === "RESOLVE_ACTION").at(-1)!.request;
  const resolution = pendingResolution(request.resolution_id, targets);
  live.client.applyServerEnvelope({
    type: "CommandAccepted",
    seqId: seq++,
    state: view({ pending_resolutions: { [resolution.id]: resolution } }),
    events: [{ event: "ACTION_RESOLVED", resolution }],
  } as any);
  return request;
}

function table(role: "GM" | "player", state?: ProjectedTableState) {
  const isGm = role === "GM";
  const live = liveTable(isGm ? GM_ID : PLAYER_ID, state ?? (isGm ? gmView() : playerView()));
  live.client.state.actors.value = { [HERO_ACTOR]: { version: 1, data: wizard() } as any };
  const ui = mount(
    h(
      "div",
      null,
      h(TableCanvas, { campaignId: CAMPAIGN, client: live.client, isGm }),
      h(ActionResolutionCard, { client: live.client, isGm }),
      h(PendingResolutionsPanel, { client: live.client, isGm }),
      h(MonsterTurnPanel, { client: live.client, isGm }),
      h(ConcentrationCheckPrompt, { client: live.client }),
    ),
  );
  return { live, ui };
}

beforeEach(() => {
  cancelAction();
  targetTokenIdSignal.value = null;
  acceptedCoverSignal.value = null;
  selectedTokenIdSignal.value = null;
});

describe("ActionResolutionCard: a player attacks a monster", () => {
  it("the server rolls against the hidden AC; the player sees the hit and applies it", () => {
    const { live, ui } = table("player");
    startAction({ kind: "attack", actorId: HERO_ACTOR, attackId: "srd:spell:fire_bolt" });
    ui.input(`action-target-${GOBLIN}`, "on", "change");
    ui.click("action-roll");
    const [sent] = live.commands();
    assert.equal(sent.cmd, "RESOLVE_ACTION");
    assert.equal(sent.request.check.kind, "ATTACK");
    assert.deepEqual(sent.request.targets, [{ token_id: GOBLIN, roll_mode: "NORMAL", cover: "NONE" }]);
    assert.equal(sent.request.damage_type, "fire");
    assert.equal(ui.byTestId("action-status").textContent, "Rolling…");

    answer(live, playerView, [resolvedTarget({ outcome: "HIT", damage: 7 })]);
    assert.equal(ui.byTestId(`action-outcome-${GOBLIN}`).textContent, "Hit");
    assert.equal(ui.byTestId(`action-damage-${GOBLIN}`).textContent, "7 damage");
    assert.doesNotMatch(ui.byTestId(`action-result-${GOBLIN}`).textContent, /rolled|d20/);
    assert.equal(ui.byTestId("action-status").textContent, "Goblin: Hit");
    assert.notEqual(String(ui.byTestId("action-damage-type").tagName).toUpperCase(), "SELECT");
    assertAbsent(ui.byTestId(`action-critical-${GOBLIN}`), "player critical toggle");
    ui.click("action-apply");
    assert.deepEqual(live.commands()[1], { cmd: "APPLY_RESOLUTION", resolution_id: sent.request.resolution_id, token_id: null, adjustment: null });
    assert.equal(pendingActionSignal.value, null);
    ui.unmount();
  });

  it("a miss leaves nothing to apply", () => {
    const { live, ui } = table("player");
    startAction({ kind: "attack", actorId: HERO_ACTOR, attackId: "srd:spell:fire_bolt" });
    ui.input(`action-target-${GOBLIN}`, "on", "change");
    ui.click("action-roll");
    answer(live, playerView, [resolvedTarget({ outcome: "MISS", damage: 0, applied: true })]);
    assert.equal(ui.byTestId(`action-outcome-${GOBLIN}`).textContent, "Miss");
    assert.equal(ui.byTestId("action-apply").disabled, true);
    assertPresent(ui.byTestId("action-nothing-left"), "action-nothing-left");
    ui.unmount();
  });

  it("a refused roll explains it and lets the player roll again", async () => {
    const { live, ui } = table("player");
    startAction({ kind: "attack", actorId: HERO_ACTOR, attackId: "srd:spell:fire_bolt" });
    ui.input(`action-target-${GOBLIN}`, "on", "change");
    ui.click("action-roll");
    live.client.state.commandFeedback.value = [{ id: 99, kind: "rejected", action: "RESOLVE_ACTION", reason: "no" }];
    await flush(6);
    assertPresent(ui.byTestId("action-error"), "action-error");
    assertPresent(ui.byTestId("action-roll"), "action-roll");
    ui.unmount();
  });
});

describe("ActionResolutionCard: a player's area against monsters", () => {
  it("the server rolls each monster's save; the player sees success and half damage", async () => {
    const { live, ui } = table("player");
    startAction({ kind: "area", actorId: HERO_ACTOR, spellId: "srd:spell:burning_hands" });
    ui.input("action-area-token", GOBLIN, "change");
    ui.click("action-area-project");
    const [projected] = live.commands();
    assert.equal(projected.cmd, "PROJECT_AOE");
    live.client.applyServerEnvelope({
      type: "CommandAccepted",
      seqId: seq++,
      state: playerView(),
      events: [{ event: "AOE_PROJECTED", template: projected.template, affected_cells: [], affected_token_ids: [GOBLIN], persisted: false }],
    } as any);
    await flush(6);
    const request = answer(live, playerView, [resolvedTarget({ outcome: "SAVE_SUCCESS", damage: 5 })]);
    assert.deepEqual(request.check, { kind: "SAVE", ability: "dex", dc: request.check.dc, half_on_success: true });
    assert.equal(ui.byTestId(`action-outcome-${GOBLIN}`).textContent, "Save succeeded");
    assert.equal(ui.byTestId(`action-damage-${GOBLIN}`).textContent, "5 damage");
    ui.click("action-apply");
    assert.equal(live.commands().at(-1)!.cmd, "APPLY_RESOLUTION");
    ui.unmount();
  });

  it("an area that reaches nobody says so without asking the server", async () => {
    const { live, ui } = table("GM");
    startAction({ kind: "area", actorId: HERO_ACTOR, spellId: "srd:spell:burning_hands" });
    ui.input("action-area-token", GOBLIN, "change");
    ui.click("action-area-project");
    const [projected] = live.commands();
    live.client.applyServerEnvelope({
      type: "CommandAccepted",
      seqId: seq++,
      state: gmView(),
      events: [{ event: "AOE_PROJECTED", template: projected.template, affected_cells: [], affected_token_ids: [], persisted: false }],
    } as any);
    await flush(6);
    assert.equal(ui.byTestId("action-status").textContent, "No token is in the area.");
    assert.equal(live.commands().length, 1);
    assertAbsent(ui.byTestId("action-apply"), "action-apply");
    ui.unmount();
  });
});

describe("PendingResolutionsPanel: the GM's list", () => {
  const ID = "bbbbbbbb-0000-4000-8000-000000000001";
  const withPending = (targets: WireResolvedTarget[]) => gmView({ pending_resolutions: { [ID]: pendingResolution(ID, targets) } });

  it("shows a player's resolution and applies it as rolled", () => {
    const { live, ui } = table("GM", withPending([resolvedTarget({ d20_rolls: [14], total: 19 })]));
    assert.equal(ui.byTestId("pending-resolutions-count").textContent, "Pending resolutions: 1");
    assert.match(ui.byTestId(`pending-${ID}-result-${GOBLIN}`).textContent, /rolled 19, d20 14/);
    ui.click(`pending-${ID}-apply`);
    assert.deepEqual(live.commands(), [{ cmd: "APPLY_RESOLUTION", resolution_id: ID, token_id: null, adjustment: null }]);
    ui.unmount();
  });

  const adjustments: Array<{ id: string; edit: (ui: ReturnType<typeof mount>) => void; adjustment: Record<string, unknown> }> = [
    { id: "a new amount is sent for that target", edit: (ui) => ui.input(`pending-${ID}-damage-${GOBLIN}`, "3"), adjustment: { damage: 3, damage_type: null, is_critical: null } },
    {
      id: "a critical flag is sent for that target",
      edit: (ui) => {
        ui.byTestId(`pending-${ID}-critical-${GOBLIN}`).checked = true;
        ui.byTestId(`pending-${ID}-critical-${GOBLIN}`).dispatchEvent({ type: "change" });
      },
      adjustment: { damage: null, damage_type: null, is_critical: true },
    },
    { id: "a new damage type is sent", edit: (ui) => ui.input(`pending-${ID}-damage-type`, "cold", "change"), adjustment: { damage: null, damage_type: "cold", is_critical: null } },
  ];
  for (const c of adjustments) {
    it(`GM adjust: ${c.id}`, () => {
      const { live, ui } = table("GM", withPending([resolvedTarget()]));
      c.edit(ui);
      ui.click(`pending-${ID}-apply`);
      assert.deepEqual(live.commands(), [{ cmd: "APPLY_RESOLUTION", resolution_id: ID, token_id: GOBLIN, adjustment: c.adjustment }]);
      ui.unmount();
    });
  }

  it("the GM can dismiss a resolution", () => {
    const { live, ui } = table("GM", withPending([resolvedTarget()]));
    ui.click(`pending-${ID}-dismiss`);
    assert.deepEqual(live.commands(), [{ cmd: "DISMISS_RESOLUTION", resolution_id: ID }]);
    ui.unmount();
  });

  it("an already applied target is not offered again", () => {
    const { ui } = table("GM", withPending([resolvedTarget({ applied: true })]));
    assert.equal(ui.byTestId(`pending-${ID}-apply`).disabled, true);
    ui.unmount();
  });

  it("is absent when nothing is pending", () => {
    const { ui } = table("GM");
    assertAbsent(ui.byTestId("pending-resolutions"), "pending-resolutions");
    ui.unmount();
  });
});

describe("MonsterTurnPanel: the GM runs a monster's attack", () => {
  it("a stat block action rolls against the player's token", () => {
    const { live, ui } = table("GM");
    selectedTokenIdSignal.value = GOBLIN;
    ui.click(`monster-turn-action-${GOBLIN_ATTACK.id}`);
    assert.deepEqual(pendingActionSignal.value, { kind: "monster", tokenId: GOBLIN, actionId: GOBLIN_ATTACK.id });
    ui.input(`action-target-${HERO}`, "on", "change");
    ui.click("action-roll");
    const [sent] = live.commands();
    assert.equal(sent.request.attacker_token_id, GOBLIN);
    assert.deepEqual(sent.request.check, { kind: "ATTACK", attack_bonus: GOBLIN_ATTACK.attack!.toHit, critical_range: 20 });
    answer(live, gmView, [resolvedTarget({ token_id: HERO, d20_rolls: [13], total: 17 })]);
    assert.match(ui.byTestId(`action-result-${HERO}`).textContent, /rolled 17, d20 13/);
    ui.unmount();
  });

  it("players never get the monster panel", () => {
    const { ui } = table("player");
    selectedTokenIdSignal.value = GOBLIN;
    assertAbsent(ui.byTestId("monster-turn"), "monster-turn");
    ui.unmount();
  });
});

describe("ConcentrationCheckPrompt", () => {
  it("prompts the oldest DC, rolls on the server and announces a loss", () => {
    const { live, ui } = table("player", playerView({ pending_concentration_checks: { [HERO]: [12, 15] } }));
    assert.equal(ui.byTestId(`concentration-check-${HERO}`).textContent.includes("Mira: CON save DC 12"), true);
    ui.click(`concentration-roll-${HERO}`);
    assert.deepEqual(live.commands(), [{ cmd: "ROLL_CONCENTRATION_CHECK", token_id: HERO, roll_mode: "NORMAL", roll: null }]);
    live.client.applyServerEnvelope({
      type: "CommandAccepted",
      seqId: seq++,
      state: playerView({ pending_concentration_checks: { [HERO]: [15] } }),
      events: [{ event: "CONCENTRATION_CHECK_ROLLED", token_id: HERO, dc: 12, d20_rolls: [5], total: 5, success: false }],
    } as any);
    assert.equal(ui.byTestId("concentration-result").textContent, "Mira loses concentration (5 vs DC 12).");
    ui.unmount();
  });

  it("stays hidden without a check", () => {
    const { ui } = table("player");
    assertAbsent(ui.byTestId("concentration-prompt"), "concentration-prompt");
    ui.unmount();
  });
});
