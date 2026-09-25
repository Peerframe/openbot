import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parseBrowserClickInstruction } from "@openbot/protocol";
import type { ComputerProvider, ProviderArtifact, ProviderRunInput } from "@openbot/provider-sdk";
import { BrowserCoordinator } from "./browser.js";
import { computerRequest } from "./computer-request.js";
import { commitReviewedClick, prepareReviewedClick } from "./reviewed-click.js";

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface DockerProviderOptions {
  computerUrl: string;
  computerToken: string;
  enableBrowserSessions?: boolean;
  allowPrivateHosts?: boolean;
  inputOrigins?: string[];
  fetcher?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export function createDockerProvider(options: DockerProviderOptions): ComputerProvider {
  const fetcher = options.fetcher ?? fetch;
  const resolveHost = options.resolveHost ?? resolveHostname;
  const inputOrigins = new Set(options.inputOrigins ?? []);
  for (const origin of inputOrigins) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))
    )
      throw new Error("Browser input origins must be exact HTTPS or loopback origins.");
  }
  const activeBots = new Set<string>();
  const computerUrl = options.computerUrl.replace(/\/$/, "");

  const browser = new BrowserCoordinator(
    (botId, path, signal, body) =>
      computerRequest(
        fetcher,
        `${computerUrl}${path}`,
        options.computerToken,
        botId,
        signal,
        body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
      ),
    (url) => {
      const target = new URL(url);
      if (!["http:", "https:"].includes(target.protocol))
        throw new Error("Only HTTP(S) navigation is supported.");
      if (target.username || target.password)
        throw new Error("Navigation URLs must not contain credentials.");
      return assertNavigationAllowed(target, options.allowPrivateHosts === true, resolveHost);
    },
  );
  return {
    ...(options.enableBrowserSessions === true
      ? { browser: (command, signal) => browser.command(command, signal) }
      : {}),
    id: "docker",
    displayName: "CopilotKit/OpenBot agent-computer",
    platforms: ["linux", "windows", "macos"],
    capabilities: ["browser", "screenshot"],
    capabilityManifest: [
      ...(options.enableBrowserSessions === true
        ? [{ id: "browser.session" as const, version: 1, providerId: "docker", constraints: {} }]
        : []),
      { id: "browser.observe", version: 1, providerId: "docker", constraints: {} },
      { id: "screen.capture", version: 1, providerId: "docker", constraints: {} },
      ...(inputOrigins.size
        ? [
            {
              id: "browser.input" as const,
              version: 1,
              providerId: "docker",
              constraints: { operation: "click", explicitOrigins: true, maxClicks: 1 },
            },
          ]
        : []),
    ],
    async execute(context, input, report, reportFrame, requestApproval) {
      if (activeBots.has(input.botId))
        throw new Error("This Bot already has an active browser operation.");
      activeBots.add(input.botId);
      try {
        const click = parseBrowserClickInstruction(input.instruction);
        if (click && (!inputOrigins.has(new URL(click.target).origin) || !requestApproval))
          throw new Error("Browser input is not configured for this exact origin.");
        const prepared = await browser.run(input.botId, context.signal, async (generation) => {
          const target = extractNavigationTarget(input);
          await assertNavigationAllowed(target, options.allowPrivateHosts === true, resolveHost);

          report({ stage: "navigate", message: `正在打开 ${target.hostname}` });
          const navigation = await computerRequest<NavigationResponse>(
            fetcher,
            `${computerUrl}/navigate`,
            options.computerToken,
            input.botId,
            context.signal,
            { method: "POST", body: JSON.stringify({ url: target.href }) },
          );
          if (typeof navigation.url !== "string" || typeof navigation.title !== "string") {
            throw new Error("agent-computer returned an invalid navigation response.");
          }

          report({ stage: "screenshot", message: "正在截取浏览器画面" });
          const screenshot = await computerRequest<ScreenshotResponse>(
            fetcher,
            `${computerUrl}/screenshot`,
            options.computerToken,
            input.botId,
            context.signal,
          );
          const artifact = screenshotArtifact(input, screenshot);
          reportFrame?.({
            mediaType: "image/png",
            base64: artifact.base64,
            ...(typeof screenshot.width === "number" ? { width: screenshot.width } : {}),
            ...(typeof screenshot.height === "number" ? { height: screenshot.height } : {}),
            capturedAt:
              typeof screenshot.capturedAt === "string"
                ? screenshot.capturedAt
                : new Date().toISOString(),
          });
          if (click) {
            if (navigation.url !== click.target || !requestApproval)
              throw new Error("Navigation changed the approved target.");
            const reviewed = await prepareReviewedClick({
              ...click,
              signal: context.signal,
              screenshot,
              request: (path, body) =>
                computerRequest(
                  fetcher,
                  `${computerUrl}${path}`,
                  options.computerToken,
                  input.botId,
                  context.signal,
                  body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
                  path === "/screenshot" ? 8 * 1024 * 1024 : 256 * 1024,
                ),
            });
            return { generation, navigation, artifact, reviewed };
          }
          return { generation, navigation, artifact, reviewed: undefined };
        });
        if (!prepared.reviewed || !click || !requestApproval) {
          return {
            ok: true,
            summary: `已打开 ${prepared.navigation.title || prepared.navigation.url} 并截取画面。`,
            artifacts: [prepared.artifact],
          };
        }
        // No Bot queue is held while the Server waits for the Owner's decision.
        context.signal.throwIfAborted();
        report({ stage: "approval", message: `等待审核按钮：${click.buttonName}` });
        const approval = await requestApproval(prepared.reviewed.action);
        const reviewed = prepared.reviewed;
        return await browser.resume(input.botId, context.signal, prepared.generation, async () => {
          await commitReviewedClick(reviewed, approval);
          const after = await computerRequest<ScreenshotResponse>(
            fetcher,
            `${computerUrl}/screenshot`,
            options.computerToken,
            input.botId,
            context.signal,
          );
          if (after.url !== click.target)
            throw new Error("Browser moved after the click; inspect it before retrying.");
          const finalArtifact = screenshotArtifact(input, after);
          reportFrame?.({
            mediaType: "image/png",
            base64: finalArtifact.base64,
            capturedAt: new Date().toISOString(),
            ...(typeof after.width === "number" ? { width: after.width } : {}),
            ...(typeof after.height === "number" ? { height: after.height } : {}),
          });
          report({ stage: "observed", message: "已执行一次批准的点击并取得结果画面。" });
          return {
            ok: true,
            summary: `已按批准点击“${click.buttonName}”一次，结果画面已附上。`,
            artifacts: [finalArtifact],
          };
        });
      } finally {
        activeBots.delete(input.botId);
      }
    },
  };
}

