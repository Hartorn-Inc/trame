import { TrameCommand } from "../types.ts";
import type { WidgetRenderContext } from "../WidgetRegistry.ts";

export interface AttackItem {
  id: string;
  name: string;
  attackBonus: number;
  damageFormula: string;
  damageType?: string;
  range?: string;
}

export interface AttackActionTableOutput {
  id: string;
  attacks: AttackItem[];
  clickAttack: (attackId: string) => void;
  triggerAttackRoll: (attackId: string) => void;
  clickDamage: (attackId: string) => void;
  triggerDamageRoll: (attackId: string) => void;
}

export function AttackActionTable(context: WidgetRenderContext): AttackActionTableOutput {
  const rawAttacks = Array.isArray(context.boundValues.attacks) ? context.boundValues.attacks : [];
  const attacks: AttackItem[] = rawAttacks.map((item: any) => ({
    id: String(item.id ?? ""),
    name: String(item.name ?? "Attack"),
    attackBonus: Number(item.attackBonus ?? 0),
    damageFormula: String(item.damageFormula ?? "1d6"),
    damageType: item.damageType ? String(item.damageType) : undefined,
    range: item.range ? String(item.range) : undefined,
  }));

  const handleAttack = (attackId: string) => {
    const attack = attacks.find((a) => a.id === attackId) ?? attacks[0];
    const bonus = attack ? attack.attackBonus : 0;
    const formula = bonus >= 0 ? `1d20 + ${bonus}` : `1d20 - ${Math.abs(bonus)}`;
    const expression = bonus >= 0 ? `1d20+${bonus}` : `1d20${bonus}`;
    context.dispatchCommand?.(
      TrameCommand.RollDice({
        formula,
        expression,
        attackId: attack?.id,
        attackBonus: bonus,
        name: attack?.name,
        visibility: "PUBLIC",
        reason: `Attack roll: ${attack?.name ?? attackId}`,
      }),
    );
  };

  const handleDamage = (attackId: string) => {
    const attack = attacks.find((a) => a.id === attackId) ?? attacks[0];
    const formula = attack ? attack.damageFormula : "1d6";
    context.dispatchCommand?.(
      TrameCommand.RollDice({
        formula,
        expression: formula,
        attackId: attack?.id,
        damageFormula: formula,
        name: attack?.name,
        visibility: "PUBLIC",
        reason: `Damage roll: ${attack?.name ?? attackId}`,
      }),
    );
  };

  return {
    id: context.id,
    attacks,
    clickAttack: handleAttack,
    triggerAttackRoll: handleAttack,
    clickDamage: handleDamage,
    triggerDamageRoll: handleDamage,
  };
}
