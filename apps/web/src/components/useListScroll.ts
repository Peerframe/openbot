// Hook for popover lists past eight rows: scroll inside, fade edges with hidden rows, and keep the
// keyboard selection in view (LongLists rule).
import { useEffect, useLayoutEffect, useState } from "react";

/**
 * LongLists popover rule: a list taller than eight rows scrolls inside itself. The edges fade only
 * where more rows are hidden (`data-more-above` / `data-more-below`), and the keyboard selection
 * (`aria-selected="true"`) is kept in view as ↑ ↓ move it. Returns a callback ref, so lists that
 * mount only while open still get it.
 */
export function useListScroll(activeKey: string | number | undefined) {
  const [list, setList] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!list) return;
    const update = () => {
      list.toggleAttribute("data-more-above", list.scrollTop > 1);
      list.toggleAttribute(
        "data-more-below",
        list.scrollHeight - list.scrollTop - list.clientHeight > 1,
      );
    };
    update();
    list.addEventListener("scroll", update, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    resize?.observe(list);
    const rows = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(update);
    rows?.observe(list, { childList: true });
    return () => {
      list.removeEventListener("scroll", update);
      resize?.disconnect();
      rows?.disconnect();
    };
  }, [list]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new active row must be revealed.
  useLayoutEffect(() => {
    list
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [list, activeKey]);
  return setList;
}
