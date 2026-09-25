import type { Bot, BotAppearance, CreateBotInput, ModelSelection } from "@openbot/domain";
import { useState } from "react";
import type { ApiError } from "../api";
import { CloseIcon } from "./Icons";
import { ModelSelector } from "./ModelSelector";
import { defaultBotAppearance, RobotAvatar } from "./RobotAvatar";
import { useModalDialog } from "./useModalDialog";

const computerOptions: Array<{ value: Bot["computerProfile"]; label: string }> = [
  { value: "model", label: "模型对话（无需电脑）" },
  { value: "none", label: "暂不绑定电脑" },
  { value: "docker-linux", label: "Docker Linux" },
  { value: "macos-cua", label: "macOS · Cua" },
  { value: "lume-vm", label: "Lume macOS VM" },
  { value: "coder", label: "Coder runtime" },
];

const appearanceOptions = {
  head: [
    { value: "round", label: "圆角头盔" },
    { value: "square", label: "方形头盔" },
    { value: "cat", label: "猫耳头盔" },
  ],
  body: [
    { value: "classic", label: "基础款" },
    { value: "tall", label: "长身款" },
    { value: "cape", label: "披风款" },
    { value: "armor", label: "装甲款" },
    { value: "storage", label: "收纳款" },
    { value: "quadruped", label: "四足款" },
  ],
  mobility: [
    { value: "feet", label: "双脚" },
    { value: "single-wheel", label: "单轮" },
    { value: "dual-wheel", label: "双轮" },
    { value: "hover", label: "悬浮" },
    { value: "four-legs", label: "四足" },
  ],
  accessory: [
    { value: "none", label: "无配件" },
    { value: "headphones", label: "耳机" },
    { value: "backpack", label: "背包" },
    { value: "trench", label: "斗篷" },
    { value: "arm", label: "机械臂" },
    { value: "toolbox", label: "工具箱" },
  ],
  accent: [
    { value: "green", label: "绿色" },
    { value: "yellow", label: "黄色" },
    { value: "red", label: "红色" },
    { value: "blue", label: "蓝色" },
  ],
} as const;

export function CreateBotDialog({
  onClose,
  onCreate,
  onImport,
  onManageModels,
  modelServicesVersion,
}: {
  onClose(): void;
  onCreate(input: CreateBotInput): Promise<void>;
  onImport(): void;
  onManageModels?: (() => void) | undefined;
  modelServicesVersion?: number | undefined;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [computerProfile, setComputerProfile] = useState<Bot["computerProfile"]>("none");
  const [appearance, setAppearance] = useState<BotAppearance>(defaultBotAppearance);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [modelValid, setModelValid] = useState(false);
  const selectsModel = computerProfile === "model" || computerProfile === "docker-linux";
  const { dialogRef, closeDialog } = useModalDialog(onClose);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onCreate({
        name,
        role,
        computerProfile,
        appearance,
        ...(selectsModel && model ? { model } : {}),
      });
    } catch (cause) {
      setError((cause as ApiError).message ?? "无法创建 Bot。请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop">
      <dialog ref={dialogRef} className="create-dialog" aria-labelledby="create-bot-title">
        <form onSubmit={submit}>
          <header className="dialog-header">
            <div>
              <h2 id="create-bot-title">创建 Bot</h2>
              <p>创建一个持久的数字员工。</p>
            </div>
            <button className="icon-button" type="button" aria-label="关闭" onClick={closeDialog}>
              <CloseIcon />
            </button>
          </header>
          <section className="bot-identity-builder" aria-label="Bot 外观组合">
            <div className="bot-preview">
              <RobotAvatar
                bot={{
                  id: "preview",
                  name: name.trim() || "新 Bot",
                  role: role.trim() || "数字员工",
                  status: "idle",
                  computerProfile,
                  appearance,
                  createdAt: new Date(0).toISOString(),
                }}
              />
              <div>
                <strong>{name.trim() || "新 Bot"}</strong>
                <span>五层组合身份</span>
              </div>
            </div>
            <div className="appearance-grid">
              <AppearanceSelect
                label="头部"
                value={appearance.head}
                options={appearanceOptions.head}
                onChange={(head) => setAppearance((current) => ({ ...current, head }))}
              />
              <AppearanceSelect
                label="身体"
                value={appearance.body}
                options={appearanceOptions.body}
                onChange={(body) => setAppearance((current) => ({ ...current, body }))}
              />
              <AppearanceSelect
                label="移动"
                value={appearance.mobility}
                options={appearanceOptions.mobility}
                onChange={(mobility) => setAppearance((current) => ({ ...current, mobility }))}
              />
              <AppearanceSelect
                label="配件"
                value={appearance.accessory}
                options={appearanceOptions.accessory}
                onChange={(accessory) => setAppearance((current) => ({ ...current, accessory }))}
              />
              <AppearanceSelect
                label="颜色"
                value={appearance.accent}
                options={appearanceOptions.accent}
                onChange={(accent) => setAppearance((current) => ({ ...current, accent }))}
              />
            </div>
          </section>
          <div className="form-grid">
            <label>
              <span>Bot 名称</span>
              <input
                autoFocus
                maxLength={64}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如 Ops"
                required
              />
            </label>
            <label>
              <span>职责</span>
              <textarea
                maxLength={160}
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder="描述它负责的工作"
                required
              />
            </label>
            <label>
              <span>电脑</span>
              <select
                value={computerProfile}
                onChange={(event) =>
                  setComputerProfile(event.target.value as Bot["computerProfile"])
                }
              >
                {computerOptions.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <small>
                {computerProfile === "model"
                  ? "选择模型服务回复消息，无需连接电脑。"
                  : "Bot 是员工，电脑只是可以替换的执行节点。"}
              </small>
            </label>
            {selectsModel ? (
              <ModelSelector
                value={model}
                allowDefault={computerProfile !== "docker-linux"}
                onChange={setModel}
                onManageModels={onManageModels}
                refreshKey={modelServicesVersion}
                onValidityChange={setModelValid}
                disabled={busy}
              />
            ) : null}
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer>
            <button
              className="secondary-button dialog-import-action"
              type="button"
              onClick={() => {
                dialogRef.current?.close();
                onImport();
              }}
            >
              检查员工模板
            </button>
            <button className="secondary-button" type="button" onClick={closeDialog}>
              取消
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={busy || (selectsModel && !modelValid)}
            >
              {busy ? "创建中…" : "创建 Bot"}
            </button>
          </footer>
        </form>
      </dialog>
    </div>
  );
}

function AppearanceSelect<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string }>;
  onChange(value: Value): void;
}) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as Value)}>
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
