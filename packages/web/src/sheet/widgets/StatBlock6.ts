import { TrameCommand } from "../types.ts";
import type { WidgetRenderContext } from "../WidgetRegistry.ts";

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
