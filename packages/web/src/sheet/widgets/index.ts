import { ArmorInitiativeSpeed } from "./ArmorInitiativeSpeed.ts";
import { AttackActionTable } from "./AttackActionTable.ts";
import { ConditionBadgeStrip } from "./ConditionBadgeStrip.ts";
import { FeatureTraitList } from "./FeatureTraitList.ts";
import { HitDiceAndDeathSaves } from "./HitDiceAndDeathSaves.ts";
import { InventoryContainerTree } from "./InventoryContainerTree.ts";
import { NotesMarkdownPane } from "./NotesMarkdownPane.ts";
import { ResourceBar } from "./ResourceBar.ts";
import { SavingThrowList } from "./SavingThrowList.ts";
import { SkillCheckList } from "./SkillCheckList.ts";
import { SpellbookAccordion } from "./SpellbookAccordion.ts";
import { StatBlock6 } from "./StatBlock6.ts";

export * from "./ArmorInitiativeSpeed.ts";
export * from "./AttackActionTable.ts";
export * from "./ConditionBadgeStrip.ts";
export * from "./FeatureTraitList.ts";
export * from "./HitDiceAndDeathSaves.ts";
export * from "./InventoryContainerTree.ts";
export * from "./NotesMarkdownPane.ts";
export * from "./ResourceBar.ts";
export * from "./SavingThrowList.ts";
export * from "./SkillCheckList.ts";
export * from "./SpellbookAccordion.ts";
export * from "./StatBlock6.ts";

export function registerAllCanonicalWidgets(registry: { register: (name: string, impl: unknown) => void }): void {
  registry.register("StatBlock6", StatBlock6);
  registry.register("ResourceBar", ResourceBar);
  registry.register("SavingThrowList", SavingThrowList);
  registry.register("SkillCheckList", SkillCheckList);
  registry.register("ArmorInitiativeSpeed", ArmorInitiativeSpeed);
  registry.register("HitDiceAndDeathSaves", HitDiceAndDeathSaves);
  registry.register("AttackActionTable", AttackActionTable);
  registry.register("SpellbookAccordion", SpellbookAccordion);
  registry.register("InventoryContainerTree", InventoryContainerTree);
  registry.register("FeatureTraitList", FeatureTraitList);
  registry.register("ConditionBadgeStrip", ConditionBadgeStrip);
  registry.register("NotesMarkdownPane", NotesMarkdownPane);
}
