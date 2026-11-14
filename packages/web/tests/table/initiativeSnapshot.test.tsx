import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h } from "preact";
import type { ProjectedTableState } from "../../src/api/wire.ts";
import { localeSignal } from "../../src/i18n/index.ts";
import { CombatTrackerBar } from "../../src/table/CombatTrackerBar.tsx";
import { CAMPAIGN, GM_ID, GOBLIN, HERO, PLAYER_ID, fullToken, liveTable, mount, publicToken, tableState } from "../helpers/liveTable.ts";
import { setupMockDom } from "../helpers/mockDom.ts";

setupMockDom();
localeSignal.value = "en";

const LURKER = "aaaaaaaa-0000-4000-8000-000000000003";

/** GM projection: every combatant and every total. */
const gmCombat = tableState({
  mode: "TURN_BY_TURN",
  tokens: { [HERO]: fullToken(HERO, "Hero", { owner_user_id: PLAYER_ID }), [GOBLIN]: fullToken(GOBLIN, "Goblin"), [LURKER]: fullToken(LURKER, "Lurker") },
  initiative_order: [LURKER, HERO, GOBLIN],
  initiative_totals: { [LURKER]: 20, [HERO]: 17, [GOBLIN]: 12 },
  active_turn_index: 1,
});

/** Player projection: the hidden Lurker has neither an order entry nor a total. */
const playerCombat = tableState({
  mode: "TURN_BY_TURN",
  tokens: { [HERO]: fullToken(HERO, "Hero", { owner_user_id: PLAYER_ID }) },
  public_tokens: { [GOBLIN]: publicToken(GOBLIN, "Goblin") },
  initiative_order: [HERO, GOBLIN],
  initiative_totals: { [HERO]: 17, [GOBLIN]: 12 },
  active_turn_index: 0,
});

describe("Initiative totals seeded from the projected snapshot", () => {
  const cases: Array<{ id: string; isGm: boolean; state: ProjectedTableState; reconnect: boolean; expected: Record<string, number> }> = [
    { id: "GM fresh join sees every total", isGm: true, state: gmCombat, reconnect: false, expected: { [LURKER]: 20, [HERO]: 17, [GOBLIN]: 12 } },
    { id: "GM reconnect replaces stale totals", isGm: true, state: gmCombat, reconnect: true, expected: { [LURKER]: 20, [HERO]: 17, [GOBLIN]: 12 } },
    { id: "player fresh join sees visible totals, hidden combatant absent", isGm: false, state: playerCombat, reconnect: false, expected: { [HERO]: 17, [GOBLIN]: 12 } },
    { id: "player reconnect drops a stale hidden total", isGm: false, state: playerCombat, reconnect: true, expected: { [HERO]: 17, [GOBLIN]: 12 } },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const table = liveTable(c.isGm ? GM_ID : PLAYER_ID, c.reconnect ? null : c.state);
      const { client } = table;
      if (c.reconnect) {
        client.state.initiativeTotals.value = { [LURKER]: 20, [HERO]: 3 };
        client.connect(CAMPAIGN);
        table.transport.sockets[1].open();
        client.applyServerEnvelope({ type: "StateSnapshot", seqId: 40, state: c.state });
      }
      assert.deepEqual(client.state.initiativeTotals.value, c.expected);

      const ui = mount(h(CombatTrackerBar, { client, isGm: c.isGm }));
      assert.equal(Boolean(ui.byTestId(`initiative-${LURKER}`)), c.isGm, "hidden combatant row only for the GM");
      if (!c.isGm) assert.equal(ui.byTestId(`initiative-value-${HERO}`).textContent, "17");

      client.applyServerEnvelope({
        type: "CommandAccepted",
        seqId: 41,
        events: [{ event: "INITIATIVE_UPDATED", initiative_order: c.state.initiative_order, initiative_totals: { ...c.expected, [GOBLIN]: 19 } }],
        state: { ...c.state, initiative_totals: { ...c.expected, [GOBLIN]: 19 } },
      });
      assert.equal(client.state.initiativeTotals.value[GOBLIN], 19, "events apply on top of the seed");
      ui.unmount();
    });
  }

  const merges: Array<{ id: string; known: Record<string, number>; state: ProjectedTableState; expected: Record<string, number> }> = [
    {
      id: "a roll-derived total the server lacks survives a later snapshot",
      known: { [GOBLIN]: 9 },
      state: { ...playerCombat, initiative_totals: { [HERO]: 17 } },
      expected: { [GOBLIN]: 9, [HERO]: 17 },
    },
    { id: "a snapshot without totals keeps the known ones", known: { [HERO]: 17 }, state: { ...playerCombat, initiative_totals: undefined }, expected: { [HERO]: 17 } },
    { id: "an exploration snapshot clears the totals", known: { [HERO]: 17 }, state: tableState({ initiative_totals: { [HERO]: 17 } }), expected: {} },
  ];
  for (const c of merges) {
    it(c.id, () => {
      const { client } = liveTable(PLAYER_ID, tableState());
      client.state.initiativeTotals.value = c.known;
      client.applyServerEnvelope({ type: "StateSnapshot", seqId: 1, state: c.state });
      assert.deepEqual(client.state.initiativeTotals.value, c.expected);
    });
  }
});
