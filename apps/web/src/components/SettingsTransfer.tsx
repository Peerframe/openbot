// Settings → 导入与导出 (SettingsTransfer artboard): opens the Bot template import and export dialogs.
import type { Bot } from "@openbot/domain";
import { useState } from "react";
import { useEmployeeProfiles } from "../use-employee-profiles";
import { ExportEmployeeDialog } from "./ExportEmployeeDialog";
import { ImportEmployeeDialog } from "./ImportEmployeeDialog";
import { RobotAvatar } from "./RobotAvatar";

/**
 * Settings → 导入与导出 (SettingsTransfer artboard). Both directions reuse the reviewed dialogs:
 * imports are quarantined and create a Bot without computer authority; exports are redacted.
 */
export function SettingsTransfer({ bots, onChanged }: { bots: Bot[]; onChanged?(): void }) {
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState<Bot>();
  const [notice, setNotice] = useState<string>();
  const { profiles, loading } = useEmployeeProfiles(bots.map((bot) => bot.id));
  return (
    <>
      {notice ? (
        <p className="settings-success" role="status">
          {notice}
        </p>
      ) : null}
      <section className="settings-group">
        <h3>导入员工模板</h3>
        <button type="button" className="settings-dropzone" onClick={() => setImporting(true)}>
          <strong>选择模板文件</strong>
          <small>先在隔离区检查；导入后 Bot 处于待命状态，技能要逐项审核后才能用</small>
        </button>
      </section>
      <section className="settings-group">
        <h3>导出员工模板</h3>
        {bots.length === 0 ? (
          <p className="settings-empty">还没有可以导出的 Bot。</p>
        ) : (
          <div className="settings-group-rows">
            {bots.map((bot) => {
              const skills = profiles.get(bot.id)?.skills.length;
              return (
                <div className="settings-item" key={bot.id}>
                  <span className="settings-tile settings-routine-avatar" aria-hidden="true">
                    <RobotAvatar bot={bot} compact />
                  </span>
                  <span className="settings-item-text">
                    <strong>{bot.name}</strong>
                    <small>
                      {skills !== undefined ? `${skills} 项技能` : loading ? "…" : bot.role}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="ob-pill is-small"
                    aria-label={`导出 ${bot.name}`}
                    onClick={() => setExporting(bot)}
                  >
                    导出
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <p className="settings-footnote">
        模板不包含主机绑定、审批、凭证、会话或能力授权；接收方要在自己的 OpenBot 重新授权。
      </p>
      {importing ? (
        <ImportEmployeeDialog
          onClose={() => setImporting(false)}
          onActivated={(result) => {
            setImporting(false);
            setNotice(
              result.replayed
                ? `${result.employee.name} 的导入结果已恢复。`
                : `${result.employee.name} 已激活，技能仍需逐项审核。`,
            );
            onChanged?.();
          }}
        />
      ) : null}
      {exporting ? (
        <ExportEmployeeDialog
          employee={exporting}
          onClose={() => setExporting(undefined)}
          onDownloaded={(fileName) => {
            setExporting(undefined);
            setNotice(`已下载 ${fileName}。`);
          }}
        />
      ) : null}
    </>
  );
}
