/** Checks current Owner approval policy before Work effects are admitted. */
import { approvalSettingsInputSchema } from "@openbot/protocol";
import { WorkConflict } from "@openbot/work";
import type { WorkDb } from "./work-handoff.js";
import type { WorkAction } from "./work-ledger.js";
import type { WorkJson } from "./work-values.js";

const configuration = approvalSettingsInputSchema.omit({ expectedRevision: true });
function operation(intent: Record<string, WorkJson>) {
  if (
    Object.keys(intent).sort().join(",") !== "arguments,effect,kind,tool" ||
    intent.kind !== "deferred_tool"
  )
    return null;
  const effect = intent.effect as Record<string, WorkJson> | null,
    args = intent.arguments as Record<string, WorkJson> | null;
  if (!effect || Array.isArray(effect) || !args || Array.isArray(args)) return null;
  if (
    effect.kind === "work_reads" &&
    effect.version === 1 &&
    effect.operation === intent.tool &&
    ["read_channel_context", "read_task_status", "list_channel_bots", "read_attachment"].includes(
      String(intent.tool),
    )
  ) {
    const source = effect.source as Record<string, WorkJson>;
    return {
      category: "product_read" as const,
      mode: "productRead" as const,
      kind: intent.tool === "read_attachment" ? "attachment" : "channel",
      value: intent.tool === "read_attachment" ? args.attachmentId : source?.channelId,
    };
  }
  if (
    effect.kind === "product_web" &&
    ["fetch", "read_public_page", "web_search"].includes(String(intent.tool))
  ) {
    const selection = effect.selection as Record<string, WorkJson>;
    return {
      category: "public_web" as const,
      mode: "publicWeb" as const,
      kind: "page",
      value: intent.tool !== "web_search" && selection?.kind === "page" ? selection.url : null,
    };
  }
  return null;
}
/** ADR-0049 adds confirmation; an exception can never lower the trusted adapter minimum. */
export async function workApprovalRequired(
  db: WorkDb,
  botId: string,
  intent: Record<string, WorkJson>,
  minimum: boolean,
) {
  const match = operation(intent);
  if (minimum || !match) return minimum;
  const [row] =
    await db`SELECT configuration FROM owner_approval_settings WHERE owner_id='owner' FOR SHARE`;
  const parsed = configuration.safeParse(row?.configuration);
  if (!parsed.success) throw new WorkConflict("approval_policy_unavailable");
  if (parsed.data[match.mode] === "inherit") return false;
  return !parsed.data.exceptions.some(
    (e) =>
      e.botId === botId &&
      e.category === match.category &&
      e.target.kind === match.kind &&
      e.target.value === match.value,
  );
}
export async function checkWorkApproval(db: WorkDb, botId: string, action: WorkAction) {
  const required = await workApprovalRequired(
    db,
    botId,
    action.intent,
    action.baseline_requires_approval,
  );
  if (action.decision !== "approved" && required) throw new WorkConflict("approval_policy_changed");
}
