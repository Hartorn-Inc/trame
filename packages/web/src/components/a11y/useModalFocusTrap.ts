/**
 * ============================================================================
 * MODAL FOCUS TRAP & FOCUS RESTORATION (useModalFocusTrap.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Gives every `role="dialog"` / `aria-modal="true"` surface the same keyboard
 * contract (WCAG 2.2 SC 2.1.2, 2.4.3): focus enters the dialog when it opens,
 * `Tab` / `Shift+Tab` cycle inside it, and focus returns to the element that
 * opened it when the dialog closes. Without it, keyboard users tab into the
 * page behind the backdrop and lose their place on close.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Synchronous Initial Focus`:
 *    - Initial focus runs in `useLayoutEffect`, i.e. right after the DOM
 *      commit and before paint. A deferred `useEffect` raced against callers
 *      (and tests) that inspect `document.activeElement` right after opening.
 * 2. `Trigger Restoration`:
 *    - The element focused before opening is captured once and refocused on
 *      unmount, so closing with `Escape`, a close button, or a save all land
 *      the user back on the opener.
 * 3. `Disabled Controls Excluded`:
 *    - Disabled controls and `tabindex="-1"` nodes are never trap endpoints,
 *      matching the browser's own sequential focus order.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `useModalFocusTrap(dialogRef)`
 * ├── 1. Layout effect: remember `document.activeElement`, focus first control.
 * ├── 2. `onKeyDown(Tab)`: wrap first <-> last focusable inside `dialogRef`.
 * └── 3. Cleanup: refocus the remembered trigger.
 * ============================================================================
 */
import { useLayoutEffect } from "preact/hooks";

const FOCUSABLE_TAGS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A"]);

type FocusableNode = HTMLElement & { disabled?: boolean };

function activeElement(): HTMLElement | null {
  return typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
}

/**
 * Lists keyboard-focusable descendants of `container` in document order.
 *
 * Walks `childNodes` instead of using `querySelectorAll` with a complex
 * selector so the same code runs against lightweight DOM doubles in tests.
 */
export function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  const found: HTMLElement[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 1) {
      const el = node as FocusableNode;
      const tabIndex = el.getAttribute("tabindex");
      const focusable = FOCUSABLE_TAGS.has(el.nodeName.toUpperCase()) || (tabIndex !== null && tabIndex !== "-1");
      const disabled = Boolean(el.disabled) || el.getAttribute("disabled") === "true";
      if (focusable && !disabled && tabIndex !== "-1") {
        found.push(el);
      }
    }
    for (const child of Array.from(node.childNodes ?? [])) {
      walk(child);
    }
  };
  if (container) walk(container);
  return found;
}

/**
 * Traps keyboard focus inside the dialog referenced by `dialogRef` while it is
 * mounted, and returns the `keydown` handler to attach to the dialog root.
 */
export function useModalFocusTrap(dialogRef: { readonly current: HTMLElement | null }): (event: KeyboardEvent) => void {
  useLayoutEffect(() => {
    const trigger = activeElement();
    const focusables = getFocusableElements(dialogRef.current);
    (focusables[0] ?? dialogRef.current)?.focus();
    return () => {
      if (trigger && typeof trigger.focus === "function") {
        trigger.focus();
      }
    };
  }, []);

  return (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    const focusables = getFocusableElements(dialog);
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = activeElement();
    const outside = !active || !dialog?.contains(active);
    if (event.shiftKey && (outside || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (outside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  };
}
