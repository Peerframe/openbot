import type { Bot } from "@openbot/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { GroupAvatar } from "./GroupAvatar";

const bot = (id: string, name: string): Bot => ({
  id,
  name,
  role: "",
  status: "idle",
  computerProfile: "none",
  createdAt: "2026-10-01T00:00:00.000Z",
});
const team = ["研究助理", "客服小橙", "发布助手", "设计评审", "运维值班"].map((name, index) =>
  bot(`b${index}`, name),
);
const heads = (html: string) => html.match(/class="robot-avatar/g)?.length ?? 0;

it("draws at most three heads with the documented layout per member count", () => {
  const render = (count: number) =>
    renderToStaticMarkup(<GroupAvatar name="市场周报" members={team.slice(0, count)} size={40} />);
  expect(render(0)).toContain("group-avatar-tile");
  expect(render(0)).toContain('aria-label="市场周报，还没有 Bot"');
  expect(heads(render(1))).toBe(1);
  expect(render(1)).toContain("group-avatar-badge is-hash");
  expect(heads(render(2))).toBe(2);
  expect(heads(render(3))).toBe(3);
  expect(heads(render(5))).toBe(2);
  expect(render(5)).toContain(">+3</span>");
  expect(render(3)).toContain('aria-label="市场周报，3 名 Bot：研究助理、客服小橙、发布助手"');
});

it("cuts out the front heads and keeps the first member in front", () => {
  const html = renderToStaticMarkup(
    <GroupAvatar name="频道" members={team.slice(0, 2)} size={40} />,
  );
  // The back head (second member) is drawn first without a cut-out; the first member last, cut out.
  expect(html.indexOf('aria-label="客服小橙，')).toBeLessThan(
    html.indexOf('aria-label="研究助理，'),
  );
  expect(html.match(/robot-cutout/g)?.length).toBe(1);
});

it("shows one 频道 dot from member work and moves only the Bot that works", () => {
  const statusOf = (member: Bot) => (member.id === "b1" ? "running" : "idle") as const;
  const html = renderToStaticMarkup(
    <GroupAvatar name="频道" members={team.slice(0, 2)} size={40} statusOf={statusOf} />,
  );
  expect(html).toContain("group-avatar-dot is-working");
  expect(html.match(/is-working"/g)?.length).toBe(2);
  const idle = renderToStaticMarkup(
    <GroupAvatar name="频道" members={team.slice(0, 2)} size={40} />,
  );
  expect(idle).not.toContain("group-avatar-dot");
  expect(idle).not.toContain("is-working");
  const waiting = renderToStaticMarkup(
    <GroupAvatar
      name="频道"
      members={team.slice(0, 1)}
      size={40}
      statusOf={() => "waiting_approval"}
    />,
  );
  expect(waiting).toContain("group-avatar-dot is-attention is-top");
});
