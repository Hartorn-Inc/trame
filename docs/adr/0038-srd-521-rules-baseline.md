# ADR-0038: SRD 5.2.1 Rules Baseline for the Built-in D&D 5e Pack

## Status
Accepted (Decision G10). Amends [ADR-0001](./0001-dnd5e-gamesystempack-pipeline-and-compendium.md) (rules baseline and attribution) and supersedes the S5 subclass-level fix (A34) that kept Cleric, Sorcerer and Warlock at level 1 and Druid and Wizard at level 2.

## Context
The built-in `@trame/game-system-dnd5e` pack was written against SRD 5.1 (2014 rules), while players at the table expect the 2024 rules. Wizards of the Coast published SRD 5.2.1 under CC-BY-4.0, so the newer rules can ship without licensing risk. Staying on 5.1 also kept content the SRD no longer licenses in the same form (Player's Handbook-style backgrounds such as Folk Hero and Noble, and the Tough, Sharpshooter, Great Weapon Master, Sentinel and Dual Wielder feats), and several review findings (Mummy Lord Legendary Resistance, qualified "nonmagical" resistances, Meteor Swarm damage, missing subclass enforcement) came from mixing editions.

## Considered Options
1. **Stay on SRD 5.1 and fix the review findings.** Rejected: the pack would keep diverging from the rules players use, and the mixed-edition findings would recur.
2. **SRD 5.2.1 only.** Rejected: SRD 5.2.1 omits a few entries the curated catalog needs to keep its S5 size (for example a CR 1/2 Orc stat block).
3. **SRD 5.2.1 first, SRD 5.1 only to fill gaps (Recommended).** Both documents are CC-BY-4.0, so a dual attribution covers the result.

## Decision
1. **Baseline.** Every class feature, species, background, feat, condition, spell, item and monster follows SRD 5.2.1. An entry comes from SRD 5.1 only when SRD 5.2.1 has no equivalent and is marked `source: "srd-5.1"` (today: the Orc monster). Player's Handbook-only and video-game content is never used.
2. **Classes.** All 12 classes use their SRD 5.2.1 feature tables and their single SRD subclass. Every class chooses its subclass at level 3 (`SUBCLASS_UNLOCK_LEVEL`), and level-up rejects a target level of 3 or more without a `subclassId` when the actor has none. Barbarian, Fighter, Paladin, Ranger and Rogue gain Weapon Mastery, with the number of mastered weapon kinds given by `getWeaponMasteryCount`; weapons carry their SRD mastery property.
3. **Origins (`origins.ts`).** Alongside the 9 SRD 5.2.1 species, TRAME ships two original TRAME species (`Half-Elf`, `Radiant Scion` — zero ability score increases, standard speed and darkvision mechanics, and 100% original English and French trait descriptions); species never raise ability scores. Alongside the 4 SRD 5.2.1 backgrounds (`Acolyte`, `Criminal`, `Sage`, `Soldier`), TRAME ships five original TRAME backgrounds (`Caravan Guide`, `Lamplighter`, `Artisan`, `Merchant`, `House Guardian` — `+2/+1` or `+1/+1/+1` across three listed abilities with cap 20, one SRD 5.2.1 Origin feat, two SRD skills, one SRD tool, and SRD starting equipment or `50 GP` via `applyBackground`). All original species and backgrounds are marked as TRAME original content and never copy non-SRD rulebook prose. Feats are exactly the 17 SRD 5.2.1 feats (`SRD_FEATS`); Tough, Sharpshooter, Great Weapon Master, Sentinel and Dual Wielder are removed with their rules, and no generic "+N HP per level" feat mechanism remains because no SRD 5.2.1 feat needs one. User story 20 is dropped.
4. **Exhaustion.** Levels 1 to 6. Each level subtracts 2 from every d20 Test (ability checks, attack rolls, saving throws, initiative) and 5 ft from Speed; level 6 is death. Passive scores are not d20 Tests and keep their value, and the spell save DC is never reduced. A Long Rest removes one level.
5. **Damage resistances.** One policy: resistances, immunities and vulnerabilities are plain damage types. SRD 5.2.1 dropped the "nonmagical bludgeoning, piercing and slashing" qualifier, so stat blocks that only had qualified physical resistances now have none. The Ghost replaces the Banshee, which SRD 5.2.1 does not include.
6. **Derived stats.** `system.json` splits `ac_base` (the highest armor formula) from `ac = ac_base + shield_bonus`, so a Base-phase AC effect replaces the armor value without losing the shield. Formulas stay evaluated by the WASM engine only (ADR-0001 amendment, G1).
7. **Attribution.** `SRD_521_ATTRIBUTION` and `system.json` carry the SRD 5.2.1 CC-BY-4.0 notice followed by the SRD 5.1 notice for gap-filling entries. The pack name reads SRD 5.2.1; the manifest keeps the `DND5E_2024_MANIFEST` name.

## Consequences
### Positive
- Rules match the 2024 books players own, and every shipped entry traces either to a CC-BY-4.0 SRD source or to clearly marked TRAME original content (Apache-2.0) that never copies non-SRD rulebook prose.
- Subclass choice, exhaustion and resistance handling are uniform across classes and monsters, which removes the edition-mixing review findings.
- Species, backgrounds and feats live in one module (`origins.ts`) that both the compendium and character creation / level-up read, so they cannot drift.

### Negative
- Breaking change for stored actors and homebrew: Cleric, Sorcerer, Warlock, Druid and Wizard actors below level 3 that already hold a subclass, actors with removed feats, and entries using qualified resistances need migration or GM review.
- The original TRAME species (`Half-Elf`, `Radiant Scion`) and original TRAME backgrounds (`Caravan Guide`, `Lamplighter`, `Artisan`, `Merchant`, `House Guardian`) are TRAME original content rather than SRD entries: they must stay marked as TRAME original content, grant only SRD 5.2.1 Origin feats, skills, tools, and starting equipment (or `50 GP`), and keep 100% original English/French trait descriptions without copying non-SRD rulebook prose.
- Mixing two SRD versions requires the `source` marker and the dual attribution to stay accurate when content is added.
