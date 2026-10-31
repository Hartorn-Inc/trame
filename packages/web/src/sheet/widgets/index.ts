import { TrameCommand } from "../types.ts";
import type { WidgetRenderContext } from "../WidgetRegistry.ts";

import { ArmorInitiativeSpeed } from "./ArmorInitiativeSpeed.ts";
import { AttackActionTable } from "./AttackActionTable.ts";
import { ConditionBadgeStrip } from "./ConditionBadgeStrip.ts";
import { FeatureTraitList } from "./FeatureTraitList.ts";
import { HitDiceAndDeathSaves } from "./HitDiceAndDeathSaves.ts";
import { InventoryContainerTree } from "./InventoryContainerTree.ts";
import { SavingThrowList } from "./SavingThrowList.ts";
import { SpellbookAccordion } from "./SpellbookAccordion.ts";

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

export interface NotesMarkdownPaneOutput {
  id: string;
  bio: string;
  notes: string;
  sanitizedBio: string;
  sanitizedNotes: string;
  editNotes: (text: string) => void;
  editBio: (text: string) => void;
  sanitize: (text: string) => string;
}

export function NotesMarkdownPane(context: WidgetRenderContext): NotesMarkdownPaneOutput {
  const rawBio = String(context.boundValues.bio ?? "");
  const rawNotes = String(context.boundValues.notes ?? "");

  const handleEditNotes = (text: string) => {
    const sanitized = sanitizeHtml(text);
    context.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: "notes",
        text: sanitized,
        notes: sanitized,
        value: sanitized,
      }),
    );
  };

  const handleEditBio = (text: string) => {
    const sanitized = sanitizeHtml(text);
    context.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: "bio",
        text: sanitized,
        bio: sanitized,
        value: sanitized,
      }),
    );
  };

  return {
    id: context.id,
    bio: rawBio,
    notes: rawNotes,
    sanitizedBio: sanitizeHtml(rawBio),
    sanitizedNotes: sanitizeHtml(rawNotes),
    editNotes: handleEditNotes,
    editBio: handleEditBio,
    sanitize: sanitizeHtml,
  };
}

export interface ResourceBarOptions {
  label?: string;
  color?: string;
  [key: string]: unknown;
}

export interface ResourceBarOutput {
  id: string;
  current: number;
  max: number;
  temp: number;
  label?: string;
  color?: string;
  updateValue: (newValue: number) => void;
  setCurrent: (newValue: number) => void;
  modifyCurrent: (newValue: number) => void;
}

export function ResourceBar(context: WidgetRenderContext<ResourceBarOptions>): ResourceBarOutput {
  const current = Number(context.boundValues.current ?? 0);
  const max = Number(context.boundValues.max ?? 0);
  const temp = Number(context.boundValues.temp ?? 0);

  const handleUpdate = (newValue: number) => {
    context.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: "current",
        value: newValue,
        current: newValue,
      }),
    );
  };

  return {
    id: context.id,
    current,
    max,
    temp,
    label: context.options?.label,
    color: context.options?.color,
    updateValue: handleUpdate,
    setCurrent: handleUpdate,
    modifyCurrent: handleUpdate,
  };
}

export interface SkillItem {
  key: string;
  modifier: number;
  proficiencyLevel: string;
  passive: number;
}

export interface SkillCheckListOutput {
  id: string;
  skills: SkillItem[];
  clickSkill: (skillKey: string) => void;
  triggerSkillClick: (skillKey: string) => void;
}

