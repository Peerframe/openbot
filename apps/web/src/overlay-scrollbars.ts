/**
 * LongLists rule: scrollbars stay out of the way until something scrolls. Every scroll marks the
 * scrolled element with `data-scrolling` for one second; `base.css` shows a 6px thumb only then
 * (and while the pointer is on it). One passive capture listener serves every scroll area.
 */
export function installOverlayScrollbars(target: Document = document): () => void {
  const timers = new WeakMap<Element, number>();
  const mark = (event: Event) => {
    const element =
      event.target instanceof Element
        ? event.target
        : event.target === target
          ? target.scrollingElement
          : null;
    if (!element) return;
    element.setAttribute("data-scrolling", "");
    window.clearTimeout(timers.get(element));
    timers.set(
      element,
      window.setTimeout(() => element.removeAttribute("data-scrolling"), 1000),
    );
  };
  target.addEventListener("scroll", mark, { capture: true, passive: true });
  return () => target.removeEventListener("scroll", mark, { capture: true });
}
