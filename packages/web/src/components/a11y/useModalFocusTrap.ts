/**
 * ============================================================================
 * MODAL FOCUS TRAP & FOCUS RESTORATION (useModalFocusTrap.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Gives every `role="dialog"` / `aria-modal="true"` surface the same keyboard
 * contract (WCAG 2.2 SC 2.1.2, 2.4.3): focus enters the dialog when it opens,
 * `Tab` / `Shift+Tab` cycle inside it, `Escape` closes it, and focus returns
 * to the element that opened it when the dialog closes.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Document-Level Capture`:
 *    - `keydown` is handled on `document` in the capture phase, not on the
 *      dialog root. When the focused control becomes `disabled` or unmounts,
 *      the browser moves focus to `<body>`; a dialog-scoped handler would then
 *      never see `Tab` or `Escape` and the keyboard user would be stranded.
 * 2. `Focus-In Guard`:
 *    - A capture `focusin` listener pulls focus that lands outside the dialog
 *      (programmatic focus, assistive-tech navigation) back to its first
 *      focusable control.
 * 3. `Inert Background`:
 *    - Every sibling along the path from the dialog up to `<body>` receives
 *      `inert` while the dialog is open, so pointer, Tab and virtual-cursor
 *      navigation cannot reach the page behind the backdrop. Only attributes
 *      added by this hook are removed on close.
 * 4. `Synchronous Initial Focus`:
 *    - Initial focus runs in `useLayoutEffect`, right after the DOM commit, so
 *      callers that inspect `document.activeElement` after opening see it.
 * 5. `Disabled Controls Excluded`:
 *    - Natively `disabled` controls and `tabindex="-1"` nodes are never trap
 *      endpoints. `aria-disabled` controls stay focusable on purpose, which is
 *      why dialogs prefer `aria-disabled` for buttons that may hold focus.
 *
 * EXECUTION LIFECYCLE:
 * -----
 * `useModalFocusTrap(dialogRef, { onEscape })`
 * ├── 1. Layout effect: remember the trigger, inert the background, focus the
 * │      first control, attach capture `keydown` + `focusin` on `document`.
 * ├── 2. `keydown(Escape)` -> `onEscape()`; `keydown(Tab)` -> wrap first <-> last.
 * ├── 3. `focusin` outside the dialog -> refocus the first control.
 * └── 4. Cleanup: detach listeners, restore `inert`, refocus the trigger.
 * ============================================================================
 */
import { useLayoutEffect, useRef } from "preact/hooks";

const FOCUSABLE_TAGS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A"]);

type FocusableNode = HTMLElement & { disabled?: boolean };

/** Options for `useModalFocusTrap`. */
export interface ModalFocusTrapOptions {
  /** Invoked on `Escape`; the latest callback is always used. Omit to ignore `Escape`. */
  onEscape?: () => void;
}

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
 * Marks every element sibling on the path from `dialog` to `<body>` as
 * `inert` and returns the nodes it changed, so cleanup only undoes its own work.
 */
export function inertBackground(dialog: HTMLElement): Element[] {
  const changed: Element[] = [];
  const body = typeof document !== "undefined" ? document.body : null;
  let node: Node | null = dialog;
  while (node && node !== body && node.parentNode) {
    for (const sibling of Array.from(node.parentNode.childNodes)) {
      if (sibling === node || sibling.nodeType !== 1) continue;
      const el = sibling as Element;
      if (!el.hasAttribute("inert")) {
        el.setAttribute("inert", "");
        changed.push(el);
      }
    }
    node = node.parentNode;
  }
  return changed;
}

/** Traps focus and `Escape` inside the dialog referenced by `dialogRef` while it is mounted. */
export function useModalFocusTrap(
  dialogRef: { readonly current: HTMLElement | null },
  options: ModalFocusTrapOptions = {},
): void {
  const onEscapeRef = useRef(options.onEscape);
  onEscapeRef.current = options.onEscape;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const trigger = activeElement();
    const inerted = dialog ? inertBackground(dialog) : [];

    const focusFirst = () => {
      (getFocusableElements(dialogRef.current)[0] ?? dialogRef.current)?.focus();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onEscapeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const current = dialogRef.current;
      const focusables = getFocusableElements(current);
      if (focusables.length === 0) {
        event.preventDefault();
        current?.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = activeElement();
      const outside = !active || !current?.contains(active);
      if (event.shiftKey && (outside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (outside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      const current = dialogRef.current;
      const target = event.target as Node | null;
      if (current && target && !current.contains(target)) {
        focusFirst();
      }
    };

    focusFirst();
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      for (const el of inerted) el.removeAttribute("inert");
      if (trigger && typeof trigger.focus === "function") {
        trigger.focus();
      }
    };
  }, []);
}
