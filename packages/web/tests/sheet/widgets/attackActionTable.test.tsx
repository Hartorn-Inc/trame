import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h } from "preact";
import { localeSignal } from "../../../src/i18n/index.ts";
import { AttackActionTableWidget } from "../../../src/sheet/widgets/AttackActionTableWidget.tsx";
import { assertAbsent, assertPresent } from "../../helpers/domAssert.ts";
import { mount } from "../../helpers/liveTable.ts";
import { setupMockDom } from "../../helpers/mockDom.ts";

setupMockDom();
localeSignal.value = "en";

describe("AttackActionTableWidget: how each attack resolves", () => {
  const cases = [
    { id: "an attack roll shows its bonus and offers the roll", attack: { delivery: "ranged", attackBonus: 5 }, toHit: "+5", rollButton: true },
    { id: "a save shows its DC and offers no attack roll", attack: { delivery: "save", attackBonus: null, save: { ability: "dex", dc: 13 } }, toHit: "DC 13 DEX", rollButton: false },
    { id: "Magic Missile shows an automatic hit and offers no attack roll", attack: { delivery: "automatic", attackBonus: null }, toHit: "Auto", rollButton: false },
    { id: "Hex shows a rider on a hit and offers no attack roll", attack: { delivery: "rider", attackBonus: null }, toHit: "On hit", rollButton: false },
  ];
  for (const c of cases) {
    it(c.id, () => {
      const attack = { id: "atk", name: "Spell", damageDice: "1d6", damageModifier: 0, damageType: "force", ...c.attack };
      const ui = mount(h(AttackActionTableWidget, { id: "w", boundValues: { attacks: [attack] } } as any));
      assert.equal(ui.byTestId("attack-tohit-atk").textContent, c.toHit);
      if (c.rollButton) assertPresent(ui.byTestId("btn-atk-roll-atk"), "attack roll button");
      else assertAbsent(ui.byTestId("btn-atk-roll-atk"), "attack roll button");
      ui.unmount();
    });
  }
});
