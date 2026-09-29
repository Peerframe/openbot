import type { NodeEnv } from "@openbot/config";
import type { OpenBotLogger } from "@openbot/logging";
import { nodeEnrollmentResultSchema } from "@openbot/protocol";
import type { NodeCredentialStore } from "./credential-store.js";

const enrollmentTimeoutMs = 10_000;
const maximumEnrollmentResponseBytes = 8 * 1024;
const responseTooLarge = "Node enrollment response is too large.";

export class NodeEnrollmentRequiredError extends Error {
  constructor() {
    super(
      "Node is not enrolled. Start the Server, run npm run node:enrollment-token -- <node-id>, " +
        "set OPENBOT_NODE_ENROLLMENT_TOKEN once in .env, then restart the Node. See CONTRIBUTING.md.",
    );
  }
}

export function nodeEnrollmentUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/api/v1/nodes/enroll";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  const body = response.body;
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maximumBytes) {
    if (body !== null && !body.locked) void body.cancel().catch(() => {});
    throw new Error(responseTooLarge);
  }
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) {
        finished = true;
        break;
      }
      total += item.value.byteLength;
      if (total > maximumBytes) throw new Error(responseTooLarge);
      chunks.push(item.value);
    }
  } finally {
    // A stalled or failed cancellation cannot hang enrollment or replace its outcome.
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The client owns cancellation and error redaction; the store owns native persistence. */
export async function prepareNodeIdentity(
  env: NodeEnv,
  store: NodeCredentialStore,
  logger: OpenBotLogger,
  signal: AbortSignal,
): Promise<string> {
  if (env.OPENBOT_NODE_CREDENTIAL !== undefined) {
    // Programmatic clients must obey the same identity-source boundary as the CLI schema.
    if (
      env.OPENBOT_NODE_ALLOW_ENV_CREDENTIAL !== true ||
      env.OPENBOT_NODE_CREDENTIAL_STORE !== "file"
    )
      throw new Error("Environment Node credentials are not enabled for this profile.");
    logger.warn(
      "node.environment_credential_enabled",
      "Using an explicitly enabled environment credential. Prefer enrollment with a persistent credential store.",
      { nodeId: env.OPENBOT_NODE_ID, phase: "identity" },
    );
    return env.OPENBOT_NODE_CREDENTIAL;
  }
  const stored = await store.load(env.OPENBOT_NODE_ID);
  if (stored !== undefined) return stored.credential;
  const token = env.OPENBOT_NODE_ENROLLMENT_TOKEN;
  if (token === undefined) throw new NodeEnrollmentRequiredError();
  signal.throwIfAborted();
  const response = await fetch(nodeEnrollmentUrl(env.OPENBOT_NODE_SERVER_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId: env.OPENBOT_NODE_ID, token }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(enrollmentTimeoutMs)]),
  });
  const body = await readBoundedResponse(response, maximumEnrollmentResponseBytes);
  if (!response.ok) throw new Error("Server rejected the one-time Node enrollment token.");
  const parsed = nodeEnrollmentResultSchema.safeParse(JSON.parse(body));
  if (!parsed.success || parsed.data.nodeId !== env.OPENBOT_NODE_ID)
    throw new Error("Server returned an invalid Node identity.");
  await store.save(parsed.data);
  return parsed.data.credential;
}
