// Map studio SRD monster staging: SRD references, unique names, free cells, and the studio picker.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h } from "preact";
import { CompendiumResolver } from "../../../game-systems/dnd5e/src/index.ts";
import { mapFrontendSceneToBackend } from "../../src/maps/domain.ts";
import { MapsStudioTab } from "../../src/maps/MapsStudioTab.tsx";
import { freeStagingTopLeft, srdMonsterEntry, stageSrdMonster } from "../../src/maps/monsterStaging.ts";
import type { CampaignMapScene, StagedToken } from "../../src/maps/types.ts";
import { mount } from "../helpers/liveTable.ts";
import { setupMockDom } from "../helpers/mockDom.ts";
import { assertAbsent, assertPresent } from "../helpers/domAssert.ts";

setupMockDom();

function scene(stagedTokens: StagedToken[] = []): CampaignMapScene {
  return {
    id: "scene-1",
    campaignId: "camp-1",
    title: "Ogre Den",
    revealedToPlayers: false,
    gridCellSizePx: 70,
    feetPerCell: 5,
    widthPx: 700,
    heightPx: 700,
    spawnPoints: [{ id: "sp-1", name: "Entrance", x: 350, y: 350 }],
    walls: [],
    lights: [],
    audioEmitters: [],
    stagedTokens,
  };
}

function stageMany(slug: string, count: number): StagedToken[] {
  let current = scene();
  const entry = srdMonsterEntry(slug);
  assertPresent(entry, `SRD entry ${slug}`);
  for (let i = 0; i < count; i++) {
    current = { ...current, stagedTokens: [...current.stagedTokens, stageSrdMonster(current, entry!)] };
  }
  return current.stagedTokens;
}

function overlaps(a: StagedToken, b: StagedToken): boolean {
  const sa = (a.sizeCells ?? 1) * 70;
  const sb = (b.sizeCells ?? 1) * 70;
  return a.x < b.x + sb && b.x < a.x + sa && a.y < b.y + sb && b.y < a.y + sa;
}

describe("stageSrdMonster: SRD reference, unique name, own free cell", () => {
  const cases: Array<{ id: string; slug: string; count: number; names: string[]; ref: string; sizeCells: number; hp: number }> = [
    { id: "one-ogre-stages-the-srd-reference-large-footprint-and-srd-hp", slug: "ogre", count: 1, names: ["Ogre"], ref: "srd:monster:ogre", sizeCells: 2, hp: 68 },
    { id: "three-goblins-get-numbered-names", slug: "goblin", count: 3, names: ["Goblin Warrior", "Goblin Warrior 2", "Goblin Warrior 3"], ref: "srd:monster:goblin", sizeCells: 1, hp: 10 },
    { id: "two-ogres-never-share-a-cell", slug: "ogre", count: 2, names: ["Ogre", "Ogre 2"], ref: "srd:monster:ogre", sizeCells: 2, hp: 68 },
  ];
  for (const tc of cases) {
    it(`[${tc.id}]`, () => {
      const tokens = stageMany(tc.slug, tc.count);
      assert.deepEqual(tokens.map((tok) => tok.name), tc.names);
      for (const tok of tokens) {
        assert.equal(tok.monsterTemplateId, tc.ref);
        assert.equal(tok.sizeCells, tc.sizeCells);
        assert.equal(tok.hpMax, tc.hp);
        assert.equal(tok.visibilityChannel, "GmHidden");
        assert.equal(tok.x % 70, 0, "grid-aligned x");
        assert.equal(tok.y % 70, 0, "grid-aligned y");
      }
      const clashes = tokens.flatMap((a, i) => tokens.slice(i + 1).filter((b) => overlaps(a, b)).map((b) => `${a.name}/${b.name}`));
      assert.deepEqual(clashes, []);
    });
  }

  it("[saved-scene-sends-the-srd-reference] the PUT payload names srd:monster:ogre so the server copies its stat block", () => {
    const [ogre] = stageMany("ogre", 1);
    const wire = mapFrontendSceneToBackend(scene([ogre]));
    assert.equal(wire.staged_tokens[0].monster_template_id, "srd:monster:ogre");
    assert.equal(wire.staged_tokens[0].size_cells, 2);
  });

  const freeCases: Array<{ id: string; occupied: Array<{ x: number; y: number; sizeCells: number }>; expected: { x: number; y: number } }> = [
    { id: "empty-scene-uses-the-spawn-cell", occupied: [], expected: { x: 350, y: 350 } },
    { id: "taken-spawn-cell-moves-to-the-first-ring-top-left", occupied: [{ x: 350, y: 350, sizeCells: 1 }], expected: { x: 280, y: 280 } },
  ];
  for (const tc of freeCases) {
    it(`[free-cell-${tc.id}]`, () => {
      const staged = tc.occupied.map((o, i) => ({ id: `t${i}`, name: `T${i}`, elevationFt: 0, visibilityChannel: "GmHidden" as const, ...o }));
      assert.deepEqual(freeStagingTopLeft(scene(staged), 1), tc.expected);
    });
  }
});

describe("MapsStudioTab SRD monster picker", () => {
  const monsters = CompendiumResolver.getDefault().list();

  it("[quick-pick-ogre-stages-an-srd-ogre] the Ogre button stages a hidden SRD Ogre and announces it", () => {
    const view = mount(h(MapsStudioTab, { campaignId: "camp-1", userRole: "GM", initialScenes: [scene()], monsterEntries: monsters }));
    view.click("template-Ogre");
    assert.match(view.byTestId("maps-staging-status").textContent, /^Ogre staged with its SRD stat block/);
    assert.match(view.byTestId("canvas-editor").textContent, /Staged Tokens: 1/);
  });

  it("[picker-opens-stages-and-returns-focus] the SRD picker stages any monster and Close returns focus to its toggle", () => {
    const view = mount(h(MapsStudioTab, { campaignId: "camp-1", userRole: "GM", initialScenes: [scene()], monsterEntries: monsters }));
    assertAbsent(view.byTestId("compendium-drawer"), "picker closed by default");
    view.click("open-monster-picker");
    assertPresent(view.byTestId("compendium-drawer"), "picker open");
    const search = view.byTestId("compendium-search-input");
    search.value = "ogre";
    search.dispatchEvent({ type: "input", target: search });
    assertAbsent(view.byTestId("btn-add-entry-srd:monster:ogre"), "no sheet Add button in the studio");
    view.click("btn-stage-srd:monster:ogre");
    assert.match(view.byTestId("maps-staging-status").textContent, /^Ogre staged/);
    view.click("btn-close-compendium");
    assertAbsent(view.byTestId("compendium-drawer"), "picker closed");
    assert.ok((globalThis as any).document.activeElement === view.byTestId("open-monster-picker"), "focus back on the toggle");
  });
});
