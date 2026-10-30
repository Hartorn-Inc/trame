import { TrameCommand } from "../types.ts";
import type { WidgetRenderContext } from "../WidgetRegistry.ts";

export interface ArmorInitiativeSpeedOutput {
  id: string;
  armorClass: number;
  initiative: number;
  speed: string | number | Record<string, number>;
  clickInitiative: () => void;
  triggerInitiativeClick: () => void;
}

export function ArmorInitiativeSpeed(context: WidgetRenderContext): ArmorInitiativeSpeedOutput {
  const armorClass = Number(context.boundValues.armorClass ?? 10);
  const initiative = Number(context.boundValues.initiative ?? 0);
  const speed = (context.boundValues.speed as string | number | Record<string, number>) ?? 30;

  const handleInitiative = () => {
    const formula = initiative >= 0 ? `1d20 + ${initiative}` : `1d20 - ${Math.abs(initiative)}`;
    const expression = initiative >= 0 ? `1d20+${initiative}` : `1d20${initiative}`;
    context.dispatchCommand?.(
      TrameCommand.RollDice({
        formula,
        expression,
        initiative,
        visibility: "PUBLIC",
        reason: "Initiative check",
      }),
    );
  };

  return {
    id: context.id,
    armorClass,
    initiative,
    speed,
    clickInitiative: handleInitiative,
    triggerInitiativeClick: handleInitiative,
  };
}
