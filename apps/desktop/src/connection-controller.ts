import { discardBody, isJsonContentType, readBoundedText } from "./bounded-response.js";
import {
  createDesktopConnectionConfig,
  type DesktopConnectionStore,
  normalizeDesktopServerUrl,
} from "./connection-config.js";

export const MAXIMUM_DESKTOP_HEALTH_RESPONSE_BYTES = 4 * 1024;
export const DESKTOP_SERVER_HEALTH_TIMEOUT_MS = 5_000;

export type DesktopConnectionState =
  | Readonly<{ status: "unconfigured" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "configured"; serverUrl: string }>;

export type DesktopConnectionFailureCode =
  | "invalid_url"
  | "server_unreachable"
  | "server_redirected"
  | "not_openbot_server"
  | "confirmation_unavailable"
  | "storage_unavailable";

export type ConfigureDesktopServerResult =
  | Readonly<{ status: "configured"; serverUrl: string }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "failed"; code: DesktopConnectionFailureCode }>;

export type DesktopServerFetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface DesktopConnectionControllerOptions {
  clearSessionData(): Promise<void>;
  confirmServer(serverUrl: string): Promise<boolean>;
  fetch: DesktopServerFetcher;
  store: DesktopConnectionStore;
}

export class DesktopConnectionController {
  readonly #options: DesktopConnectionControllerOptions;
  #state: DesktopConnectionState = unconfiguredState();

  constructor(options: DesktopConnectionControllerOptions) {
    this.#options = options;
  }

  async initialize(): Promise<DesktopConnectionState> {
    try {
      const config = await this.#options.store.load();
      this.#state = config ? configuredState(config.serverUrl) : unconfiguredState();
    } catch {
      this.#state = invalidState();
    }
    return this.getState();
  }

  getState(): DesktopConnectionState {
    if (this.#state.status === "configured") return configuredState(this.#state.serverUrl);
    return this.#state.status === "invalid" ? invalidState() : unconfiguredState();
  }

  getServerUrl(): string | undefined {
    return this.#state.status === "configured" ? this.#state.serverUrl : undefined;
  }

  async configure(input: unknown): Promise<ConfigureDesktopServerResult> {
    let serverUrl: string;
    try {
      serverUrl = normalizeDesktopServerUrl(input);
    } catch {
      return failedResult("invalid_url");
    }

    const healthFailure = await verifyDesktopServer(this.#options.fetch, serverUrl);
    if (healthFailure !== undefined) return failedResult(healthFailure);

    let confirmed: boolean;
    try {
      confirmed = await this.#options.confirmServer(serverUrl);
    } catch {
      return failedResult("confirmation_unavailable");
    }
    if (!confirmed) return Object.freeze({ status: "cancelled" });

    if (this.#state.status === "configured" && this.#state.serverUrl === serverUrl) {
      return configuredState(serverUrl);
    }

    try {
      await this.#options.clearSessionData();
      await this.#options.store.save(createDesktopConnectionConfig(serverUrl));
    } catch {
      return failedResult("storage_unavailable");
    }

    this.#state = configuredState(serverUrl);
    return configuredState(serverUrl);
  }
}

export async function verifyDesktopServer(
  fetcher: DesktopServerFetcher,
  serverUrl: string,
): Promise<DesktopConnectionFailureCode | undefined> {
  let response: Response;
  try {
    response = await fetcher(`${normalizeDesktopServerUrl(serverUrl)}/health`, {
      credentials: "omit",
      headers: { Accept: "application/json" },
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(DESKTOP_SERVER_HEALTH_TIMEOUT_MS),
    });
  } catch {
    return "server_unreachable";
  }

  if (response.status >= 300 && response.status < 400) {
    discardBody(response.body);
    return "server_redirected";
  }
  if (response.status !== 200 || !isJsonContentType(response.headers.get("content-type"))) {
    discardBody(response.body);
    return "not_openbot_server";
  }

  let body: string;
  try {
    body = await readBoundedText(response, MAXIMUM_DESKTOP_HEALTH_RESPONSE_BYTES);
  } catch {
    return "not_openbot_server";
  } finally {
    discardBody(response.body);
  }

  try {
    const value = JSON.parse(body) as unknown;
    if (!isRecord(value) || value.ok !== true || value.service !== "openbot-server") {
      return "not_openbot_server";
    }
  } catch {
    return "not_openbot_server";
  }
  return undefined;
}

function configuredState(serverUrl: string): Readonly<{ status: "configured"; serverUrl: string }> {
  return Object.freeze({ status: "configured", serverUrl });
}

function unconfiguredState(): Readonly<{ status: "unconfigured" }> {
  return Object.freeze({ status: "unconfigured" });
}

function invalidState(): Readonly<{ status: "invalid" }> {
  return Object.freeze({ status: "invalid" });
}

function failedResult(
  code: DesktopConnectionFailureCode,
): Readonly<{ status: "failed"; code: DesktopConnectionFailureCode }> {
  return Object.freeze({ status: "failed", code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
