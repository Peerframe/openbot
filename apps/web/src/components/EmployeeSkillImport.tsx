import { type FormEvent, useState } from "react";
import { importEmployeeSkill } from "../api";

/** 导入 SKILL.md: one immutable file becomes a candidate; it is used only after review. */
export function EmployeeSkillImport({
  employeeId,
  onClose,
  onProfileChanged,
}: {
  employeeId: string;
  onClose(): void;
  onProfileChanged(): Promise<void>;
}) {
  const [markdown, setMarkdown] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      await importEmployeeSkill(employeeId, {
        markdown,
        version,
        reason: "Owner imported a single SKILL.md for review.",
      });
      setMarkdown("");
      setSaved(true);
      await onProfileChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法导入技能。");
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="ep-skill-detail ep-skill-import" aria-label="导入 SKILL.md">
      <header>
        <span>
          <strong>导入 SKILL.md</strong>
        </span>
        <button type="button" className="ob-pill is-small" onClick={onClose}>
          完成
        </button>
      </header>
      <form className="ep-skill-import-form" onSubmit={(event) => void submit(event)}>
        <p className="ep-note">
          导入后先作为候选技能。展开全文并审核后，Agent
          才能使用。每个版本的正文固定，修改内容请导入新版本。
        </p>
        <label className="ob-field">
          选择文件（最多 12 KiB）
          <input
            type="file"
            accept=".md,text/markdown"
            disabled={saving}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              setError(undefined);
              setSaved(false);
              if (!file) return;
              if (file.name !== "SKILL.md" || file.size > 12 * 1024) {
                setError("请选择不超过 12 KiB 的 SKILL.md。");
                return;
              }
              try {
                setMarkdown(await file.text());
              } catch {
                setError("无法读取所选文件。");
              }
            }}
          />
        </label>
        <label className="ob-field">
          版本
          <input
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            required
            maxLength={64}
            disabled={saving}
          />
        </label>
        <label className="ob-field">
          SKILL.md 全文
          <textarea
            rows={12}
            value={markdown}
            onChange={(event) => {
              setMarkdown(event.target.value);
              setSaved(false);
            }}
            required
            maxLength={12 * 1024}
            disabled={saving}
            placeholder={
              "---\nname: evidence-report\ndescription: 整理已提供的来源并撰写报告\n---\n先读取任务中明确提供的来源，再整理事实与结论。"
            }
          />
        </label>
        <p className="ep-note">
          当前支持单文件指令流程，使用任务已有工具；不加载附属文件或运行脚本。分享 Bot
          时可选择包含已审核且许可允许分发的正文，导入后需重新审核。
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {saved ? <p role="status">已导入为候选技能，在左侧「候选」里审核。</p> : null}
        <button
          type="submit"
          className="ob-pill is-small is-primary"
          disabled={saving || !markdown.trim()}
        >
          {saving ? "导入中…" : "导入为候选技能"}
        </button>
      </form>
    </section>
  );
}
