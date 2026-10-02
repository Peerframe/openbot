import type { Bot, BotAppearance, BotStatus, RunStatus } from "@openbot/domain";
import { GroupAvatar } from "../components/GroupAvatar";
import { RobotAvatar } from "../components/RobotAvatar";

/*
 * Specimen sheets for the Avatars and GroupAvatars artboards (design preview only). They render the
 * product components so the drawing, sizes, cut-out, status dot and motion can be compared.
 */

const heads: Array<[BotAppearance["head"], string]> = [
  ["round", "圆顶 Round"],
  ["square", "耳罩 Relay"],
  ["cat", "猫耳 Scout"],
];
const accents: BotAppearance["accent"][] = ["green", "blue", "yellow", "red"];

const specimen = (
  id: string,
  name: string,
  head: BotAppearance["head"],
  accent: BotAppearance["accent"],
  status: BotStatus = "idle",
): Bot => ({
  id,
  name,
  role: "",
  status,
  computerProfile: "none",
  appearance: { head, body: "classic", mobility: "feet", accessory: "none", accent },
  createdAt: "2026-10-01T00:00:00.000Z",
});

export function AvatarSpecimens() {
  const states: Array<
    [string, BotAppearance["head"], BotAppearance["accent"], RunStatus | BotStatus]
  > = [
    ["待命 · 无圆点", "round", "green", "idle"],
    ["工作中", "round", "green", "running"],
    ["工作中", "square", "blue", "running"],
    ["工作中", "cat", "yellow", "running"],
    ["需要你确认", "square", "red", "waiting_approval"],
    ["离线", "cat", "green", "offline"],
  ];
  return (
    <main className="design-preview-sheet">
      <h1>头像系统 v3</h1>
      <section className="design-preview-card">
        {heads.map(([head, title]) => (
          <div className="design-preview-row" key={head}>
            <strong>{title}</strong>
            {accents.map((accent) => (
              <RobotAvatar
                key={accent}
                bot={specimen(`${head}-${accent}`, title, head, accent)}
                className="design-preview-56"
              />
            ))}
          </div>
        ))}
      </section>
      <section className="design-preview-card">
        <div className="design-preview-row is-baseline">
          {[96, 72, 40, 32, 24, 20, 16].map((size) => (
            <span key={size} className="design-preview-cell">
              <RobotAvatar
                bot={specimen(`s${size}`, "尺寸", "round", "green")}
                className={`design-preview-${size}`}
              />
              <small>{size < 32 ? `${size} 小` : size}</small>
            </span>
          ))}
        </div>
      </section>
      <section
        className="design-preview-card"
        style={{ ["--avatar-surface" as string]: "#f0f0f2" }}
      >
        <div className="design-preview-row is-baseline">
          {states.map(([label, head, accent, status], index) => (
            <span key={`${label}-${head}`} className="design-preview-cell">
              <RobotAvatar
                bot={specimen(`st${index}`, label, head, accent)}
                status={status}
                presence="dot"
                className="design-preview-64"
              />
              <small>{label}</small>
            </span>
          ))}
        </div>
      </section>
    </main>
  );
}

export function GroupSpecimens() {
  const team = [
    specimen("g1", "研究助理", "round", "green"),
    specimen("g2", "客服小橙", "cat", "yellow"),
    specimen("g3", "发布助手", "square", "blue"),
    specimen("g4", "设计评审", "square", "red"),
    specimen("g5", "运维值班", "round", "blue"),
    specimen("g6", "数据助理", "round", "red"),
  ];
  const counts = [0, 1, 2, 3, 6];
  const contexts: Array<[string, number, string]> = [
    ["侧栏 40", 40, "#f5f5f6"],
    ["选中行 40", 40, "#e6e6e8"],
    ["标题胶囊 26", 26, "#e6e6e8"],
    ["右栏身份 84", 84, "#fafafa"],
  ];
  return (
    <main className="design-preview-sheet">
      <h1>群组头像</h1>
      <table className="design-preview-matrix">
        <thead>
          <tr>
            <th>场景 / 人数</th>
            {counts.map((count) => (
              <th key={count}>{count === 6 ? "4 名及以上" : `${count} 名`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {contexts.map(([label, size, surface]) => (
            <tr
              key={label}
              style={{ background: surface, ["--avatar-surface" as string]: surface }}
            >
              <th>{label}</th>
              {counts.map((count) => (
                <td key={count}>
                  <GroupAvatar
                    name="市场周报"
                    members={team.slice(0, count)}
                    size={size}
                    statusOf={(bot) => (count === 2 && bot.id === "g1" ? "running" : "idle")}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
