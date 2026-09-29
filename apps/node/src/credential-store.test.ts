import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWindowsCredentialPathBoundary,
  type CredentialHelper,
  FileNodeCredentialStore,
  LinuxSecretServiceNodeCredentialStore,
  MacOSHostNodeCredentialStore,
  runCredentialHelper,
  type WindowsCredentialAcl,
} from "./credential-store.js";

const temporaryDirectories: string[] = [];
const executeFile = promisify(execFile);
/** Per-spawn PowerShell deadline, matching production `executeFile` in `@openbot/windows-secret-acl`. */
const POWERSHELL_SPAWN_TIMEOUT_MS = 15_000;
/**
 * Bounded native-test harness deadline for the two Node Windows ACL negatives only.
 * Worst case ≤7 PowerShell spawns × 15s production cap = 105s, plus 15s runner margin → 120s.
 * See docs/research/windows-native-acl-test-budget.md (Node follow-up).
 */
const NATIVE_TIMEOUT_MS = 120_000;
/** Save (2) plus two loads (2 each) use six native ACL spawns on Windows.
 * Reuse the same per-spawn budget and 15s margin; other hosts retain Vitest's default.
 * See docs/research/windows-native-acl-test-budget.md; no ACL assertions are mocked here.
 */
const NATIVE_ROUND_TRIP_TIMEOUT_MS =
  process.platform === "win32" ? 6 * POWERSHELL_SPAWN_TIMEOUT_MS + 15_000 : undefined;

/**
 * Broaden a credential path DACL for native negative tests.
 * Matches production/Server spawn hygiene: inbox powershell.exe, shell:false, stdin closed, 15s cap.
 * Uses fixed .NET FileInfo/DirectoryInfo constructors + GetAccessControl/SetAccessControl — same
 * as production scripts; avoids cmdlet-based ACL/item helpers that auto-load modules under CI.
 */
async function broadenAcl(targetPath: string, kind: "file" | "directory"): Promise<void> {
  const broaden =
    kind === "file"
      ? `
$ErrorActionPreference = 'Stop'
$path = $env:OPENBOT_TEST_PATH
$item = [IO.FileInfo]::new($path)
$acl = $item.GetAccessControl()
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
  [void]$acl.RemoveAccessRule($rule)
}
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone, 'FullControl', 'None', 'None', 'Allow'))
$item.SetAccessControl($acl)
`
      : `
$ErrorActionPreference = 'Stop'
$path = $env:OPENBOT_TEST_PATH
$item = [IO.DirectoryInfo]::new($path)
$acl = $item.GetAccessControl()
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
  [void]$acl.RemoveAccessRule($rule)
}
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
$item.SetAccessControl($acl)
`;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) throw new Error("Windows SystemRoot is required for broadenAcl.");
  const powershell = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const operation = executeFile(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(broaden, "utf16le").toString("base64"),
    ],
    {
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        OPENBOT_TEST_PATH: targetPath,
      },
      windowsHide: true,
      shell: false,
      timeout: POWERSHELL_SPAWN_TIMEOUT_MS,
      maxBuffer: 4096,
    },
  );
  // Same as production runWindowsSecretAclScript: close stdin so PowerShell does not wait on pipe EOF.
  operation.child.stdin?.end();
  await operation;
}

