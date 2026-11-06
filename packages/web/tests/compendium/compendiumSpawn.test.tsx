import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h } from "preact";
import { CompendiumResolver } from "../../../game-systems/dnd5e/src/index.ts";
import {
  MAX_VISIBLE_ENTRIES,
  monsterSpawnCommand,
  monsterStatBlockOf,
  type CompendiumEntry,
} from "../../src/compendium/CompendiumDrawer.tsx";
import { localeSignal } from "../../src/i18n/index.ts";
import { uniqueTokenName } from "../../src/table/tableView.ts";
import { CampaignWorkspace } from "../../src/workspace/CampaignWorkspace.tsx";
import { assertAbsent, assertPresent } from "../helpers/domAssert.ts";
import { CAMPAIGN, GM_ID, HERO, PLAYER_ID, fullToken, liveTable, mount, tableState } from "../helpers/liveTable.ts";
import { setupMockDom } from "../helpers/mockDom.ts";

setupMockDom();
localeSignal.value = "en";

const ABOLETH = "srd:monster:aboleth";

function srdMonster(id: string): CompendiumEntry {
  const entry = CompendiumResolver.getDefault().get(id);
  assert.ok(entry, `${id} is in the installed SRD`);
  return entry as CompendiumEntry;
}

describe("monsterSpawnCommand: SRD reference vs homebrew copy", () => {
  const aboleth = srdMonster(ABOLETH);
  const block = monsterStatBlockOf(aboleth);
  assert.ok(block, "aboleth carries a stat block");
  const cases: Array<{ id: string; entry: CompendiumEntry; expectRef: boolean }> = [
    { id: "srd_tier_sends_the_pack_reference", entry: aboleth, expectRef: true },
    { id: "homebrew_tier_sends_the_stat_block_object", entry: { ...aboleth, id: "hb:aboleth", tier: "CAMPAIGN_HOMEBREW" }, expectRef: false },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const cmd = monsterSpawnCommand(c.entry, block, "Aboleth", { x: 50, y: 0 }, "tok-1") as any;
      assert.equal(cmd.cmd, "SPAWN_TOKEN");
      assert.deepEqual([cmd.token.actor_id, cmd.token.owner_user_id], [null, null]);
      assert.deepEqual([cmd.token.hp, cmd.token.max_hp, cmd.token.ac, cmd.token.speed_max_ft], [150, 150, 17, 10]);
      if (c.expectRef) assert.equal(cmd.token.stat_block, ABOLETH);
      else assert.equal(cmd.token.stat_block.name, "Aboleth");
    });
  }

  const nonMonsters = [
    { id: "spell_has_no_stat_block", entryId: "srd:spell:fireball" },
  ];
  for (const c of nonMonsters) {
    it(c.id, () => assert.equal(monsterStatBlockOf(srdMonster(c.entryId)), null));
  }
});

describe("uniqueTokenName", () => {
  const cases = [
    { id: "free_name_is_kept", names: ["Hero"], expected: "Aboleth" },
    { id: "taken_name_gets_2", names: ["Aboleth"], expected: "Aboleth 2" },
    { id: "taken_2_gets_3", names: ["Aboleth", "Aboleth 2"], expected: "Aboleth 3" },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const tokens = Object.fromEntries(c.names.map((name, i) => [`t${i}`, fullToken(`t${i}`, name)]));
      assert.equal(uniqueTokenName("Aboleth", tableState({ tokens })), c.expected);
    });
  }
});

describe("Compendium tab: full SRD, stat blocks, GM spawn", () => {
  it("lists pack-only monsters and caps the rendered cards", () => {
    const { client } = liveTable(PLAYER_ID, null);
    const ui = mount(h(CampaignWorkspace, { campaignId: CAMPAIGN, userRole: "PLAYER", client, activeTab: "compendium" }));
    assert.equal(ui.container.querySelectorAll(".ds-compendium-entry-card").length, MAX_VISIBLE_ENTRIES);
    assertPresent(ui.byTestId("compendium-truncated"), "truncation hint");
    ui.input("compendium-search-input", "Aboleth");
    assertPresent(ui.byTestId(`compendium-entry-${ABOLETH}`), "aboleth card");
    assertAbsent(ui.byTestId("compendium-truncated"), "truncation hint after search");
    ui.unmount();
  });

  it("toggles the real stat block with aria-expanded", () => {
    const { client } = liveTable(PLAYER_ID, null);
    const ui = mount(h(CampaignWorkspace, { campaignId: CAMPAIGN, userRole: "PLAYER", client, activeTab: "compendium" }));
    ui.input("compendium-search-input", "Aboleth");
    assertAbsent(ui.byTestId(`stat-block-${ABOLETH}`), "stat block before toggle");
    ui.click(`btn-stat-block-${ABOLETH}`);
    const block = ui.byTestId(`stat-block-${ABOLETH}`);
    assertPresent(block, "stat block after toggle");
    assert.equal(ui.byTestId(`btn-stat-block-${ABOLETH}`).getAttribute("aria-expanded"), "true");
    assert.equal(ui.byTestId(`stat-block-${ABOLETH}-str`).textContent, "STR21 (+5)");
    assert.match(block.textContent, /Armor Class17/);
    assert.match(block.textContent, /Legendary Actions/);
    ui.click(`btn-stat-block-${ABOLETH}`);
    assertAbsent(ui.byTestId(`stat-block-${ABOLETH}`), "stat block after second toggle");
    ui.unmount();
  });

  const spawnCases = [
    { id: "gm_with_table_sees_spawn", userId: GM_ID, role: "GM" as const, table: true, visible: true },
    { id: "gm_without_table_has_no_spawn", userId: GM_ID, role: "GM" as const, table: false, visible: false },
    { id: "player_has_no_spawn", userId: PLAYER_ID, role: "PLAYER" as const, table: true, visible: false },
  ];
  for (const c of spawnCases) {
    it(`spawn control: ${c.id}`, () => {
      const { client } = liveTable(c.userId, c.table ? tableState() : null);
      const ui = mount(h(CampaignWorkspace, { campaignId: CAMPAIGN, userRole: c.role, client, activeTab: "compendium" }));
      ui.input("compendium-search-input", "Aboleth");
      assert.equal(Boolean(ui.byTestId(`btn-spawn-${ABOLETH}`)), c.visible);
      ui.unmount();
    });
  }

  it("GM spawn sends the SRD reference on the first free cell with a unique name", () => {
    const occupied = tableState({ tokens: { [HERO]: fullToken(HERO, "Aboleth") } });
    const table = liveTable(GM_ID, occupied);
    const ui = mount(h(CampaignWorkspace, { campaignId: CAMPAIGN, userRole: "GM", client: table.client, activeTab: "compendium" }));
    ui.input("compendium-search-input", "Aboleth");
    ui.click(`btn-spawn-${ABOLETH}`);
    const spawn = table.commands().find((c) => c.cmd === "SPAWN_TOKEN");
    assert.ok(spawn, "SPAWN_TOKEN sent");
    assert.equal(spawn.token.stat_block, ABOLETH);
    assert.equal(spawn.token.name, "Aboleth 2");
    assert.deepEqual(spawn.token.top_left, { x: 50, y: 0 });
    assert.equal(ui.byTestId("workspace-spawn-status").textContent, "Aboleth 2 spawned on the table.");
    ui.unmount();
  });
});
