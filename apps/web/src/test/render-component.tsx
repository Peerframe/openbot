import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface RenderedComponent {
  container: HTMLDivElement;
  unmount(): Promise<void>;
}

export async function renderComponent(element: ReactNode): Promise<RenderedComponent> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    async unmount() {
      await unmount(root);
      container.remove();
    },
  };
}

export async function interact(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

export async function setInputValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  await interact(() => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter === undefined) throw new Error("Input value setter is unavailable.");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function unmount(root: Root): Promise<void> {
  await act(async () => root.unmount());
}
