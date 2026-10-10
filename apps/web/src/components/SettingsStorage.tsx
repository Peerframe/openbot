// Settings → 存储空间 (SettingsStorage artboard): server disk use by category and channel, 回收站
// cleanup, and each Bot's browser data measured on request.
import type { Bot } from "@openbot/domain";
import { useEffect, useState } from "react";
import {
  ApiError,
  cleanupAllTrash,
  getStorageSettings,
  getStorageUsage,
  maintainEmployeeBrowser,
  type StorageCategory,
  type StorageSettings,
  type StorageUsage,
  updateStorageSettings,
} from "../api";
import { AttachmentsManagerDialog } from "./AttachmentsManager";
import { Dialog } from "./Dialog";
import { SettingRow, SettingsGroup } from "./SettingsSections";
import { sidebarTime } from "./Sidebar";
import "./SettingsStorage.css";

/** Decimal units, as the operating systems report disk space. */
export function formatStorageSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

type CategoryKey =
  | "channelFiles"
  | "taskOutputs"
  | "ownerTaskFiles"
  | "trash"
  | "database"
  | "other";

const categoryLabels: Record<CategoryKey, string> = {
  channelFiles: "频道文件",
  taskOutputs: "任务产出",
  ownerTaskFiles: "任务附件",
  trash: "回收站",
  database: "对话与记录",
  other: "其他",
};

/** The measured categories in display order; unmeasured ones are left out, never estimated. */
export function storageCategories(usage: StorageUsage): Array<{
  key: CategoryKey;
  label: string;
  value: StorageCategory;
}> {
  const { categories } = usage;
  const outputs = categories.taskOutputs ?? categories.retainedRunOutputs;
  const entries: Array<[CategoryKey, StorageCategory | null]> = [
    ["channelFiles", categories.channelFiles],
    ["taskOutputs", outputs],
    ["ownerTaskFiles", categories.ownerTaskFiles],
    ["database", categories.database],
    ["other", categories.other],
    ["trash", categories.trash],
  ];
  return entries.flatMap(([key, value]) =>
    value ? [{ key, label: categoryLabels[key], value }] : [],
  );
}

/**
 * 设置 › 存储空间 (SettingsStorage artboard; C21, C22, C23). The 服务电脑 measures what it stores
 * and refuses rather than estimates; only the 回收站 can be cleaned, all at once or per channel.
 * Browser profiles live on the working computers: they are measured on request, Bot by Bot, and
 * never added to the 服务电脑 total.
 */
