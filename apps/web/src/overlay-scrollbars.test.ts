// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installOverlayScrollbars } from "./overlay-scrollbars";

afterEach(() => vi.useRealTimers());

it("marks a scrolled element for one second, then lets its thumb fade", () => {
  vi.useFakeTimers();
  const remove = installOverlayScrollbars(document);
  const list = document.createElement("div");
  document.body.append(list);
  list.dispatchEvent(new Event("scroll"));
  expect(list.hasAttribute("data-scrolling")).toBe(true);
  vi.advanceTimersByTime(900);
  list.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(900);
  expect(list.hasAttribute("data-scrolling")).toBe(true);
  vi.advanceTimersByTime(200);
  expect(list.hasAttribute("data-scrolling")).toBe(false);
  remove();
  list.dispatchEvent(new Event("scroll"));
  expect(list.hasAttribute("data-scrolling")).toBe(false);
  list.remove();
});
