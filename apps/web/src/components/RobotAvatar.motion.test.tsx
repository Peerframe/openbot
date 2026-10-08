// @vitest-environment jsdom
import type { Bot } from "@openbot/domain";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RobotAvatar } from "./RobotAvatar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot: Bot = {
  id: "bot-old",
  name: "Ops",
  role: "运营",
  status: "idle",
  computerProfile: "model",
  createdAt: "2026-01-01T00:00:00.000Z",
  appearance: {
    head: "round",
    body: "classic",
    mobility: "feet",
    accessory: "none",
    accent: "green",
  },
};

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

it("bursts the old head into particles that gather into the new look, then settles", async () => {
  vi.useFakeTimers();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RobotAvatar bot={bot} />));
  const avatar = () => container.querySelector(".robot-avatar");
  expect(avatar()?.classList).not.toContain("is-morph");
  expect(container.querySelector(".robot-particles")).toBeNull();

  const restyled: Bot = {
    ...bot,
    appearance: {
      ...(bot.appearance as NonNullable<Bot["appearance"]>),
      head: "cat",
      accent: "violet",
    },
  };
  await act(async () => root.render(<RobotAvatar bot={restyled} />));
  expect(avatar()?.classList).toContain("is-morph");
  expect(avatar()?.getAttribute("data-head")).toBe("cat");
  expect(container.querySelector(".robot-ghost")).not.toBeNull();
  expect(container.querySelectorAll(".robot-particles")).toHaveLength(2);

  await act(async () => vi.advanceTimersByTime(1_000));
  expect(avatar()?.classList).not.toContain("is-morph");
  expect(container.querySelector(".robot-ghost, .robot-particles")).toBeNull();
  await act(async () => root.unmount());
});

it("plays the birth only for a Bot created moments ago", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const born: Bot = { ...bot, id: "bot-new", createdAt: new Date().toISOString() };
  await act(async () =>
    root.render(
      <>
        <RobotAvatar bot={born} />
        <RobotAvatar bot={bot} />
      </>,
    ),
  );
  const [fresh, old] = Array.from(container.querySelectorAll(".robot-avatar"));
  expect(fresh?.classList).toContain("is-born");
  expect(fresh?.querySelector(".robot-particles.is-gather")).not.toBeNull();
  expect(old?.classList).not.toContain("is-born");
  await act(async () => root.unmount());
});

it("drops the 主 Bot crown on once when crowned, and fades it out when it moves away", async () => {
  vi.useFakeTimers();
  const crowned: Bot = { ...bot, id: "bot-crowned" };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const avatar = () => container.querySelector(".robot-avatar");
  await act(async () => root.render(<RobotAvatar bot={crowned} crown />));
  // A Bot first seen crowned shows the crown without the drop.
  expect(avatar()?.classList).toContain("is-crowned");
  expect(avatar()?.classList).not.toContain("is-crowning");
  expect(avatar()?.getAttribute("aria-label")).toBe("Ops，主 Bot，待命");
  // One standard and one micro placement; CSS picks one by the rendered size.
  expect(container.querySelectorAll(".robot-crown-at")).toHaveLength(2);

  await act(async () => root.render(<RobotAvatar bot={crowned} crown={false} />));
  expect(avatar()?.classList).toContain("is-uncrowning");
  expect(container.querySelector(".robot-crown.is-leaving")).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(400));
  expect(container.querySelector(".robot-crown")).toBeNull();
  expect(avatar()?.getAttribute("aria-label")).toBe("Ops，待命");

  await act(async () => root.render(<RobotAvatar bot={crowned} crown />));
  expect(avatar()?.classList).toContain("is-crowning");
  // The sidebar moves the 主 Bot row to the top, mounting a new avatar mid-change: it still drops.
  await act(async () => vi.advanceTimersByTime(200));
  await act(async () =>
    root.render(
      <div key="moved">
        <RobotAvatar bot={crowned} crown />
      </div>,
    ),
  );
  expect(avatar()?.classList).toContain("is-crowning");
  await act(async () => vi.advanceTimersByTime(600));
  expect(avatar()?.classList).not.toContain("is-crowning");
  expect(avatar()?.classList).toContain("is-crowned");
  // Avatars that do not show 主 Bot (a channel header, say) never read as a change.
  await act(async () =>
    root.render(
      <div key="moved">
        <RobotAvatar bot={crowned} crown />
        <RobotAvatar bot={crowned} />
      </div>,
    ),
  );
  expect(container.querySelector(".is-crowning, .is-uncrowning")).toBeNull();
  await act(async () => root.unmount());
});
