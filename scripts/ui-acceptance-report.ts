// Pure parts of the whole-interface acceptance (docs/research/ui-acceptance-automation.md):
// argument parsing and the classification of every API response the journey observed.

export type Entry = "python" | "ts";

export interface AcceptanceOptions {
  readonly entry: Entry;
  readonly browser: string | undefined;
  readonly out: string | undefined;
  readonly headed: boolean;
}

export function parseAcceptanceArgs(argv: readonly string[]): AcceptanceOptions {
  let entry: Entry = "python";
  let browser: string | undefined;
  let out: string | undefined;
  let headed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value.`);
      index += 1;
      return next;
    };
    if (arg === "--entry") {
      const next = value();
      if (next !== "python" && next !== "ts") throw new Error("--entry must be python or ts.");
      entry = next;
    } else if (arg === "--browser") browser = value();
    else if (arg === "--out") out = value();
    else if (arg === "--headed") headed = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { entry, browser, out, headed };
}

export interface ObservedResponse {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** The journey step that was running, so an unexpected status can be traced. */
  readonly step?: string;
}

/**
 * Known gaps the journey may hit, each by exact method, path pattern and status, with the
 * reason and where it is tracked. Anything else at 4xx/5xx fails the run.
 */
export interface KnownGap {
  readonly method: string;
  readonly path: RegExp;
  readonly status: number;
  readonly reason: string;
}

export const KNOWN_GAPS: readonly KnownGap[] = [
  {
    method: "GET",
    path: /^\/api\/v1\/runs\/[0-9a-f-]{36}\/output$/,
    status: 404,
    reason:
      "The Web still calls the retired run-output route; the Python control plane has none " +
      "(P2 acceptance finding 1, PR #200).",
  },
];

export interface ResponseTally {
  readonly byStatus: Readonly<Record<string, number>>;
  readonly allowed: readonly (ObservedResponse & { reason: string })[];
  readonly unexpected: readonly ObservedResponse[];
}

export function classifyResponses(
  responses: readonly ObservedResponse[],
  gaps: readonly KnownGap[] = KNOWN_GAPS,
): ResponseTally {
  const byStatus: Record<string, number> = {};
  const allowed: (ObservedResponse & { reason: string })[] = [];
  const unexpected: ObservedResponse[] = [];
  for (const response of responses) {
    byStatus[response.status] = (byStatus[response.status] ?? 0) + 1;
    if (response.status < 400) continue;
    const gap = gaps.find(
      (item) =>
        item.method === response.method &&
        item.status === response.status &&
        item.path.test(response.path),
    );
    if (gap) allowed.push({ ...response, reason: gap.reason });
    else unexpected.push(response);
  }
  return { byStatus, allowed, unexpected };
}

/** Values the run generated stay out of the receipt even if a step's error echoes them. */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length >= 8)
    .reduce((value, secret) => value.split(secret).join("[redacted]"), text);
}
