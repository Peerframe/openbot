import type { Bot } from "@openbot/domain";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_EXTENSIONS,
  attachmentExtensionByteLimit,
  type AttachmentOperation,
  MAX_TASK_ATTACHMENT_BYTES,
  MAX_TASK_ATTACHMENTS,
} from "@openbot/protocol";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import {
  listOwnerAttachments,
  updateOwnerAttachment,
  uploadOwnerAttachment,
  type NativeTaskScopeInput,
  type OwnerAttachment,
} from "../native-task-api";

type ScopeBot = Pick<Bot, "id" | "name" | "computerProfile">;
export function taskBotSupported(bot: ScopeBot) {
  return bot.computerProfile === "none" || bot.computerProfile === "model";
}
export function attachmentNeedsProcessing(file: OwnerAttachment) {
  return (
    !file.processing &&
    file.mediaType !== "text/plain" &&
    file.mediaType !== "application/pdf" &&
    !file.mediaType.startsWith("image/")
  );
}
function attachmentFailure(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return "登录已失效，请重新登录。";
    if (error.status === 403) return "Server 拒绝了附件操作，请检查权限与连接来源。";
    if (error.status === 413) return "附件超过大小限制，Server 未接受此请求。";
    if (error.status === 422) return "Server 未接受附件或处理参数，请检查格式与密码。";
    if (error.status === 404 || error.status === 405) return "未找到附件或 Server 尚未启用此接口。";
  }
  return "未能确认附件操作结果，请刷新附件列表后再提交任务；操作不会自动重试。";
}

