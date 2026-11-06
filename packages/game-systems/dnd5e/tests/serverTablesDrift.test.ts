/**
 * Drift guard for the SRD tables `crates/trame-server/src/campaigns.rs` hardcodes to
 * derive token `reach_ft` and darkvision from a sheet without running this package:
 * `SRD_REACH_WEAPONS` must list exactly the full SRD's melee weapons with the Reach
 * property, and `SRD_SPECIES_DARKVISION_FT` must match `SRD_SPECIES[*].darkvisionFt`.
 * The Rust source is parsed as text, so editing either side alone fails here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SRD_SPECIES, loadFullSystemSrd } from "../src/index.ts";

const CAMPAIGNS_RS = readFileSync(
  new URL("../../../../crates/trame-server/src/campaigns.rs", import.meta.url),
  "utf8"
);

function rustConstBody(name: string): string {
  const match = new RegExp(`const ${name}: [^=]+= \\[([\\s\\S]*?)\\];`).exec(CAMPAIGNS_RS);
  assert.ok(match, `${name} not found in campaigns.rs`);
  return match[1];
}

describe("Server SRD tables match the dnd5e packs", () => {
  it("reach_weapons_match_full_srd_reach_melee_weapons", async () => {
    const rust = [...rustConstBody("SRD_REACH_WEAPONS").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    const srd = (await loadFullSystemSrd())
      .filter((entry) => {
        const properties = (entry.data.properties as string[] | undefined) ?? [];
        return entry.data.itemType === "weapon" && entry.data.weaponType !== "ranged" && properties.includes("reach");
      })
      .map((entry) => entry.id.split(":").pop()!)
      .sort();
    assert.deepEqual(rust, srd);
  });

  it("species_darkvision_matches_srd_species", () => {
    const rust = Object.fromEntries(
      [...rustConstBody("SRD_SPECIES_DARKVISION_FT").matchAll(/\("([a-z_]+)",\s*([\d.]+)\)/g)].map((m) => [m[1], Number(m[2])])
    );
    const srd = Object.fromEntries(Object.entries(SRD_SPECIES).map(([id, rules]) => [id, rules.darkvisionFt]));
    assert.deepEqual(rust, srd);
  });
});
