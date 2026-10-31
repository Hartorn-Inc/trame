import { useEffect as preactUseEffect, useRef as preactUseRef, useState as preactUseState } from 'preact/hooks';

export function useSafeState<T>(initialValue: T): [T, (updater: T | ((prev: T) => T)) => void] {
  try {
    return preactUseState<T>(initialValue);
  } catch {
    let val = initialValue;
    const setVal = (updater: T | ((prev: T) => T)) => {
      val = typeof updater === 'function' ? (updater as (prev: T) => T)(val) : updater;
    };
    return [val, setVal];
  }
}

export function useSafeRef<T>(initialValue: T): { current: T } {
  try {
    return preactUseRef<T>(initialValue);
  } catch {
    return { current: initialValue };
  }
}

export function useSafeEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
  try {
    preactUseEffect(effect, deps);
  } catch {
    // Direct invocation outside of Preact render context
  }
}