export function SkillCheckList(context: WidgetRenderContext): SkillCheckListOutput {
  const rawSkills = (context.boundValues.skills as Record<string, unknown>) ?? {};
  const skills: SkillItem[] = Object.entries(rawSkills).map(([key, val]) => {
    let modifier = 0;
    let proficiencyLevel = "none";
    let passive = 10;
    if (typeof val === "number") {
      modifier = val;
      passive = 10 + modifier;
    } else if (val && typeof val === "object") {
      const rec = val as Record<string, unknown>;
      modifier = typeof rec.modifier === "number" ? rec.modifier : Number(rec.mod ?? 0);
      proficiencyLevel = typeof rec.proficiencyLevel === "string" ? rec.proficiencyLevel : "none";
      passive = typeof rec.passive === "number" ? rec.passive : 10 + modifier;
    }
    return { key, modifier, proficiencyLevel, passive };
  });

  const handleClick = (skillKey: string) => {
    const skill = skills.find((s) => s.key === skillKey);
    const mod = skill ? skill.modifier : 0;
    const formula = mod >= 0 ? `1d20 + ${mod}` : `1d20 - ${Math.abs(mod)}`;
    const expression = mod >= 0 ? `1d20+${mod}` : `1d20${mod}`;
    context.dispatchCommand?.(
      TrameCommand.RollDice({
        formula,
        expression,
        skill: skillKey,
        modifier: mod,
        visibility: "PUBLIC",
        reason: `Skill check: ${skillKey}`,
      }),
    );
  };

  return {
    id: context.id,
    skills,
    clickSkill: handleClick,
    triggerSkillClick: handleClick,
  };
}

export interface StatBlock6Options {
  displayOrder?: string[];
  [key: string]: unknown;
}

export interface StatBlock6Ability {
  key: string;
  score: number;
  modifier: number;
}

export interface StatBlock6Output {
  id: string;
  abilities: StatBlock6Ability[];
  clickAbility: (abilityKey: string) => void;
  triggerAbilityClick: (abilityKey: string) => void;
}

export function StatBlock6(context: WidgetRenderContext<StatBlock6Options>): StatBlock6Output {
  const displayOrder = context.options?.displayOrder ?? ["str", "dex", "con", "int", "wis", "cha"];
  const rawAbilities = (context.boundValues.abilities as Record<string, unknown>) ?? {};

  const abilities: StatBlock6Ability[] = displayOrder.map((key) => {
    const raw = rawAbilities[key];
    let score = 10;
    let modifier = 0;
    if (typeof raw === "number") {
      score = raw;
      modifier = Math.floor((score - 10) / 2);
    } else if (raw && typeof raw === "object") {
      const rec = raw as Record<string, unknown>;
      score = typeof rec.score === "number" ? rec.score : 10;
      if (typeof rec.modifier === "number") {
        modifier = rec.modifier;
      } else if (typeof rec.mod === "number") {
        modifier = rec.mod;
      } else {
        modifier = Math.floor((score - 10) / 2);
      }
    }
    return { key, score, modifier };
  });

  const handleAbilityClick = (abilityKey: string) => {
    const ability = abilities.find((a) => a.key === abilityKey);
    const mod = ability ? ability.modifier : 0;
    const formula = mod >= 0 ? `1d20 + ${mod}` : `1d20 - ${Math.abs(mod)}`;
    const expression = mod >= 0 ? `1d20+${mod}` : `1d20${mod}`;
    context.dispatchCommand?.(
      TrameCommand.RollDice({
        formula,
        expression,
        ability: abilityKey,
        modifier: mod,
        visibility: "PUBLIC",
        reason: `Ability check: ${abilityKey}`,
      }),
    );
  };

  return {
    id: context.id,
    abilities,
    clickAbility: handleAbilityClick,
    triggerAbilityClick: handleAbilityClick,
  };
}

export * from "./ArmorInitiativeSpeed.ts";
export * from "./AttackActionTable.ts";
export * from "./ConditionBadgeStrip.ts";
export * from "./FeatureTraitList.ts";
export * from "./HitDiceAndDeathSaves.ts";
export * from "./InventoryContainerTree.ts";
export * from "./SavingThrowList.ts";
export * from "./SpellbookAccordion.ts";

export * from "./ArmorInitiativeSpeedWidget.tsx";
export * from "./AttackActionTableWidget.tsx";
export * from "./ConditionBadgeStripWidget.tsx";
export * from "./FeatureTraitListWidget.tsx";
export * from "./HitDiceAndDeathSavesWidget.tsx";
export * from "./InventoryContainerTreeWidget.tsx";
export { NotesMarkdownPaneWidget, sanitizeHtml } from "./NotesMarkdownPaneWidget.tsx";
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
