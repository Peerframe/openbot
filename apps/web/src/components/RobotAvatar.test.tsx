import type { Bot } from "@openbot/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RobotAvatar, robotVisualState } from "./RobotAvatar";

const bot: Bot = {
  id: "bot-1",
  name: "Ops",
  role: "运营",
  status: "idle",
  computerProfile: "docker-linux",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("RobotAvatar", () => {
  it("renders a frameless head with an accessible state", () => {
    const html = renderToStaticMarkup(<RobotAvatar bot={bot} status="waiting_approval" />);

    expect(html).toContain('viewBox="0 0 96 96"');
    expect(html).toContain("robot-state-approval");
    expect(html).toContain('aria-label="Ops，待批准"');
    expect(html).toContain('data-head="');
    expect(html).toContain('data-mobility="');
    expect(html).toContain("<rect");
    expect(html).not.toMatch(/<(?:linearGradient|image)\b/);
  });

  it("maps the stored head shape to Round, Relay and Scout with the accent on the jaw", () => {
    const heads = (["round", "square", "cat"] as const).map((head) =>
      renderToStaticMarkup(
        <RobotAvatar
          bot={{
            ...bot,
            appearance: {
              head,
              body: "classic",
              mobility: "feet",
              accessory: "none",
              accent: "blue",
            },
          }}
        />,
      ),
    );
    const [round, relay, scout] = heads;

    expect(round).toContain("robot-antenna");
    expect(relay).toContain('d="M11 52v9M85 52v9"');
    expect(scout).toContain('transform="rotate(-9 60 52.5)"');
    for (const html of heads) {
      expect(html).toMatch(/class="robot-jaw"[^>]*fill="#5F7CDE"/);
      expect(html).toContain("robot-eyes is-standard");
      expect(html).toContain("robot-eyes is-micro");
    }
  });

  it("keeps the stored appearance data that is no longer drawn", () => {
    const html = renderToStaticMarkup(
      <RobotAvatar
        bot={{
          ...bot,
          appearance: {
            head: "cat",
            body: "cape",
            mobility: "hover",
            accessory: "headphones",
            accent: "red",
          },
        }}
      />,
    );

    expect(html).toContain("robot-accent-red");
    expect(html).toContain('data-head="cat"');
    expect(html).toContain('data-body="cape"');
    expect(html).toContain('data-mobility="hover"');
    expect(html).toContain('data-accessory="headphones"');
  });

  it("normalizes run and bot statuses into a small visual vocabulary", () => {
    expect(robotVisualState("assigned")).toBe("queued");
    expect(robotVisualState("running")).toBe("running");
    expect(robotVisualState("human_takeover")).toBe("takeover");
    expect(robotVisualState("cancelled")).toBe("failed");
  });

  it("shows a status dot and working motion only when asked and only while working", () => {
    const working = renderToStaticMarkup(<RobotAvatar bot={bot} status="running" presence="dot" />);
    expect(working).toContain("is-working");
    expect(working).toContain('class="robot-dot is-working"');
    const waiting = renderToStaticMarkup(
      <RobotAvatar bot={bot} status="waiting_approval" presence="dot" />,
    );
    expect(waiting).toContain("robot-dot is-attention");
    expect(waiting).not.toContain("is-working");
    expect(
      renderToStaticMarkup(<RobotAvatar bot={bot} status="idle" presence="dot" />),
    ).not.toContain("robot-dot");
    expect(renderToStaticMarkup(<RobotAvatar bot={bot} status="running" />)).not.toMatch(
      /is-working|robot-dot/,
    );
    expect(
      renderToStaticMarkup(<RobotAvatar bot={bot} status="running" presence="motion" />),
    ).toMatch(/^(?!.*robot-dot).*is-working/s);
  });

  it("draws a silhouette cut-out only when overlapping", () => {
    expect(renderToStaticMarkup(<RobotAvatar bot={bot} cutout />)).toContain("robot-cutout");
    expect(renderToStaticMarkup(<RobotAvatar bot={bot} />)).not.toContain("robot-cutout");
  });
});