/** realpath-normalized temp root so reparse walks do not see unrelated system symlinks. */
async function realpathTempRoot(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-node-identity-")));
  temporaryDirectories.push(directory);
  return directory;
}
const identity = {
  format: "openbot.node-identity/v1" as const,
  nodeId: "linux-node",
  credential: `obn_${"a".repeat(43)}`,
  enrolledAt: "2026-09-04T00:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("file Node credential store", () => {
  it(
    "atomically persists and reloads a bounded identity document",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "openbot-node-identity-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "private", "identity.json");
      const store = new FileNodeCredentialStore(path);

      expect(await store.load("linux-node")).toBeUndefined();
      await store.save(identity);
      expect(await store.load("linux-node")).toEqual(identity);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(identity);
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(store.load("other-node")).rejects.toThrow("different Node id");
    },
    NATIVE_ROUND_TRIP_TIMEOUT_MS,
  );

  it.skipIf(process.platform === "win32")(
    "refuses a credential that became accessible to other POSIX users",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "openbot-node-identity-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "identity.json");
      const store = new FileNodeCredentialStore(path);

      await store.save(identity);
      await chmod(path, 0o644);

      await expect(store.load(identity.nodeId)).rejects.toThrow("group or other users");
    },
  );

  it.skipIf(process.platform === "win32")("refuses a symbolic-link credential path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-node-identity-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "target.json");
    const path = join(directory, "identity.json");
    await writeFile(target, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
    await symlink(target, path);

    await expect(new FileNodeCredentialStore(path).load(identity.nodeId)).rejects.toThrow(
      "regular file",
    );
  });

  it("on win32 protects and verifies Owner+SYSTEM ACLs through the injected helper", async () => {
    const directory = await realpathTempRoot();
    const path = join(directory, "private", "identity.json");
    const calls: string[] = [];
    const windowsAcl: WindowsCredentialAcl = {
      async protectDirectory(target, created) {
        calls.push(`dir:${created ? "new" : "existing"}:${target.endsWith("private")}`);
      },
      async verifyDirectory(target) {
        calls.push(`dir-verify:${target.endsWith("private")}`);
      },
      async protectAndVerifyFile(target) {
        calls.push(`file-protect:${target.endsWith("identity.json")}`);
      },
      async verifyFile(target) {
        calls.push(`file-verify:${target.endsWith("identity.json")}`);
      },
    };
    const store = new FileNodeCredentialStore(path, {
      platform: "win32",
      windowsAcl,
      windowsTrustRoot: directory,
    });

    await store.save(identity);
    expect(await store.load(identity.nodeId)).toEqual(identity);
    expect(calls[0]).toMatch(/^dir:new:true$/);
    expect(calls[1]).toBe("file-protect:true");
    expect(calls[2]).toBe("dir-verify:true");
    expect(calls[3]).toBe("file-verify:true");

    calls.length = 0;
    await store.save(identity);
    expect(calls[0]).toMatch(/^dir:existing:true$/);
    expect(calls[1]).toBe("file-protect:true");
  });

  it("on win32 refuses load when the ACL helper reports an unsafe file", async () => {
    const directory = await realpathTempRoot();
    const path = join(directory, "identity.json");
    await writeFile(path, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
    const store = new FileNodeCredentialStore(path, {
      platform: "win32",
      windowsTrustRoot: directory,
      windowsAcl: {
        protectDirectory: async () => {},
        verifyDirectory: async () => {},
        protectAndVerifyFile: async () => {},
        verifyFile: async () => {
          throw new Error("Windows credential file ACL verification failed during reading.");
        },
      },
    });

    const rejection = expect(store.load(identity.nodeId)).rejects;
    await rejection.toThrow("ACL verification failed during reading");
    await rejection.not.toThrow(identity.credential);
  });

  it.skipIf(process.platform !== "win32")(
    "natively enforces Owner+SYSTEM ACLs for Windows credential files",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "openbot-node-identity-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "private", "identity.json");
      const store = new FileNodeCredentialStore(path);

      await store.save(identity);
      expect(await store.load(identity.nodeId)).toEqual(identity);

      // Content unchanged — only broaden the credential file DACL.
      await broadenAcl(path, "file");

      const rejection = expect(store.load(identity.nodeId)).rejects;
      await rejection.toThrow("ACL verification failed");
      await rejection.not.toThrow(identity.credential);
    },
    NATIVE_TIMEOUT_MS,
  );

  it(
    "refuses directories, oversized content, and malformed packages",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "openbot-node-identity-"));
      temporaryDirectories.push(directory);

      const asDirectory = join(directory, "not-a-file");
      await mkdir(asDirectory);
      await expect(new FileNodeCredentialStore(asDirectory).load(identity.nodeId)).rejects.toThrow(
        "regular file",
      );

      // Fresh nested path so Windows creates+protects the dedicated directory (verify-only on an
      // already-existing temp parent would fail closed by design).
      const path = join(directory, "private", "identity.json");
      const store = new FileNodeCredentialStore(path);
      await store.save(identity);
      await writeFile(path, "x".repeat(4 * 1024 + 1), { mode: 0o600 });
      await expect(store.load(identity.nodeId)).rejects.toThrow("4 KiB limit");

      await writeFile(path, "{}\n", { mode: 0o600 });
      await expect(store.load(identity.nodeId)).rejects.toThrow("invalid");
    },
    NATIVE_ROUND_TRIP_TIMEOUT_MS,
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlink ancestor within a realpath trust root",
    async () => {
      const root = await realpathTempRoot();
      const realDirectory = join(root, "real");
      const linkDirectory = join(root, "link");
      await mkdir(realDirectory);
      await symlink(realDirectory, linkDirectory);
      const path = join(linkDirectory, "identity.json");
      await writeFile(join(realDirectory, "identity.json"), `${JSON.stringify(identity)}\n`, {
        mode: 0o600,
      });

      await expect(assertWindowsCredentialPathBoundary(path, { trustRoot: root })).rejects.toThrow(
        "reparse points",
      );
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects a parent directory junction created with mklink /J",
    async () => {
      const root = await realpathTempRoot();
      const realDirectory = join(root, "real");
      const linkDirectory = join(root, "link");
      await mkdir(realDirectory);
      await writeFile(join(realDirectory, "identity.json"), `${JSON.stringify(identity)}\n`, {
        mode: 0o600,
      });
      await executeFile("cmd.exe", ["/c", "mklink", "/J", linkDirectory, realDirectory], {
        windowsHide: true,
      });

      const path = join(linkDirectory, "identity.json");
      await expect(assertWindowsCredentialPathBoundary(path, { trustRoot: root })).rejects.toThrow(
        "reparse points",
      );

      const store = new FileNodeCredentialStore(path, {
        platform: "win32",
        windowsTrustRoot: root,
        windowsAcl: {
          protectDirectory: async () => {},
          verifyDirectory: async () => {},
          protectAndVerifyFile: async () => {},
          verifyFile: async () => {},
        },
      });
      await expect(store.load(identity.nodeId)).rejects.toThrow("reparse points");
    },
    30_000,
  );

  it.skipIf(process.platform !== "win32")(
    "natively refuses load when the parent directory ACL is broadened",
    async () => {
      const root = await realpathTempRoot();
      const path = join(root, "private", "identity.json");
      const store = new FileNodeCredentialStore(path);
      await store.save(identity);
      expect(await store.load(identity.nodeId)).toEqual(identity);

      // Content unchanged — only broaden the parent directory DACL.
      await broadenAcl(join(root, "private"), "directory");

      const rejection = expect(store.load(identity.nodeId)).rejects;
      await rejection.toThrow("directory ACL verification failed");
      await rejection.not.toThrow(identity.credential);
    },
    NATIVE_TIMEOUT_MS,
  );

  it("on win32 verifies existing directories without rewriting ACLs via the helper contract", async () => {
    const directory = await realpathTempRoot();
    const privateDirectory = join(directory, "private");
    await mkdir(privateDirectory, { mode: 0o700 });
    const path = join(privateDirectory, "identity.json");
    const calls: string[] = [];
    const store = new FileNodeCredentialStore(path, {
      platform: "win32",
      windowsTrustRoot: directory,
      windowsAcl: {
        async protectDirectory(_target, created) {
          calls.push(`dir:${created ? "new" : "existing"}`);
        },
        async verifyDirectory() {
          calls.push("dir-verify");
        },
        async protectAndVerifyFile() {
          calls.push("file-protect");
        },
        async verifyFile() {
          calls.push("file-verify");
        },
      },
    });

    await store.save(identity);
    expect(calls).toEqual(["dir:existing", "file-protect"]);
  });

  it("on win32 refuses load when the parent directory ACL helper reports unsafe Write/DeleteChild rights", async () => {
    const directory = await realpathTempRoot();
    const path = join(directory, "private", "identity.json");
    await mkdir(join(directory, "private"), { mode: 0o700 });
    await writeFile(path, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
    const store = new FileNodeCredentialStore(path, {
      platform: "win32",
      windowsTrustRoot: directory,
      windowsAcl: {
        protectDirectory: async () => {},
        verifyDirectory: async () => {
          throw new Error("Windows credential directory ACL verification failed during reading.");
        },
        protectAndVerifyFile: async () => {},
        verifyFile: async () => {},
      },
    });

    const rejection = expect(store.load(identity.nodeId)).rejects;
    await rejection.toThrow("directory ACL verification failed during reading");
    await rejection.not.toThrow(identity.credential);
  });

  it("allowMissingLeaf accepts first-install multi-level missing segments under a trust root", async () => {
    const root = await realpathTempRoot();
    const nested = join(root, "a", "b", "c");
    await expect(
      assertWindowsCredentialPathBoundary(nested, { allowMissingLeaf: true, trustRoot: root }),
    ).resolves.toBeUndefined();
    await expect(
      assertWindowsCredentialPathBoundary(nested, { trustRoot: root }),
    ).rejects.toThrow();
  });
});

