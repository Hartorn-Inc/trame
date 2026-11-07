/**
 * ============================================================================
 * SRD 5.2.1 COMPENDIUM PACK GENERATOR CLI (generate-srd-content.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Regenerates `packs/*.json` from the pinned Open5e `srd-2024` snapshot
 * (decision D8). Only the generated packs are committed; the 3.1 MB raw
 * snapshot is fetched at the pinned commit and verified by sha256 on every
 * run, so a moved tag or a tampered mirror fails instead of shipping data.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Integrity Before Parsing`:
 *      - Each input file is hashed before `JSON.parse`; a mismatch with
 *        `OPEN5E_SOURCE.files[*].sha256` aborts with exit code 1.
 *   2. `Reproducible Output`:
 *      - `--check` regenerates in memory and fails when any committed pack
 *        or `manifest.json` differs, so CI or a reviewer can prove the
 *        committed data matches the pinned source.
 *   3. `Attribution Travels With The Data`:
 *      - `manifest.json` carries `SRD_521_ATTRIBUTION` verbatim, the same
 *        notice as `system.json` and `ATTRIBUTION.md`.
 *   4. `Reproducible Test Sample`:
 *      - `--write-sample` extracts the records listed in `SAMPLE` into
 *        `tests/fixtures/open5e-srd-2024-sample.json`, so the determinism
 *        tests run offline on bytes taken from the same pinned snapshot.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `make srd-content [ARGS="--check" | "--write-sample" | "--source-dir <dir>"]`
 *     ├── 1. Read each file from `--source-dir` or fetch it from GitHub at the pinned commit.
 *     ├── 2. Verify sha256 and parse the seven Open5e JSON files.
 *     ├── 3. `buildSrdPacks(snapshot)` and serialize one entry per line.
 *     └── 4. Write (or `--check`) `packs/{spells,monsters,magic-items}.json` and `packs/manifest.json`.
 * ============================================================================
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SRD_521_ATTRIBUTION } from "../src/compendium.ts";
import { buildSrdPacks, OPEN5E_SOURCE, serializePack, type Open5eRecord, type Open5eSnapshot } from "./open5eTransform.ts";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACK_DIR = join(PACKAGE_DIR, "packs");
const SAMPLE_FILE = join(PACKAGE_DIR, "tests", "fixtures", "open5e-srd-2024-sample.json");

/**
 * Records kept in the test sample, by Open5e key (without `srd-2024_`).
 * Magic items match by prefix so every variant sharing a rules text is kept;
 * creature actions and traits follow their creature.
 */
const SAMPLE = {
  creatures: /^(adult-red-dragon|goblin-warrior|skeleton|werewolf|will-o-wisp)$/,
  spells: /^(bless|fire-bolt|fireball|greater-invisibility|lightning-bolt|mass-suggestion|shocking-grasp)$/,
  magicItems: /^(bag-of-holding|defender|dwarven-plate|dwarven-half-plate|frost-brand|horn-of-valhalla)/,
  items: /^(ioun-stone|potion-of-giant-strength|potion-of-healing|potions-of-healing|spell-scroll)$/,
};

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadFile(name: string, sourceDir: string | undefined): Promise<Uint8Array> {
  if (sourceDir) return readFile(join(sourceDir, name));
  const url = `https://raw.githubusercontent.com/open5e/open5e-api/${OPEN5E_SOURCE.commit}/${OPEN5E_SOURCE.dataPath}/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function sampleOf(snapshot: Open5eSnapshot): Open5eSnapshot {
  const keep = (records: Open5eRecord[], pattern: RegExp) =>
    records.filter((r) => pattern.test(String(r.pk).replace(/^srd-2024_/, "")));
  const creatures = keep(snapshot.creatures, SAMPLE.creatures);
  const parents = new Set(creatures.map((c) => String(c.pk)));
  const ofCreature = (records: Open5eRecord[]) => records.filter((r) => parents.has(String(r.fields.parent)));
  return {
    creatures,
    creatureActions: ofCreature(snapshot.creatureActions),
    creatureTraits: ofCreature(snapshot.creatureTraits),
    spells: keep(snapshot.spells, SAMPLE.spells),
    magicItems: keep(snapshot.magicItems, SAMPLE.magicItems),
    items: keep(snapshot.items, SAMPLE.items),
    documents: snapshot.documents,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const sourceDirIndex = args.indexOf("--source-dir");
  const sourceDir = sourceDirIndex >= 0 ? args[sourceDirIndex + 1] : undefined;

  const snapshot = {} as Open5eSnapshot;
  const inputs: { file: string; sha256: string; bytes: number }[] = [];
  for (const [key, spec] of Object.entries(OPEN5E_SOURCE.files) as [keyof Open5eSnapshot, { file: string; sha256: string }][]) {
    const bytes = await loadFile(spec.file, sourceDir);
    const digest = sha256(bytes);
    if (digest !== spec.sha256) {
      throw new Error(`${spec.file}: sha256 ${digest} does not match the pinned ${spec.sha256}`);
    }
    snapshot[key] = JSON.parse(new TextDecoder().decode(bytes));
    inputs.push({ file: `${OPEN5E_SOURCE.dataPath}/${spec.file}`, sha256: digest, bytes: bytes.byteLength });
  }

  if (args.includes("--write-sample")) {
    await writeFile(SAMPLE_FILE, `${JSON.stringify(sampleOf(snapshot))}\n`);
    console.log(`Wrote the Open5e test sample to ${SAMPLE_FILE}`);
    return;
  }

  const packs = buildSrdPacks(snapshot);
  const outputs: Record<string, string> = {
    "spells.json": serializePack(packs.spells),
    "monsters.json": serializePack(packs.monsters),
    "magic-items.json": serializePack(packs.magicItems),
  };
  const manifest = {
    srdVersion: "5.2.1",
    license: "CC-BY-4.0",
    attribution: SRD_521_ATTRIBUTION,
    generator: "packages/game-systems/dnd5e/scripts/generate-srd-content.ts",
    source: {
      repository: OPEN5E_SOURCE.repository,
      tag: OPEN5E_SOURCE.tag,
      commit: OPEN5E_SOURCE.commit,
      documentKey: OPEN5E_SOURCE.documentKey,
      inputs,
    },
    counts: { spells: packs.spells.length, monsters: packs.monsters.length, magicItems: packs.magicItems.length },
    packs: Object.entries(outputs).map(([file, text]) => ({ file, sha256: sha256(text), bytes: Buffer.byteLength(text) })),
  };
  outputs["manifest.json"] = `${JSON.stringify(manifest, null, 2)}\n`;

  if (check) {
    const stale: string[] = [];
    for (const [file, text] of Object.entries(outputs)) {
      const committed = await readFile(join(PACK_DIR, file), "utf8").catch(() => "");
      if (committed !== text) stale.push(file);
    }
    if (stale.length > 0) throw new Error(`Generated packs differ from the committed ones: ${stale.join(", ")}`);
    console.log("SRD packs are up to date.");
    return;
  }
  await mkdir(PACK_DIR, { recursive: true });
  for (const [file, text] of Object.entries(outputs)) await writeFile(join(PACK_DIR, file), text);
  console.log(`Wrote ${manifest.counts.spells} spells, ${manifest.counts.monsters} monsters, ${manifest.counts.magicItems} magic items to ${PACK_DIR}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
