/**
 * Resolves dot-separated data binding paths across actor sheet state and derived stats.
 * Traverses paths safely without throwing runtime exceptions for missing keys or null intermediates.
 */
export class BindingResolver {
  public static resolve<T = unknown>(state: unknown, path: string): T | null {
    if (!path || typeof path !== "string" || state === null || state === undefined) {
      return null;
    }

    const trimmed = path.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const segments = trimmed.split(".");

    const directResult = BindingResolver.traverse(state, segments);
    if (directResult !== undefined) {
      return directResult as T;
    }

    if (typeof state === "object" && state !== null) {
      const record = state as Record<string, unknown>;
      if ("sheet" in record && record.sheet !== null && typeof record.sheet === "object") {
        const sheetResult = BindingResolver.traverse(record.sheet, segments);
        if (sheetResult !== undefined) {
          return sheetResult as T;
        }
      }
      if ("derived" in record && record.derived !== null && typeof record.derived === "object") {
        const derivedResult = BindingResolver.traverse(record.derived, segments);
        if (derivedResult !== undefined) {
          return derivedResult as T;
        }
      }
    }

    return null;
  }

  private static traverse(target: unknown, segments: string[]): unknown {
    let current: unknown = target;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg) {
        return undefined;
      }

      if (current === null || current === undefined) {
        return undefined;
      }

      if (typeof current !== "object" && typeof current !== "function") {
        return undefined;
      }

      const record = current as Record<string, unknown>;
      if (!(seg in record)) {
        return undefined;
      }

      current = record[seg];
    }

    return current;
  }

  public static resolveBindings(
    state: unknown,
    bindings: Record<string, string>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (!bindings || typeof bindings !== "object") {
      return result;
    }
    for (const [key, path] of Object.entries(bindings)) {
      result[key] = BindingResolver.resolve(state, path);
    }
    return result;
  }
}
