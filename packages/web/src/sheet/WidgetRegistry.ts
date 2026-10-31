import type { CommandDispatcher } from "./types.ts";
import { registerAllCanonicalWidgets } from "./widgets/index.ts";

export interface WidgetRenderContext<TOptions = Record<string, unknown>> {
  id: string;
  boundValues: Record<string, unknown>;
  options: TOptions;
  dispatchCommand?: CommandDispatcher;
}

export interface WidgetProps<TOptions = Record<string, unknown>> {
  id: string;
  boundValues: Record<string, unknown>;
  bindings?: Record<string, string>;
  options?: TOptions;
  isLocked?: boolean;
  dispatchCommand?: CommandDispatcher;
  actorId?: string;
  onCloseDrawer?: () => void;
  isTableCanvasMounted?: boolean;
}

export type WidgetComponent<TOptions = Record<string, unknown>, TOutput = unknown> = (
  context: WidgetRenderContext<TOptions>,
) => TOutput;

export interface WidgetImplementationObject<TOptions = Record<string, unknown>> {
  widgetType: string;
  render?: WidgetComponent<TOptions>;
  [key: string]: unknown;
}

export type WidgetImplementation =
  | WidgetComponent
  | WidgetImplementationObject
  | Record<string, unknown>
  | unknown;

/**
 * Extensible registry interface for atomic character sheet widgets.
 * Supports static singleton methods and isolated registry instances.
 */
export class WidgetRegistry {
  private static readonly defaultInstance = new WidgetRegistry();
  private readonly store = new Map<string, unknown>();

  public static register(widgetType: string, implementation: WidgetImplementation): void {
    WidgetRegistry.defaultInstance.register(widgetType, implementation);
  }

  public static get<T = unknown>(widgetType: string): T | undefined {
    return WidgetRegistry.defaultInstance.get<T>(widgetType);
  }

  public static has(widgetType: string): boolean {
    return WidgetRegistry.defaultInstance.has(widgetType);
  }

  public static unregister(widgetType: string): boolean {
    return WidgetRegistry.defaultInstance.unregister(widgetType);
  }

  public static clear(): void {
    WidgetRegistry.defaultInstance.clear();
  }

  public static getRegisteredTypes(): string[] {
    return WidgetRegistry.defaultInstance.getRegisteredTypes();
  }

  public static registerDefaults(): void {
    WidgetRegistry.defaultInstance.registerDefaults();
  }

  public registerDefaults(): void {
    registerAllCanonicalWidgets(this);
  }

  public register(widgetType: string, implementation: WidgetImplementation): void {
    if (!widgetType || typeof widgetType !== "string") {
      throw new Error(`Widget type must be a non-empty string, got: ${String(widgetType)}`);
    }
    this.store.set(widgetType, implementation);
  }

  public get<T = unknown>(widgetType: string): T | undefined {
    return this.store.get(widgetType) as T | undefined;
  }

  public has(widgetType: string): boolean {
    return this.store.has(widgetType);
  }

  public unregister(widgetType: string): boolean {
    return this.store.delete(widgetType);
  }

  public clear(): void {
    this.store.clear();
  }

  public getRegisteredTypes(): string[] {
    return Array.from(this.store.keys());
  }
}