describe("Linux Secret Service Node credential store", () => {
  it("stores through stdin and verifies the exact identity before returning", async () => {
    const requests: Parameters<CredentialHelper>[0][] = [];
    let stored = "";
    const helper: CredentialHelper = async (request) => {
      requests.push(request);
      if (request.arguments[0] === "store") {
        stored = request.input ?? "";
        return helperResult();
      }
      return helperResult({ stdout: Buffer.from(stored) });
    };
    const store = new LinuxSecretServiceNodeCredentialStore({ platform: "linux", helper });

    await store.save(identity);
    expect(await store.load(identity.nodeId)).toEqual(identity);
    expect(requests).toHaveLength(3);
    expect(requests[0]?.executable).toBe("/usr/bin/secret-tool");
    expect(requests[0]?.arguments).toEqual([
      "store",
      "--label=OpenBot Node linux-node",
      "application",
      "openbot",
      "kind",
      "node-identity",
      "format",
      "openbot.node-identity/v1",
      "node",
      "linux-node",
    ]);
    expect(requests[0]?.input).toBe(JSON.stringify(identity));
    expect(requests[0]?.arguments).not.toContain(identity.credential);
    expect(requests[1]?.arguments[0]).toBe("lookup");
    expect(requests[1]?.input).toBeUndefined();
  });

  it("recognizes only the reviewed empty exit-1 lookup as missing", async () => {
    const store = new LinuxSecretServiceNodeCredentialStore({
      platform: "linux",
      helper: async () => helperResult({ exitCode: 1 }),
    });
    await expect(store.load(identity.nodeId)).resolves.toBeUndefined();

    for (const result of [
      helperResult({ exitCode: 1, stderr: Buffer.from("token=helper-secret") }),
      helperResult({ exitCode: 1, stdout: Buffer.from("ambiguous") }),
      helperResult({ exitCode: 2 }),
      helperResult({ exitCode: null, signal: "SIGTERM" }),
    ]) {
      const failing = new LinuxSecretServiceNodeCredentialStore({
        platform: "linux",
        helper: async () => result,
      });
      const rejection = expect(failing.load(identity.nodeId)).rejects;
      await rejection.toThrow("Linux Secret Service operation failed.");
      await rejection.not.toThrow("helper-secret");
    }
  });

  it("rejects invalid, wrong-node, and unverified stored identities", async () => {
    const invalid = new LinuxSecretServiceNodeCredentialStore({
      platform: "linux",
      helper: async () => helperResult({ stdout: Buffer.from("not-json") }),
    });
    await expect(invalid.load(identity.nodeId)).rejects.toThrow(
      "Node credential Secret Service is invalid.",
    );

    const wrongNode = new LinuxSecretServiceNodeCredentialStore({
      platform: "linux",
      helper: async () =>
        helperResult({
          stdout: Buffer.from(JSON.stringify({ ...identity, nodeId: "other-node" })),
        }),
    });
    await expect(wrongNode.load(identity.nodeId)).rejects.toThrow("different Node id");

    const notRetained = new LinuxSecretServiceNodeCredentialStore({
      platform: "linux",
      helper: async (request) =>
        request.arguments[0] === "store" ? helperResult() : helperResult({ exitCode: 1 }),
    });
    await expect(notRetained.save(identity)).rejects.toThrow("did not retain");
  });

  it("refuses unsupported platforms before invoking a helper", () => {
    expect(() => new LinuxSecretServiceNodeCredentialStore({ platform: "darwin" })).toThrow(
      "require Linux",
    );
  });
});

