import type { Run, RunProgress, RunProgressDetails } from "@openbot/domain";
import { type ReactNode, useEffect, useState } from "react";
import { getRunProgress } from "../api";
import { stageLabel } from "../run-state";

/** LongLists: over 12 steps, the first 3 and the latest 6 show; the middle folds into one row. */
export const STEP_LIMIT = 12;
const HEAD = 3;
const TAIL = 6;
const CHUNK = 12;

interface StepRow {
  number: number;
  title: string;
  detail: string | null;
  at: string | null;
}

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Which ordinals still sit in the folded middle, given the ones already shown. */
export function hiddenStepNumbers(total: number, shown: ReadonlySet<number>): number[] {
  if (total <= STEP_LIMIT) return [];
  const hidden: number[] = [];
  for (let number = HEAD + 1; number <= total - TAIL; number += 1)
    if (!shown.has(number)) hidden.push(number);
  return hidden;
}

/**
 * The steps in 任务详情. C13's exact count and stage dictionary come from the 服务电脑 (its English
 * descriptions are replaced by the Chinese stage name from `stageLabel`); if that
 * read fails (an older 服务电脑, or offline), the progress events the workspace already holds are
 * folded the same way. Labels are the control-authored stage names, never model output.
 */
export function TaskSteps({ run, progress }: { run: Run; progress: RunProgress[] }) {
  const [details, setDetails] = useState<RunProgressDetails>();
  const [extra, setExtra] = useState<StepRow[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new status or progress event means a new count.
  useEffect(() => {
    const controller = new AbortController();
    void getRunProgress(run.id, undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && value.runId === run.id) setDetails(value);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [run.id, run.status, progress.length]);

  const fromServer = details !== undefined && details.totalSteps > 0;
  const rows: StepRow[] = fromServer
    ? [
        ...details.steps.map((step) => ({
          number: step.stepNumber,
          title: `第 ${step.stepNumber} 步`,
          detail: stageLabel(step.stageName) ?? null,
          at: step.startedAt,
        })),
        ...extra,
      ]
    : progress.map((item, index) => ({
        number: index + 1,
        title: stageLabel(item.stage) ?? `第 ${index + 1} 步`,
        detail: item.message,
        at: item.createdAt,
      }));
  const unique = [...new Map(rows.map((row) => [row.number, row])).values()].sort(
    (left, right) => left.number - right.number,
  );
  const total = fromServer ? details.totalSteps : unique.length;
  const shown = new Set(
    fromServer || expanded
      ? unique.map((row) => row.number)
      : unique
          .filter((row) => row.number <= HEAD || row.number > total - TAIL)
          .map((row) => row.number),
  );
  const hidden = hiddenStepNumbers(total, shown);
  const visible = unique.filter((row) => shown.has(row.number));
  const firstHidden = hidden[0];
  const foldAfter =
    firstHidden === undefined ? -1 : visible.findLastIndex((row) => row.number < firstHidden);

  async function expand() {
    if (!fromServer) {
      setExpanded(true);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const next = await getRunProgress(run.id, hidden.slice(0, CHUNK));
      setExtra((current) => [
        ...current,
        ...next.steps.map((step) => ({
          number: step.stepNumber,
          title: `第 ${step.stepNumber} 步`,
          detail: stageLabel(step.stageName) ?? null,
          at: step.startedAt,
        })),
      ]);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  const fold =
    hidden.length > 0 ? (
      <li className="task-sheet-fold" key="fold">
        <button
          type="button"
          className="ob-pill is-small"
          disabled={loading}
          onClick={() => void expand()}
        >
          {loading
            ? "正在读取…"
            : error
              ? "没能读取，重试"
              : `展开 ${Math.min(hidden.length, fromServer ? CHUNK : hidden.length)} 步${
                  fromServer && hidden.length > CHUNK ? `（共 ${hidden.length} 步未显示）` : ""
                }`}
        </button>
      </li>
    ) : null;

  return (
    <>
      {visible.map((row, index) => (
        <StepItem row={row} key={row.number} fold={index === foldAfter ? fold : null} />
      ))}
      {visible.length === 0 ? fold : null}
    </>
  );
}

function StepItem({ row, fold }: { row: StepRow; fold: ReactNode }) {
  return (
    <>
      <li>
        <i className="is-done" aria-hidden="true" />
        <span>
          <strong>{row.title}</strong>
          {row.detail ? <small>{row.detail}</small> : null}
        </span>
        {row.at ? (
          <time dateTime={row.at}>{timeFormatter.format(new Date(row.at))}</time>
        ) : (
          <span />
        )}
      </li>
      {fold}
    </>
  );
}