export function NativeTaskScopeForm({
  bots,
  botId,
  value,
  onChange,
  files,
  onFilesChange,
  onBusyChange,
  onFreshChange,
  disabled,
  active,
  capabilitiesEnabled,
}: {
  bots: ScopeBot[];
  botId: string;
  value: NativeTaskScopeInput;
  onChange: (scope: NativeTaskScopeInput) => void;
  files: OwnerAttachment[];
  onFilesChange: (files: OwnerAttachment[]) => void;
  onBusyChange: (busy: boolean) => void;
  onFreshChange: (fresh: boolean) => void;
  disabled: boolean;
  active: boolean;
  capabilitiesEnabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const request = useRef<AbortController | null>(null);
  const lifecycle = useRef({ onBusyChange, onFreshChange });
  lifecycle.current = { onBusyChange, onFreshChange };
  useEffect(() => {
    function invalidate() {
      request.current?.abort();
      request.current = null;
      setBusy(false);
      setPasswords({});
      lifecycle.current.onBusyChange(false);
      lifecycle.current.onFreshChange(false);
    }
    if (!active) invalidate();
    window.addEventListener("offline", invalidate);
    return () => {
      window.removeEventListener("offline", invalidate);
      invalidate();
    };
  }, [active]);

  async function run(action: (signal: AbortSignal) => Promise<OwnerAttachment[]>) {
    if (disabled || request.current) return;
    if (!navigator.onLine) {
      setError("网络已断开，请恢复连接后刷新附件列表。");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    onBusyChange(true);
    onFreshChange(false);
    setError("");
    try {
      const next = await action(AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]));
      if (controller.signal.aborted) return;
      onFilesChange(next);
      onFreshChange(true);
      setLoaded(true);
    } catch (cause) {
      if (!controller.signal.aborted) setError(attachmentFailure(cause));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
        onBusyChange(false);
      }
    }
  }
  function select(file: OwnerAttachment, selected: boolean) {
    if (disabled || busy || file.deletedAt) return;
    const ids = value.attachmentIds.filter((id) => id !== file.id);
    if (selected) ids.push(file.id);
    const total = files
      .filter((item) => ids.includes(item.id))
      .reduce((sum, item) => sum + item.sizeBytes, 0);
    if (ids.length > MAX_TASK_ATTACHMENTS || total > MAX_TASK_ATTACHMENT_BYTES) {
      setError("每个任务最多选择 8 个附件，合计不超过 20 MiB。");
      return;
    }
    setError("");
    onChange({ ...value, attachmentIds: ids.sort() });
  }
  function upload(file: File) {
    const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
    if (
      !/^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,159}$/u.test(file.name) ||
      !ATTACHMENT_EXTENSIONS.includes(extension)
    ) {
      setError(
        "请选择支持格式的文件；文件名最多 160 字符，使用字母、数字、空格、点、下划线、括号或短横线。",
      );
      return;
    }
    if (file.size === 0 || file.size > attachmentExtensionByteLimit(extension)) {
      setError("文件为空或超过大小限制：文本 256 KiB、图片 5 MiB、其他支持格式 10 MiB。");
      return;
    }
    void run(async (signal) => {
      const uploaded = await uploadOwnerAttachment(file, signal);
      return [uploaded, ...files.filter((item) => item.id !== uploaded.id)];
    });
  }
  function update(file: OwnerAttachment, operation: AttachmentOperation | "delete" | "restore") {
    const password = passwords[file.id];
    setPasswords({});
    void run(async (signal) => {
      const updated = await updateOwnerAttachment(file.id, operation, signal, password);
      // A lost response never changes selection; refresh resolves the file's actual state.
      if (!signal.aborted && operation === "delete")
        onChange({ ...value, attachmentIds: value.attachmentIds.filter((id) => id !== file.id) });
      return files.map((item) => (item.id === updated.id ? updated : item));
    });
  }
  const selectedBytes = files
    .filter((file) => value.attachmentIds.includes(file.id))
    .reduce((sum, file) => sum + file.sizeBytes, 0);
  return (
    <section className="native-task-scope" aria-label="本次任务范围">
      <h3>本次任务范围</h3>
      <p>默认仅使用模型、生成报告和结果审阅。下列选择仅授权本次任务，不读取任何频道。</p>
      <div className="native-task-file-controls">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => void run(listOwnerAttachments)}
        >
          刷新附件列表
        </button>
        <label>
          上传 Owner 附件
          <input
            type="file"
            accept={ATTACHMENT_ACCEPT}
            disabled={disabled || busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) upload(file);
            }}
          />
        </label>
      </div>
      <p>
        上传后请勾选要交给本次任务的附件。已选择 {value.attachmentIds.length} / 8 个，
        {selectedBytes} / 20971520 字节。
      </p>
      <small>
        文本 256 KiB、图片 5 MiB、其他支持格式 10 MiB。图片/PDF
        可作为原始输入；下列元数据不表示模型已经读取文件。Office、音频和视频需先显式处理。
      </small>
      {loaded && files.length === 0 && <p>暂无 Owner 附件。</p>}
      <ul className="native-task-files">
        {files.map((file) => {
          const media = file.mediaType.startsWith("audio/") || file.mediaType.startsWith("video/");
          const image = file.mediaType.startsWith("image/");
          const operation = media ? "transcribe" : image ? "ocr" : "extract";
          return (
            <li key={file.id}>
              <label className="native-task-checkbox">
                <input
                  type="checkbox"
                  aria-label={`选择附件 ${file.name}`}
                  checked={value.attachmentIds.includes(file.id)}
                  disabled={disabled || busy || !!file.deletedAt}
                  onChange={(event) => select(file, event.target.checked)}
                />
                {file.name}
                {file.deletedAt && "（已删除）"}
              </label>
              <small>
                {file.mediaType} · {file.sizeBytes} 字节 · SHA-256 <code>{file.sha256}</code>
              </small>
              {file.processing && (
                <p>
                  已{file.processing.operation === "transcribe" ? "转写" : "提取"}{" "}
                  {file.processing.characters} 字符{file.processing.truncated && "（已截断）"}
                </p>
              )}
              {attachmentNeedsProcessing(file) && !file.deletedAt && (
                <p>此格式需先处理，再提交任务。</p>
              )}
              <details>
                <summary>附件处理与删除</summary>
                {file.mediaType !== "text/plain" && !file.deletedAt && (
                  <>
                    {file.mediaType === "application/pdf" && (
                      <label>
                        PDF 密码（需要时填写）
                        <input
                          type="password"
                          autoComplete="off"
                          maxLength={256}
                          disabled={disabled || busy}
                          value={passwords[file.id] ?? ""}
                          onChange={(event) =>
                            setPasswords({ ...passwords, [file.id]: event.target.value })
                          }
                        />
                      </label>
                    )}
                    {media && (
                      <p>点击转写会将此媒体发送给已配置的 OpenAI；原文件保留在当前 Server。</p>
                    )}
                    <button
                      type="button"
                      disabled={disabled || busy}
                      onClick={() => update(file, operation)}
                    >
                      {media ? "发送至 OpenAI 转写" : image ? "识别图片文字" : "提取文档文字"}
                    </button>
                  </>
                )}
                <p>移到回收站会阻止引用此附件的任务继续读取。恢复附件不会恢复已取消的任务。</p>
                <button
                  type="button"
                  disabled={disabled || busy}
                  onClick={() => update(file, file.deletedAt ? "restore" : "delete")}
                >
                  {file.deletedAt ? "恢复附件" : "移到回收站"}
                </button>
              </details>
            </li>
          );
        })}
      </ul>
      {busy && <p role="status">正在同步附件；请等待后再提交任务。</p>}
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={disabled || !capabilitiesEnabled} className="native-task-capabilities">
        <legend>额外能力（默认不授权）</legend>
        {(["knowledge", "plugins", "web"] as const).map((key) => (
          <label className="native-task-checkbox" key={key}>
            <input
              type="checkbox"
              checked={value[key]}
              onChange={(event) => onChange({ ...value, [key]: event.target.checked })}
            />
            {
              {
                knowledge: "允许使用此 Bot 的知识",
                plugins: "允许使用此 Bot 的插件",
                web: "允许访问网页",
              }[key]
            }
          </label>
        ))}
        <p>协作 Bot 范围（可选，最多 32 个；仅授予候选范围，实际委派仍由 Server 检查）</p>
        {bots
          .filter((bot) => taskBotSupported(bot) && bot.id !== botId)
          .map((bot) => (
            <label className="native-task-checkbox" key={bot.id}>
              <input
                type="checkbox"
                aria-label={`允许协作 ${bot.name}`}
                checked={value.collaboratorBotIds.includes(bot.id)}
                disabled={
                  !value.collaboratorBotIds.includes(bot.id) &&
                  value.collaboratorBotIds.length >= 32
                }
                onChange={(event) =>
                  onChange({
                    ...value,
                    collaboratorBotIds: (event.target.checked
                      ? [...value.collaboratorBotIds, bot.id]
                      : value.collaboratorBotIds.filter((id) => id !== bot.id)
                    ).sort(),
                  })
                }
              />
              {bot.name}
            </label>
          ))}
      </fieldset>
      {!capabilitiesEnabled && <small>当前候选入口尚未启用额外能力；附件范围可独立提交。</small>}
    </section>
  );
}
