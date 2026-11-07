import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { upcastDamageDice } from "../src/index.ts";

const PER_LEVEL_1D6_ABOVE_1 = "The damage increases by 1d6 for each spell slot level above 1.";

describe("upcastDamageDice scales damage per the spell's higher-level text", () => {
  const cases: { id: string; base: string; text: string | undefined; castLevel: number; expected: string }[] = [
    { id: "burning hands cast with a level 3 slot adds 2d6", base: "3d6", text: PER_LEVEL_1D6_ABOVE_1, castLevel: 3, expected: "5d6" },
    { id: "cast at the base level keeps the base dice", base: "3d6", text: PER_LEVEL_1D6_ABOVE_1, castLevel: 1, expected: "3d6" },
    { id: "fireball cast with a level 5 slot adds 2d6", base: "8d6", text: "The damage increases by 1d6 for each spell slot level above 3.", castLevel: 5, expected: "10d6" },
    { id: "a parenthetical between damage and increases still scales", base: "4d4", text: "The damage (both initial and later) increases by 1d4 for each spell slot level above 2.", castLevel: 4, expected: "6d4" },
    { id: "a different die is appended instead of merged", base: "1d4 + 1", text: "The damage increases by 1d8 for each spell slot level above 1.", castLevel: 2, expected: "1d4 + 1 + 1d8" },
    { id: "a die with a longer side count is not merged", base: "2d10", text: "The damage increases by 1d1 for each spell slot level above 1.", castLevel: 2, expected: "2d10 + 1d1" },
    { id: "non-damage scaling keeps the base dice", base: "1d4 + 1", text: "The spell creates one more dart for each spell slot level above 1.", castLevel: 3, expected: "1d4 + 1" },
    { id: "a spell without higher-level text keeps the base dice", base: "2d8", text: undefined, castLevel: 4, expected: "2d8" },
  ];
  for (const { id, base, text, castLevel, expected } of cases) {
    it(id, () => {
      assert.equal(upcastDamageDice(base, text, castLevel), expected);
    });
  }
});
