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

import { ArmorInitiativeSpeedWidget } from "./ArmorInitiativeSpeedWidget.tsx";
import { AttackActionTableWidget } from "./AttackActionTableWidget.tsx";
import { ConditionBadgeStripWidget } from "./ConditionBadgeStripWidget.tsx";
import { FeatureTraitListWidget } from "./FeatureTraitListWidget.tsx";
import { HitDiceAndDeathSavesWidget } from "./HitDiceAndDeathSavesWidget.tsx";
import { InventoryContainerTreeWidget } from "./InventoryContainerTreeWidget.tsx";
import { NotesMarkdownPaneWidget, sanitizeHtml } from "./NotesMarkdownPaneWidget.tsx";
import { ResourceBarWidget } from "./ResourceBarWidget.tsx";
import { SavingThrowListWidget } from "./SavingThrowListWidget.tsx";
import { SkillCheckListWidget } from "./SkillCheckListWidget.tsx";
import { SpellbookAccordionWidget } from "./SpellbookAccordionWidget.tsx";
import { StatBlock6Widget } from "./StatBlock6Widget.tsx";

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

export * from "./ArmorInitiativeSpeedWidget.tsx";
export * from "./AttackActionTableWidget.tsx";
export * from "./ConditionBadgeStripWidget.tsx";
export * from "./FeatureTraitListWidget.tsx";
export * from "./HitDiceAndDeathSavesWidget.tsx";
export * from "./InventoryContainerTreeWidget.tsx";
export { NotesMarkdownPaneWidget } from "./NotesMarkdownPaneWidget.tsx";
export * from "./ResourceBarWidget.tsx";
export * from "./SavingThrowListWidget.tsx";
export * from "./SkillCheckListWidget.tsx";
export * from "./SpellbookAccordionWidget.tsx";
export * from "./StatBlock6Widget.tsx";

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

  registry.register("StatBlock6Widget", StatBlock6Widget);
  registry.register("ResourceBarWidget", ResourceBarWidget);
  registry.register("SavingThrowListWidget", SavingThrowListWidget);
  registry.register("SkillCheckListWidget", SkillCheckListWidget);
  registry.register("ArmorInitiativeSpeedWidget", ArmorInitiativeSpeedWidget);
  registry.register("HitDiceAndDeathSavesWidget", HitDiceAndDeathSavesWidget);
  registry.register("AttackActionTableWidget", AttackActionTableWidget);
  registry.register("SpellbookAccordionWidget", SpellbookAccordionWidget);
  registry.register("InventoryContainerTreeWidget", InventoryContainerTreeWidget);
  registry.register("FeatureTraitListWidget", FeatureTraitListWidget);
  registry.register("ConditionBadgeStripWidget", ConditionBadgeStripWidget);
  registry.register("NotesMarkdownPaneWidget", NotesMarkdownPaneWidget);
}
