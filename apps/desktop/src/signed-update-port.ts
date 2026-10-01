import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { DesktopUpdaterPort } from "./desktop-updates.js";
import type { DesktopUpdateState } from "./runtime-contract.js";

export interface SignedUpdateConfiguration {
  openbotFormat: "openbot.signed-updates/v1";
  provider: "github";
  owner: "Peerframe";
  repo: "openbot";
  channel: "alpha" | "latest";
  publisherName?: string[];
  macTeamIdentifier?: string;
}
export function parseSignedUpdateConfiguration(
  text: string,
  platform: string,
): SignedUpdateConfiguration {
  if (Buffer.byteLength(text) > 4096) throw new Error("Update configuration is oversized.");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid update configuration.");
  const item = value as Record<string, unknown>;
  const signer = platform === "darwin" ? "macTeamIdentifier" : "publisherName";
  if (
    !["darwin", "win32"].includes(platform) ||
    Object.keys(item).sort().join(",") !==
      ["openbotFormat", "provider", "owner", "repo", "channel", signer].sort().join(",") ||
    item.openbotFormat !== "openbot.signed-updates/v1" ||
    item.provider !== "github" ||
    item.owner !== "Peerframe" ||
    item.repo !== "openbot" ||
    !["alpha", "latest"].includes(String(item.channel))
  )
    throw new Error("Untrusted update configuration.");
  if (
    platform === "darwin" &&
    (typeof item.macTeamIdentifier !== "string" || !/^[A-Z0-9]{10}$/u.test(item.macTeamIdentifier))
  )
    throw new Error("Missing Developer ID team.");
  if (
    platform === "win32" &&
    (!Array.isArray(item.publisherName) ||
      item.publisherName.length < 1 ||
      item.publisherName.length > 8 ||
      item.publisherName.some(
        (name: unknown) =>
          typeof name !== "string" ||
          name.length < 1 ||
          name.length > 200 ||
          /[\r\n\0]/u.test(name),
      ))
  )
    throw new Error("Missing Windows publisher.");
  return item as unknown as SignedUpdateConfiguration;
}

export async function verifyRunningUpdateSignature(
  configuration: SignedUpdateConfiguration,
  platform: string,
  executable: string,
): Promise<void> {
  const run = promisify(execFile);
  if (platform === "darwin") {
    const application = dirname(dirname(dirname(executable)));
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", application], {
      timeout: 10000,
      maxBuffer: 32768,
    });
    const { stderr } = await run("/usr/bin/codesign", ["--display", "--verbose=4", application], {
      timeout: 10000,
      maxBuffer: 32768,
    });
    if (
      !/^Authority=Developer ID Application:/mu.test(stderr) ||
      !stderr.split(/\r?\n/u).includes(`TeamIdentifier=${configuration.macTeamIdentifier}`)
    )
      throw new Error("Unsigned or different Developer ID application.");
  } else if (platform === "win32") {
    const literal = executable.replaceAll("'", "''");
    const command =
      "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath '" +
      literal +
      "'; if($s.Status -ne 'Valid' -or !$s.SignerCertificate){exit 1}; $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)|ConvertTo-Json -Compress";
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { timeout: 10000, maxBuffer: 32768, windowsHide: true },
    );
    if (!configuration.publisherName?.includes(JSON.parse(stdout.trim())))
      throw new Error("Unsigned or different Windows publisher.");
  } else throw new Error("Unsupported update platform.");
}

export async function createSignedUpdaterPort(options: {
  packaged: boolean;
  platform: string;
  resources: string;
  executable: string;
}): Promise<{ port?: DesktopUpdaterPort; code?: DesktopUpdateState["code"] }> {
  if (!options.packaged) return { code: "not_packaged" };
  if (!["darwin", "win32"].includes(options.platform)) return { code: "unsupported_platform" };
  const path = join(options.resources, "app-update.yml");
  let configuration: SignedUpdateConfiguration;
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4096) throw new Error();
    // JSON is a YAML subset understood by electron-updater; no mutable URL/token/custom header.
    configuration = parseSignedUpdateConfiguration(await readFile(path, "utf8"), options.platform);
  } catch {
    return { code: "configuration_unavailable" };
  }
  try {
    await verifyRunningUpdateSignature(configuration, options.platform, options.executable);
  } catch {
    return { code: "signing_unavailable" };
  }
  const module = await import("electron-updater");
  const updater =
    options.platform === "darwin" ? new module.MacUpdater() : new module.NsisUpdater();
  updater.updateConfigPath = path;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = configuration.channel === "alpha";
  updater.channel = configuration.channel;
  // Prevent package logs from exposing URLs, release text or native paths to default logs.
  updater.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  return {
    port: {
      async check() {
        const result = await updater.checkForUpdates();
        return result
          ? { available: result.isUpdateAvailable, version: result.updateInfo.version }
          : undefined;
      },
      async download() {
        await updater.downloadUpdate();
      },
      install() {
        updater.quitAndInstall();
      },
      subscribe(listener) {
        const progress = (info: { percent: number }) =>
          listener({ status: "downloaded", percent: info.percent });
        const downloaded = (info: { version: string }) =>
          listener({ status: "downloaded", version: info.version });
        const error = () => listener({ status: "failed" });
        updater.on("download-progress", progress);
        updater.on("update-downloaded", downloaded);
        updater.on("error", error);
        return () => {
          updater.removeListener("download-progress", progress);
          updater.removeListener("update-downloaded", downloaded);
          updater.removeListener("error", error);
        };
      },
    },
  };
}
