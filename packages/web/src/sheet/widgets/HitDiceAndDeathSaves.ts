import { TrameCommand } from "../types.ts";
import type { WidgetRenderContext } from "../WidgetRegistry.ts";

export interface HitDiceAndDeathSavesOutput {
  id: string;
  hitDiceCurrent: number;
  hitDiceMax: number;
  hitDieSides: number;
  conModifier: number;
  deathSuccesses: number;
  deathFailures: number;
  spendHitDie: () => void;
  rollDeathSave: (rollResult?: number) => void;
  evaluateDeathSaveResult: (rollResult: number) => void;
}

export function HitDiceAndDeathSaves(context: WidgetRenderContext): HitDiceAndDeathSavesOutput {
  const hitDiceCurrent = Number(context.boundValues.hitDiceCurrent ?? 0);
  const hitDiceMax = Number(context.boundValues.hitDiceMax ?? 0);
  const hitDieSides = Number(context.boundValues.hitDieSides ?? 8);
  const conModifier = Number(context.boundValues.conModifier ?? 0);
  const deathSuccesses = Number(context.boundValues.deathSuccesses ?? 0);
  const deathFailures = Number(context.boundValues.deathFailures ?? 0);
  const currentHp = Number(context.boundValues.hpCurrent ?? 0);

  const spendHitDie = () => {
    const formula = conModifier >= 0 ? `1d${hitDieSides} + ${conModifier}` : `1d${hitDieSides} - ${Math.abs(conModifier)}`;
    const expression = conModifier >= 0 ? `1d${hitDieSides}+${conModifier}` : `1d${hitDieSides}${conModifier}`;
    context.dispatchCommand?.(
      TrameCommand.RollDice({
        formula,
        expression,
        hitDieSides,
        conModifier,
        visibility: "PUBLIC",
        reason: "Spend Hit Die",
      }),
    );
    context.dispatchCommand?.(
      TrameCommand.UpdateActorSheet({
        path: "hitDiceCurrent",
        hitDiceCurrent: hitDiceCurrent - 1,
        value: hitDiceCurrent - 1,
      }),
    );
  };

  const evaluateDeathSaveResult = (rollResult: number) => {
    if (rollResult === 1) {
      const nextFailures = Math.min(3, deathFailures + 2);
      const isDeceased = nextFailures >= 3;
      context.dispatchCommand?.(
        TrameCommand.UpdateActorSheet({
          path: "deathFailures",
          deathFailures: nextFailures,
          value: nextFailures,
          increment: 2,
          ...(isDeceased ? { condition: "deceased", status: "deceased" } : {}),
        }),
      );
    } else if (rollResult >= 2 && rollResult <= 9) {
      const nextFailures = Math.min(3, deathFailures + 1);
      const isDeceased = nextFailures >= 3;
      context.dispatchCommand?.(
        TrameCommand.UpdateActorSheet({
          path: "deathFailures",
          deathFailures: nextFailures,
          value: nextFailures,
          increment: 1,
          ...(isDeceased ? { condition: "deceased", status: "deceased" } : {}),
        }),
      );
    } else if (rollResult >= 10 && rollResult <= 19) {
      const nextSuccesses = Math.min(3, deathSuccesses + 1);
      const isStable = nextSuccesses >= 3;
      context.dispatchCommand?.(
        TrameCommand.UpdateActorSheet({
          path: "deathSuccesses",
          deathSuccesses: nextSuccesses,
          value: nextSuccesses,
          increment: 1,
          ...(isStable ? { condition: "stable", status: "stable" } : {}),
        }),
      );
    } else if (rollResult === 20) {
      context.dispatchCommand?.(
        TrameCommand.UpdateActorSheet({
          path: "hp.current",
          deathSuccesses: 0,
          deathFailures: 0,
          hpCurrent: Math.max(1, currentHp + 1),
          currentHp: Math.max(1, currentHp + 1),
          value: Math.max(1, currentHp + 1),
          condition: "stable",
          status: "stable",
        }),
      );
    }
  };

  const rollDeathSave = (rollResult?: number) => {
    context.dispatchCommand?.(
      TrameCommand.RollDice({
        formula: "1d20",
        expression: "1d20",
        result: rollResult,
        visibility: "PUBLIC",
        reason: "Death Saving Throw",
      }),
    );
    if (rollResult !== undefined) {
      evaluateDeathSaveResult(rollResult);
    }
  };

  return {
    id: context.id,
    hitDiceCurrent,
    hitDiceMax,
    hitDieSides,
    conModifier,
    deathSuccesses,
    deathFailures,
    spendHitDie,
    rollDeathSave,
    evaluateDeathSaveResult,
  };
}
