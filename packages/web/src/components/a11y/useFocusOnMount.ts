import { useLayoutEffect } from "preact/hooks";

/**
 * Focuses `ref` once when the component mounts. Views use it on their `h1`
 * (rendered with `tabIndex={-1}`) so a screen change moves keyboard and
 * screen-reader users to the new content instead of leaving focus on a node
 * that just unmounted (WCAG 2.4.3).
 */
export function useFocusOnMount(ref: { readonly current: HTMLElement | null }): void {
  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);
}
