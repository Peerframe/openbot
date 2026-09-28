import { isJsonContentType, readBoundedText } from "./bounded-response.js";
import type { DesktopConnectionState, DesktopServerFetcher } from "./connection-controller.js";
import { proxyDesktopServerRequest } from "./server-proxy.js";

const MAXIMUM_DESKTOP_ACTION_RESPONSE_BYTES = 4 * 1024;
const enrollmentTokenPattern = /^obenr_[A-Za-z0-9_-]+$/u;

export type DesktopEnrollmentTokenResult =
  | Readonly<{ status: "issued"; token: string }>
  | Readonly<{ status: "authentication-required" | "server-unavailable" }>;

export async function isDesktopSessionAuthenticated(
  connection: DesktopConnectionState,
  fetcher: DesktopServerFetcher,
): Promise<boolean> {
  const response = await proxyDesktopServerRequest(
    new Request("openbot://app/api/v1/auth/session", {
      headers: { Accept: "application/json" },
    }),
    connection,
    fetcher,
  );
  if (response?.status !== 200 || !isJsonContentType(response.headers.get("content-type")))
    return false;
  try {
    const value = JSON.parse(
      await readBoundedText(response, MAXIMUM_DESKTOP_ACTION_RESPONSE_BYTES),
    ) as unknown;
    return isRecord(value) && value.authenticated === true;
  } catch {
    return false;
  }
}

export async function issueDesktopNodeEnrollmentToken(
  nodeId: string,
  connection: DesktopConnectionState,
  fetcher: DesktopServerFetcher,
  now = Date.now(),
): Promise<DesktopEnrollmentTokenResult> {
  const response = await proxyDesktopServerRequest(
    new Request("openbot://app/api/v1/nodes/enrollment-tokens", {
      body: JSON.stringify({ expiresInSeconds: 600, nodeId }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    }),
    connection,
    fetcher,
  );
  if (response?.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    return Object.freeze({ status: "authentication-required" });
  }
  if (response?.status !== 201 || !isJsonContentType(response.headers.get("content-type"))) {
    await response?.body?.cancel().catch(() => undefined);
    return Object.freeze({ status: "server-unavailable" });
  }

  try {
    const value = JSON.parse(
      await readBoundedText(response, MAXIMUM_DESKTOP_ACTION_RESPONSE_BYTES),
    ) as unknown;
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !== "expiresAt,nodeId,token" ||
      value.nodeId !== nodeId ||
      typeof value.token !== "string" ||
      value.token.length < 48 ||
      value.token.length > 256 ||
      !enrollmentTokenPattern.test(value.token) ||
      typeof value.expiresAt !== "string"
    ) {
      return Object.freeze({ status: "server-unavailable" });
    }
    const expiresAt = Date.parse(value.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 11 * 60 * 1_000) {
      return Object.freeze({ status: "server-unavailable" });
    }
    return Object.freeze({ status: "issued", token: value.token });
  } catch {
    return Object.freeze({ status: "server-unavailable" });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
