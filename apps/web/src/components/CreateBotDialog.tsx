import type { Bot, BotAppearance, CreateBotInput, ModelSelection } from "@openbot/domain";
import { useEffect, useRef, useState } from "react";
import { type ApiError, getOwnerPreferences } from "../api";
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

/**
 * Only the head and the accent are drawn (DESIGN.md, Bot avatars); body, mobility and accessory keep
 * their stored defaults so existing appearance data stays valid.
 */
const appearanceOptions = {
  head: [
    { value: "round", label: "Round · 天线" },
    { value: "square", label: "Relay · 耳朵" },
    { value: "cat", label: "Scout · 猫耳" },
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
  const modelTouched = useRef(false);
  // Preselect the Owner's default model for new Bots (backlog C7); a choice already made wins.
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => getOwnerPreferences(controller.signal))
      .then((preferences) => {
        if (!controller.signal.aborted && !modelTouched.current && preferences.defaultModel)
          setModel(preferences.defaultModel);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
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
          <section className="bot-identity-builder" aria-label="Bot 外观">
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
                <span>头型与颜色</span>
              </div>
            </div>
            <div className="appearance-grid">
              <AppearanceSelect
                label="头型"
                value={appearance.head}
                options={appearanceOptions.head}
                onChange={(head) => setAppearance((current) => ({ ...current, head }))}
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
                  : "Bot 是员工，电脑只是可以替换的执行环境。"}
              </small>
            </label>
            {selectsModel ? (
              <ModelSelector
                value={model}
                allowDefault={computerProfile !== "docker-linux"}
                onChange={(value) => {
                  modelTouched.current = true;
                  setModel(value);
                }}
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