interface NavigationResponse {
  url?: unknown;
  title?: unknown;
}

interface ScreenshotResponse {
  base64?: unknown;
  width?: unknown;
  height?: unknown;
  capturedAt?: unknown;
  url?: unknown;
}

function extractNavigationTarget(input: ProviderRunInput): URL {
  const match = input.instruction.match(/https?:\/\/[^\s<>"']+/i);
  if (match === null) {
    throw new Error("浏览器任务必须包含一个明确的 http(s) URL；当前不会猜测或搜索目标地址。");
  }
  const raw = match[0].replace(/[),.;!?，。；！？）]+$/u, "");
  const target = new URL(raw);
  if (!(["http:", "https:"] as string[]).includes(target.protocol)) {
    throw new Error("Only http(s) navigation is supported.");
  }
  if (target.username || target.password) {
    throw new Error("Navigation URLs must not contain credentials.");
  }
  return target;
}

async function assertNavigationAllowed(
  target: URL,
  allowPrivateHosts: boolean,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<void> {
  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isAlwaysBlockedHost(hostname)) throw new Error("Cloud metadata endpoints are blocked.");
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  if (addresses.length === 0) throw new Error("The navigation host did not resolve.");
  if (addresses.some(isAlwaysBlockedHost)) throw new Error("Cloud metadata endpoints are blocked.");
  if (!allowPrivateHosts && addresses.some(isPrivateAddress)) {
    throw new Error("Private-network navigation is disabled on this Node.");
  }
}

function isAlwaysBlockedHost(hostname: string): boolean {
  return (
    hostname === "169.254.169.254" ||
    hostname === "100.100.100.200" ||
    hostname === "fd00:ec2::254" ||
    hostname === "metadata.google.internal"
  );
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : undefined);
  if (ipv4 === undefined) return false;
  const octets = ipv4.split(".").map(Number);
  const [a = -1, b = -1] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

async function resolveHostname(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function screenshotArtifact(
  input: ProviderRunInput,
  screenshot: ScreenshotResponse,
): ProviderArtifact {
  if (typeof screenshot.base64 !== "string") {
    throw new Error("agent-computer returned a screenshot without image data.");
  }
  const bytes = Buffer.from(screenshot.base64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new Error("agent-computer screenshot exceeds the 5 MiB artifact limit.");
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("agent-computer screenshot is not a PNG image.");
  }
  return {
    name: `${input.title.replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 64) || "browser"}.png`,
    mediaType: "image/png",
    base64: screenshot.base64,
    metadata: screenshotMetadata(screenshot),
  };
}

function screenshotMetadata(screenshot: ScreenshotResponse): Record<string, unknown> {
  return {
    ...(typeof screenshot.width === "number" ? { width: screenshot.width } : {}),
    ...(typeof screenshot.height === "number" ? { height: screenshot.height } : {}),
    ...(typeof screenshot.capturedAt === "string" ? { capturedAt: screenshot.capturedAt } : {}),
    ...(typeof screenshot.url === "string" ? { url: screenshot.url } : {}),
  };
}
