import { createHash, randomUUID } from "node:crypto";
import type { ApprovalOutcome, PreparedAction } from "@openbot/provider-sdk";

interface Snapshot {
  url?: unknown;
  snapshotId?: unknown;
  truncated?: unknown;
  elements?: unknown;
}
interface Screen {
  url?: unknown;
  base64?: unknown;
}
type Request = <T>(path: string, body?: unknown) => Promise<T>;

interface ClickOptions {
  target: string;
  buttonName: string;
  signal: AbortSignal;
  request: Request;
  screenshot: Screen;
}
export interface PreparedClick {
  readonly action: PreparedAction;
}
const commits = new WeakMap<PreparedClick, (approval: ApprovalOutcome) => Promise<void>>();

/** Preparation and commit must run under the same Bot coordinator; approval must not. */
export async function prepareReviewedClick(options: ClickOptions): Promise<PreparedClick> {
  const { target, buttonName, signal, request } = options;
  const control = await request<{ holder?: unknown }>("/control");
  if (control.holder !== "bot") throw new Error("A person has control of the browser.");
  const snapshot = await request<Snapshot>("/snapshot", {});
  if (
    snapshot.url !== target ||
    !Number.isSafeInteger(snapshot.snapshotId) ||
    Number(snapshot.snapshotId) <= 0 ||
    snapshot.truncated !== false ||
    !Array.isArray(snapshot.elements) ||
    snapshot.elements.length > 200
  )
    throw new Error("Browser observation is incomplete or changed.");
  const matches = snapshot.elements.filter(
    (element) => element && element.role === "button" && element.name === buttonName,
  );
  const selected = matches[0];
  if (
    matches.length !== 1 ||
    !selected ||
    (selected.disabled !== undefined && selected.disabled !== false) ||
    typeof selected.ref !== "string" ||
    !/^(?:f[0-9]{1,8})?e[0-9]{1,8}$/u.test(selected.ref)
  )
    throw new Error("The task must name one unique enabled button from the current page.");
  const fingerprint = screenDigest(options.screenshot, target);
  // Freeze only observed identity/evidence, never arbitrary values from a webpage or model.
  const frozen = Object.freeze({
    ref: selected.ref as string,
    snapshotId: Number(snapshot.snapshotId),
    buttonName,
    screenshotSha256: fingerprint,
  });
  signal.throwIfAborted();
  const action: PreparedAction = Object.freeze({
    actionId: randomUUID(),
    action: "browser.click",
    target,
    summary: `Click the observed button “${buttonName}” once. Review its target and current frame.`,
    risk: "privileged",
    beforeState: frozen,
    expiresInSeconds: 120,
  });
  const prepared = Object.freeze({ action });
  commits.set(prepared, async (approval) => {
    signal.throwIfAborted();
    if (approval.status !== "approved") throw new Error("Browser click was not approved.");
    const currentControl = await request<{ holder?: unknown }>("/control");
    if (currentControl.holder !== "bot") throw new Error("A person has control of the browser.");
    const current = await request<Screen>("/screenshot");
    if (screenDigest(current, target) !== fingerprint)
      throw new Error("The approved page changed; submit a new task for review.");
    signal.throwIfAborted();
    // Exactly one commit attempt. A failed/uncertain HTTP response must never retry a click.
    const result = await request<{
      action?: unknown;
      ref?: unknown;
      url?: unknown;
    }>("/click", {
      ref: frozen.ref,
      snapshotId: frozen.snapshotId,
    }).catch(() => {
      throw new Error(
        "The click result could not be verified; it may have occurred. Do not automatically retry.",
      );
    });
    signal.throwIfAborted();
    if (result.action !== "click" || result.ref !== frozen.ref || result.url !== target)
      throw new Error(
        "The click result could not be verified; it may have occurred. Do not automatically retry.",
      );
  });
  return prepared;
}

export async function commitReviewedClick(prepared: PreparedClick, approval: ApprovalOutcome) {
  const commit = commits.get(prepared);
  if (!commit) throw new Error("The prepared click is invalid or already consumed.");
  // Consume before the first check/await, so failure and uncertainty cannot retry this handle.
  commits.delete(prepared);
  await commit(approval);
}

/** Compatibility wrapper for isolated callers; the coordinated Provider uses split phases. */
export async function reviewedClick(
  options: ClickOptions & { requestApproval: (action: PreparedAction) => Promise<ApprovalOutcome> },
) {
  const prepared = await prepareReviewedClick(options);
  options.signal.throwIfAborted();
  const approval = await options.requestApproval(prepared.action);
  await commitReviewedClick(prepared, approval);
}
function screenDigest(screen: Screen, target: string): string {
  if (
    screen.url !== target ||
    typeof screen.base64 !== "string" ||
    screen.base64.length > 7_000_000
  )
    throw new Error("The observed screenshot is invalid or belongs to another page.");
  const bytes = Buffer.from(screen.base64, "base64");
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.length > 5 * 1024 * 1024
  )
    throw new Error("Invalid screenshot evidence.");
  return createHash("sha256").update(bytes).digest("hex");
}