describe("macOS Host Node credential store", () => {
  it("provides one validated identity exactly once", async () => {
    const store = new MacOSHostNodeCredentialStore(identity, { platform: "darwin" });

    await expect(store.load(identity.nodeId)).resolves.toEqual(identity);
    await expect(store.load(identity.nodeId)).rejects.toThrow("already consumed");
    await expect(store.save(identity)).rejects.toThrow("cannot enroll or replace");
  });

  it("rejects another platform or Node id", async () => {
    expect(() => new MacOSHostNodeCredentialStore(identity, { platform: "linux" })).toThrow(
      "requires macOS",
    );
    const wrongNode = new MacOSHostNodeCredentialStore(identity, { platform: "darwin" });
    await expect(wrongNode.load("other-node")).rejects.toThrow("different Node id");
  });
});

// Hosted runners may take over a second to start Node and drain its pipes under parallel load.
// Keep real-process fixtures within the existing helper ceiling; allow the harness time to observe it.
const helperFixtureTimeoutMs = 5_000;
describe("bounded credential helper", { timeout: 10_000 }, () => {
  it("sends bounded input over stdin and captures output", async () => {
    const result = await runCredentialHelper({
      executable: process.execPath,
      arguments: ["-e", "process.stdin.pipe(process.stdout)"],
      input: "test-input",
      timeoutMs: helperFixtureTimeoutMs,
      maximumBytes: 64,
    });
    expect(result).toMatchObject({ exitCode: 0, signal: null });
    expect(result.stdout.toString("utf8")).toBe("test-input");
    expect(result.stderr).toHaveLength(0);
  });

  it("fails closed when the executable is missing", async () => {
    await expect(
      runCredentialHelper({
        executable: "openbot-definitely-missing-secret-tool",
        arguments: [],
        timeoutMs: helperFixtureTimeoutMs,
        maximumBytes: 64,
      }),
    ).rejects.toThrow("helper is unavailable");
  });
  it("fails closed when the helper times out", async () => {
    await expect(
      runCredentialHelper({
        executable: process.execPath,
        arguments: ["-e", "setInterval(() => {}, 1_000)"],
        timeoutMs: 25,
        maximumBytes: 64,
      }),
    ).rejects.toThrow("timed out");
  });
  it("fails closed when helper output exceeds its bound", async () => {
    await expect(
      runCredentialHelper({
        executable: process.execPath,
        arguments: ["-e", "process.stdout.write('x'.repeat(65))"],
        timeoutMs: helperFixtureTimeoutMs,
        maximumBytes: 64,
      }),
    ).rejects.toThrow("4 KiB limit");
  });

  it("rejects unbounded helper requests before starting a process", async () => {
    await expect(
      runCredentialHelper({
        executable: process.execPath,
        arguments: [],
        input: "x".repeat(65),
        timeoutMs: 100,
        maximumBytes: 64,
      }),
    ).rejects.toThrow("request is invalid");
  });
});

function helperResult(
  overrides: Partial<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: Buffer;
    stderr: Buffer;
  }> = {},
) {
  return {
    exitCode: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    ...overrides,
  };
}
