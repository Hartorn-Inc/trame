import { TrameCommand } from "../types.ts";
import type { WidgetRenderContext } from "../WidgetRegistry.ts";

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
