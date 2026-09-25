import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { macOSNodeServiceConfigFormat } from "@openbot/config";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadMacOSNodeServiceEnvironment,
  macOSNodeServiceConfigPath,
} from "./macos-service-config.js";

const temporaryDirectories: string[] = [];
const validConfig = {
  format: macOSNodeServiceConfigFormat,
  nodeId: "mac-node:primary",
  serverUrl: "wss://openbot.example.test/ws/nodes",
  maxConcurrentRuns: 2,
  logLevel: "warn",
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("macOS Node service configuration", () => {
  it.skipIf(process.platform === "win32")(
    "loads one fixed private public config into an allowlisted Node environment",
    async () => {
      const home = await createHome();
      await writeConfig(home, JSON.stringify(validConfig));

      const environment = await loadMacOSNodeServiceEnvironment({
        platform: "darwin",
        userId: process.getuid?.(),
        homeDirectory: home,
      });

      expect(environment).toEqual({
        OPENBOT_NODE_ID: validConfig.nodeId,
        OPENBOT_NODE_SERVER_URL: validConfig.serverUrl,
        OPENBOT_NODE_CREDENTIAL_STORE: "macos-host",
        OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: false,
        OPENBOT_NODE_SERVICE_CONTROL: "stdio-v3",
        OPENBOT_NODE_MAX_CONCURRENT_RUNS: 2,
        OPENBOT_NODE_WORK_DIRECTORY: join(
          home,
          "Library",
          "Application Support",
          "OpenBot",
          "Node",
          "work",
        ),
        OPENBOT_LOG_LEVEL: "warn",
        OPENBOT_DOCKER_ALLOW_PRIVATE_HOSTS: false,
        OPENBOT_DOCKER_BROWSER_SESSIONS: false,
        OPENBOT_DOCKER_INPUT_ORIGINS: [],
      });
      expect(environment).not.toHaveProperty("OPENBOT_NODE_CREDENTIAL");
      expect(environment).not.toHaveProperty("OPENBOT_NODE_ENROLLMENT_TOKEN");
      expect(environment).not.toHaveProperty("OPENBOT_NODE_CREDENTIAL_PATH");
    },
  );

  it("rejects another platform, root, relative home, or a missing config", async () => {
    const home = await createHome();
    await expect(
      loadMacOSNodeServiceEnvironment({ platform: "linux", userId: 501, homeDirectory: home }),
    ).rejects.toThrow("requires macOS");
    await expect(
      loadMacOSNodeServiceEnvironment({ platform: "darwin", userId: 0, homeDirectory: home }),
    ).rejects.toThrow("non-root");
    await expect(
      loadMacOSNodeServiceEnvironment({
        platform: "darwin",
        userId: 501,
        homeDirectory: "relative/home",
      }),
    ).rejects.toThrow("home directory is invalid");
    await expect(
      loadMacOSNodeServiceEnvironment({
        platform: "darwin",
        userId: process.getuid?.() ?? 501,
        homeDirectory: home,
      }),
    ).rejects.toThrow("configuration is unavailable");
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlink, hard-link, exposed, empty, oversized, invalid UTF-8, and unknown fields",
    async () => {
      const cases: Array<(home: string) => Promise<void>> = [
        async (home) => {
          const target = join(home, "target.json");
          await writeFile(target, JSON.stringify(validConfig), { mode: 0o600 });
          await mkdir(join(macOSNodeServiceConfigPath(home), ".."), {
            recursive: true,
            mode: 0o700,
          });
          await symlink(target, macOSNodeServiceConfigPath(home));
        },
        async (home) => {
          const target = join(home, "target.json");
          await writeFile(target, JSON.stringify(validConfig), { mode: 0o600 });
          await mkdir(join(macOSNodeServiceConfigPath(home), ".."), {
            recursive: true,
            mode: 0o700,
          });
          await link(target, macOSNodeServiceConfigPath(home));
        },
        async (home) => {
          await writeConfig(home, JSON.stringify(validConfig));
          await chmod(macOSNodeServiceConfigPath(home), 0o644);
        },
        async (home) => writeConfig(home, ""),
        async (home) => writeConfig(home, "x".repeat(16 * 1024 + 1)),
        async (home) => writeConfig(home, Buffer.from([0xff])),
        async (home) => writeConfig(home, JSON.stringify({ ...validConfig, credential: "secret" })),
      ];

      for (const prepare of cases) {
        const home = await createHome();
        await prepare(home);
        await expect(
          loadMacOSNodeServiceEnvironment({
            platform: "darwin",
            userId: process.getuid?.(),
            homeDirectory: home,
          }),
        ).rejects.toThrow(/configuration/);
      }
    },
  );
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "openbot-macos-home-"));
  temporaryDirectories.push(home);
  return home;
}

async function writeConfig(home: string, content: string | Uint8Array): Promise<void> {
  const path = macOSNodeServiceConfigPath(home);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
}
