export class BindingResolver {
  public static resolve(state: unknown, path: string): unknown {
    if (state === null || typeof state !== "object" || typeof path !== "string") {
      return null;
    }
    const cleanPath = path.trim();
    if (!cleanPath) {
      return null;
    }

    const resolveDirect = (
      target: unknown,
      segments: string[],
    ): { found: boolean; value: unknown } => {
      let current: unknown = target;
      for (const seg of segments) {
        if (current === null || current === undefined || typeof current !== "object") {
          return { found: false, value: null };
        }
        if (!(seg in (current as Record<string, unknown>))) {
          return { found: false, value: null };
        }
        current = (current as Record<string, unknown>)[seg];
      }
      return { found: true, value: current };
    };

    const segments = cleanPath.split(".");
    const direct = resolveDirect(state, segments);
    if (direct.found) {
      return direct.value;
    }

    const stateObj = state as Record<string, unknown>;
    if (stateObj.sheet && typeof stateObj.sheet === "object") {
      const sheetDirect = resolveDirect(stateObj.sheet, segments);
      if (sheetDirect.found) {
        return sheetDirect.value;
      }
    }

    if (stateObj.derived && typeof stateObj.derived === "object") {
      const derivedDirect = resolveDirect(stateObj.derived, segments);
      if (derivedDirect.found) {
        return derivedDirect.value;
      }
    }

    return null;
  }

  public static resolveBindings(
    state: unknown,
    bindings: Record<string, string>,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    if (!bindings || typeof bindings !== "object") {
      return resolved;
    }
    for (const [key, path] of Object.entries(bindings)) {
      resolved[key] = BindingResolver.resolve(state, path);
    }
    return resolved;
  }
}
