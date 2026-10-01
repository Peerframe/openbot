// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { deferred, interact, renderComponent } from "../test/render-component";
import { MessageReactions } from "./MessageReactions";

describe("message reaction and removal controls", () => {
  it("marks my existing choice and disables duplicate writes until the Server responds", async () => {
    const result = deferred<void>(),
      onChange = vi.fn(() => result.promise);
    const view = await renderComponent(
      <MessageReactions
        messageId="message"
        reactions={[{ messageId: "message", emoji: "👍", actor: "owner" }]}
        onChange={onChange}
      />,
    );
    const chip = view.container.querySelector("button") as HTMLButtonElement;
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    await interact(() => chip.click());
    expect(onChange).toHaveBeenCalledWith("👍", false);
    expect(chip.disabled).toBe(true);
    await interact(() => result.reject(new Error("Save failed")));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("Save failed");
    expect(chip.disabled).toBe(false);
    await view.unmount();
  });
});
