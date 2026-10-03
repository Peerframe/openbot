import { useEffect, useState } from "react";
import {
  ApiError,
  getStorageSettings,
  getStorageUsage,
  type StorageCategory,
  type StorageSettings,
  type StorageUsage,
  updateStorageSettings,
} from "../api";
import { AttachmentsManagerDialog } from "./AttachmentsManager";
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
 * 设置 › 存储空间 (SettingsStorage artboard; backlog C21). The 服务电脑 measures what it stores
 * and refuses rather than estimates; only the 回收站 can be cleaned, per channel, from 频道文件.
 * Browser profiles live on the working computers and are not measured here.
 */
export function SettingsStorage() {
  const [usage, setUsage] = useState<StorageUsage>();
  const [usageError, setUsageError] = useState("");
  const [settings, setSettings] = useState<StorageSettings>();
  const [settingsError, setSettingsError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [viewing, setViewing] = useState<{ id: string; name: string }>();

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

  const categories = usage ? storageCategories(usage) : [];
  const total = usage?.totalBytes ?? 0;
  const trash = usage?.trash;
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

      <SettingsGroup title="回收站">
        {trash ? (
          <SettingRow
            title={`${trash.fileCount} 个文件 · ${formatStorageSize(trash.sizeBytes)}`}
            description={
              trash.fileCount === 0
                ? "回收站是空的。"
                : trash.referencedFileCount > 0
                  ? `其中 ${trash.referencedFileCount} 个还被消息或任务引用，会保留；其余 ${trash.fileCount - trash.referencedFileCount} 个可以在各频道的「频道文件 › 回收站」里永久删除。`
                  : "都可以在各频道的「频道文件 › 回收站」里永久删除。"
            }
          />
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