export function SettingsStorage({ bots = [] }: { bots?: Bot[] }) {
  const [usage, setUsage] = useState<StorageUsage>();
  const [usageError, setUsageError] = useState("");
  const [settings, setSettings] = useState<StorageSettings>();
  const [settingsError, setSettingsError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [viewing, setViewing] = useState<{ id: string; name: string }>();
  const [cleanup, setCleanup] = useState<{ requestKey: string; unclear?: boolean }>();
  const [cleaning, setCleaning] = useState(false);
  const [cleanupError, setCleanupError] = useState("");
  const [notice, setNotice] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-measures after a change.
  useEffect(() => {
    const controller = new AbortController();
    setUsageError("");
    getStorageUsage(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setUsage(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setUsageError("暂时量不出占用空间。服务电脑只给出实际测量的结果，请稍后重试。");
      });
    getStorageSettings(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setSettings(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSettingsError("没能读取自动清理设置。");
      });
    return () => controller.abort();
  }, [reload]);

  async function toggleAutoPurge() {
    if (!settings || saving) return;
    setSaving(true);
    setSettingsError("");
    try {
      setSettings(
        await updateStorageSettings({
          expectedRevision: settings.revision,
          trashAutoPurgeDays: settings.trashAutoPurgeDays === 30 ? null : 30,
        }),
      );
    } catch (cause) {
      setSettingsError(
        cause instanceof ApiError && cause.status === 409
          ? "这个设置刚在别处改过，已重新读取。"
          : "没能保存，请重试。",
      );
      if (cause instanceof ApiError && cause.status === 409) setReload((value) => value + 1);
    } finally {
      setSaving(false);
    }
  }

  async function emptyTrash(target: { requestKey: string }) {
    setCleaning(true);
    setCleanupError("");
    try {
      const result = await cleanupAllTrash(target.requestKey);
      setNotice(
        `已永久删除 ${result.removed} 个文件，释放 ${formatStorageSize(result.freedBytes)}。${
          result.retainedCount > 0 ? `${result.retainedCount} 个还被引用，已保留。` : ""
        }`,
      );
      setCleanup(undefined);
      setReload((value) => value + 1);
    } catch (cause) {
      if (!(cause instanceof ApiError)) {
        // The same key replays the saved result, so 重试 cannot delete twice.
        setCleanup({ ...target, unclear: true });
        setCleanupError("没能确认是否已经删除。点「重试」会接着同一次清理，不会重复删除。");
        return;
      }
      setCleanup(undefined);
      setNotice(
        cause.status === 404
          ? "这台服务电脑还不能一次清空，请到各频道的「频道文件 › 回收站」里清空。"
          : "没能清空回收站，已重新测量。",
      );
      setReload((value) => value + 1);
    } finally {
      setCleaning(false);
    }
  }

  const categories = usage ? storageCategories(usage) : [];
  const total = usage?.totalBytes ?? 0;
  const trash = usage?.trash;
  const removable = trash ? trash.fileCount - trash.referencedFileCount : 0;
  const dockerBots = bots.filter((bot) => bot.computerProfile === "docker-linux");
  const autoPurge = settings?.trashAutoPurgeDays === 30;

  return (
    <>
      {usageError ? (
        <div className="settings-load-notice" role="alert">
          <p>{usageError}</p>
          <button type="button" className="ob-pill" onClick={() => setReload((value) => value + 1)}>
            重试
          </button>
        </div>
      ) : null}
      {usage ? (
        <section className="storage-summary" aria-label="占用空间">
          <div className="storage-total">
            <strong>{formatStorageSize(total)}</strong>
            <small>这台服务电脑 · {sidebarTime(usage.measuredAt)} 测量</small>
          </div>
          <div
            className="storage-bar"
            role="img"
            aria-label={categories
              .map((item) => `${item.label} ${formatStorageSize(item.value.sizeBytes)}`)
              .join("，")}
          >
            {categories.map((item) =>
              item.value.sizeBytes > 0 && total > 0 ? (
                <span
                  key={item.key}
                  className={`storage-swatch-${item.key}`}
                  style={{ width: `${(item.value.sizeBytes / total) * 100}%` }}
                />
              ) : null,
            )}
          </div>
          <ul className="storage-legend">
            {categories.map((item) => (
              <li key={item.key}>
                <b>
                  <i className={`storage-swatch-${item.key}`} aria-hidden="true" />
                  {formatStorageSize(item.value.sizeBytes)}
                </b>
                {item.label}
              </li>
            ))}
          </ul>
        </section>
      ) : !usageError ? (
        <p className="settings-load-notice" role="status">
          正在测量占用空间…
        </p>
      ) : null}

      {notice ? (
        <p className="settings-load-notice" role="status">
          {notice}
        </p>
      ) : null}
      <SettingsGroup title="回收站">
        {trash ? (
          <SettingRow
            title={`${trash.fileCount} 个文件 · ${formatStorageSize(trash.sizeBytes)}`}
            description={
              trash.fileCount === 0
                ? "回收站是空的。"
                : trash.referencedFileCount > 0
                  ? `其中 ${trash.referencedFileCount} 个还被消息或任务引用，会保留；其余 ${removable} 个可以永久删除。`
                  : "都可以永久删除。"
            }
          >
            <button
              type="button"
              className="ob-pill is-small is-danger storage-danger"
              disabled={removable === 0 || cleaning}
              onClick={() => {
                setCleanupError("");
                setCleanup({ requestKey: crypto.randomUUID() });
              }}
            >
              清空回收站…
            </button>
          </SettingRow>
        ) : null}
        <SettingRow
          title="满 30 天后自动永久删除"
          description={
            settingsError ||
            `默认关闭。被引用的文件不会删除；每次删除都记入审计${
              autoPurge && settings?.lastAutoPurgeAt
                ? `。上次检查：${sidebarTime(settings.lastAutoPurgeAt)}`
                : ""
            }`
          }
        >
          <button
            type="button"
            role="switch"
            className="ob-switch"
            aria-checked={autoPurge}
            aria-label="回收站满 30 天后自动永久删除"
            disabled={!settings || saving}
            onClick={() => void toggleAutoPurge()}
          />
        </SettingRow>
      </SettingsGroup>

      {dockerBots.length > 0 ? (
        <SettingsGroup title="工作电脑上的浏览器数据">
          <BrowserProfiles bots={dockerBots} />
        </SettingsGroup>
      ) : null}

      {usage && usage.topChannels.length > 0 ? (
        <SettingsGroup title="占用最多的频道">
          {usage.topChannels.map((channel) => (
            <SettingRow
              key={channel.id}
              title={channel.deleted ? `${channel.name}（已删除）` : channel.name}
              description={`${formatStorageSize(channel.sizeBytes)} · ${channel.fileCount} 个文件`}
            >
              {channel.deleted ? null : (
                <button
                  type="button"
                  className="storage-link"
                  onClick={() => setViewing({ id: channel.id, name: channel.name })}
                >
                  查看文件 ›
                </button>
              )}
            </SettingRow>
          ))}
        </SettingsGroup>
      ) : null}

      <p className="settings-footnote">
        浏览器的登录数据保存在工作电脑上，在「设置 › 员工浏览器」里清除。
      </p>

      {cleanup && trash ? (
        <Dialog
          title={`永久删除 ${removable} 个文件？`}
          width={400}
          className="storage-confirm"
          onClose={cleaning ? () => undefined : () => setCleanup(undefined)}
          footer={
            <>
              <button
                type="button"
                className="ob-pill"
                disabled={cleaning}
                onClick={() => {
                  if (cleanup.unclear) setReload((value) => value + 1);
                  setCleanup(undefined);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="ob-pill is-danger"
                disabled={cleaning}
                onClick={() => void emptyTrash(cleanup)}
              >
                {cleaning ? "正在删除…" : cleanup.unclear ? "重试" : "永久删除"}
              </button>
            </>
          }
        >
          <p className="storage-confirm-text">
            所有频道回收站里没有被引用的文件
            {trash.referencedSizeBytes !== undefined
              ? `，共 ${formatStorageSize(trash.sizeBytes - trash.referencedSizeBytes)}`
              : ""}
            。删除后不能恢复，会记入审计。
          </p>
          {trash.referencedFileCount > 0 ? (
            <small className="storage-confirm-kept">
              {trash.referencedFileCount} 个还被消息或任务引用的文件会保留。
            </small>
          ) : null}
          {cleanupError ? (
            <p className="ob-dialog-error" role="alert">
              {cleanupError}
            </p>
          ) : null}
        </Dialog>
      ) : null}

      {viewing ? (
        <AttachmentsManagerDialog
          channelId={viewing.id}
          channelName={viewing.name}
          onClose={() => {
            setViewing(undefined);
            setReload((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * C23: each Bot's browser profile on its working computer, read through browser status only when
 * asked. A Bot whose computer cannot measure it shows 「量不出」, never zero.
 */
function BrowserProfiles({ bots }: { bots: Bot[] }) {
  const [sizes, setSizes] = useState<Record<string, number | null>>();
  const [measuring, setMeasuring] = useState(false);
  async function measure() {
    setMeasuring(true);
    const next: Record<string, number | null> = {};
    for (const bot of bots) {
      try {
        next[bot.id] = (await maintainEmployeeBrowser(bot.id, "status")).profileBytes;
      } catch {
        next[bot.id] = null;
      }
    }
    setSizes(next);
    setMeasuring(false);
  }
  const known = sizes
    ? Object.values(sizes).filter((value): value is number => value !== null)
    : [];
  const unknown = sizes ? bots.length - known.length : 0;
  return (
    <>
      <SettingRow
        title={
          sizes && known.length > 0
            ? formatStorageSize(known.reduce((sum, value) => sum + value, 0))
            : `${bots.length} 个 Bot 使用员工浏览器`
        }
        description={
          sizes
            ? unknown > 0
              ? `${unknown} 个 Bot 的工作电脑量不出。不计入上面服务电脑的总量。`
              : "不计入上面服务电脑的总量。"
            : "保存在各自的工作电脑上，不计入上面的总量。需要时再测量。"
        }
      >
        <button
          type="button"
          className="ob-pill is-small"
          disabled={measuring}
          onClick={() => void measure()}
        >
          {measuring ? "正在测量…" : sizes ? "重新测量" : "测量"}
        </button>
      </SettingRow>
      {sizes
        ? bots.map((bot) => (
            <SettingRow
              key={bot.id}
              title={bot.name}
              description={
                sizes[bot.id] === null || sizes[bot.id] === undefined
                  ? "量不出"
                  : formatStorageSize(sizes[bot.id] as number)
              }
            />
          ))
        : null}
    </>
  );
}
