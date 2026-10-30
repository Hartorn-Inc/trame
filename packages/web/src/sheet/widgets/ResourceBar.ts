import { TrameCommand } from "../types.ts";
import type { WidgetRenderContext } from "../WidgetRegistry.ts";

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
