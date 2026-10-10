import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FuseState, FuseV1Options, FuseVersion } from "@electron/fuses";
import { describe, expect, it } from "vitest";
import { parseDesktopPackageArguments } from "./package.ts";
import {
  createDesktopFuseConfig,
  DESKTOP_ICON_RESOURCE_NAME,
  DESKTOP_MACOS_WORKER_COMPANION_NAME,
  DESKTOP_PACKAGE_IDENTITY,
  DESKTOP_PREVIEW_IDENTITY,
  DESKTOP_TS_PREVIEW_IDENTITY,
  DESKTOP_RUNTIME_DEPENDENCIES,
  DESKTOP_WINDOWS_METADATA,
  desktopMacOSWorkerCompanionSource,
  desktopPackagedManifest,
  desktopPackageIdentity,
  packagedAsarPath,
  packagedDesktopMacOSWorkerCompanion,
  packagedDesktopResource,
  packagedElectronTarget,
  shouldIgnoreDesktopSource,
  validateDesktopAsarEntries,
  verifyDesktopFuses,
} from "./package-policy.ts";

describe("Desktop package source policy", () => {
  const appRoot = resolve("workspace", "apps", "desktop");

  it("selects only an explicit fixed Preview identity and preserves the production manifest", () => {
    const manifest = { name: "@openbot/desktop", version: "0.0.0", main: "dist/main.js" };
    expect(desktopPackageIdentity([])).toBe(DESKTOP_PACKAGE_IDENTITY);
    expect(desktopPackageIdentity(["--preview"])).toBe(DESKTOP_PREVIEW_IDENTITY);
    expect(desktopPackagedManifest(manifest, DESKTOP_PACKAGE_IDENTITY)).toBe(manifest);
    expect(desktopPackagedManifest(manifest, DESKTOP_PREVIEW_IDENTITY)).toEqual({
      ...manifest,
      name: "openbot-preview",
      productName: "OpenBot Preview",
    });
    expect(manifest).not.toHaveProperty("productName");
    expect(manifest.name).toBe("@openbot/desktop");
    expect(DESKTOP_PREVIEW_IDENTITY.appBundleId).not.toBe(DESKTOP_PACKAGE_IDENTITY.appBundleId);
    expect(DESKTOP_PREVIEW_IDENTITY.executableName).not.toBe(
      DESKTOP_PACKAGE_IDENTITY.executableName,
    );
    expect(() => desktopPackagedManifest(manifest, {})).toThrow(/identity/u);
    for (const args of [["--profile=/Applications"], ["--preview", "--preview"], ["--Preview"]]) {
      expect(() => desktopPackageIdentity(args)).toThrow(/only/u);
    }
  });

  it("keeps Preview resources under its own app and excludes shared Worker services", () => {
    const root = "/tmp/preview/OpenBot Preview-darwin-arm64";
    const identity = DESKTOP_PREVIEW_IDENTITY;
    expect(packagedElectronTarget(root, "darwin", identity)).toBe(
      join(root, "OpenBot Preview.app"),
    );
    expect(packagedElectronTarget(root, "win32", identity)).toBe(join(root, "OpenBot Preview.exe"));
    expect(packagedElectronTarget(root, "linux", identity)).toBe(join(root, "OpenBot Preview"));
    const resources = join(root, "OpenBot Preview.app", "Contents", "Resources");
    expect(packagedAsarPath(root, "darwin", identity)).toBe(join(resources, "app.asar"));
    expect(packagedDesktopResource(root, "darwin", "native-runtime", identity)).toBe(
      join(resources, "native-runtime"),
    );
    expect(packagedDesktopMacOSWorkerCompanion(root, "darwin", identity)).toBe(
      join(resources, DESKTOP_MACOS_WORKER_COMPANION_NAME),
    );
    expect(desktopMacOSWorkerCompanionSource(undefined, "darwin", identity)).toBeUndefined();
    expect(() =>
      desktopMacOSWorkerCompanionSource(
        resolve("workspace", DESKTOP_MACOS_WORKER_COMPANION_NAME),
        "darwin",
        identity,
      ),
    ).toThrow(/production Worker/u);
  });

  it("refuses the retired Python packaging selector", () => {
    for (const args of [["--python-product"], ["--preview", "--python-product"]])
      expect(() => desktopPackageIdentity(args)).toThrow("only");
  });

  it("isolates the TS Preview and refuses ambiguous or unsupported selection", () => {
    const args = ["--preview", "--ts-product"];
    const identity = desktopPackageIdentity(args);
    expect(identity).toBe(DESKTOP_TS_PREVIEW_IDENTITY);
    expect(desktopPackageIdentity([...args].reverse())).toBe(identity);
    const manifest = { name: "@openbot/desktop", productName: "OpenBot" };
    expect(desktopPackagedManifest(manifest, identity)).toEqual({
      ...manifest,
      name: "openbot-ts-preview",
      productName: "OpenBot TS Preview",
    });
    expect(manifest.productName).toBe("OpenBot");
    for (const retained of [
      DESKTOP_PACKAGE_IDENTITY,
      DESKTOP_PREVIEW_IDENTITY,
        ]) {
      expect(identity.appBundleId).not.toBe(retained.appBundleId);
      expect(identity.executableName).not.toBe(retained.executableName);
    }
    expect(parseDesktopPackageArguments(args, "darwin", "arm64")).toEqual({
      tsProduct: true,
      preview: true,
      identity,
    });
    for (const [platform, arch] of [
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["win32", "x64"],
    ])
      expect(() => parseDesktopPackageArguments(args, platform, arch)).toThrow("macOS arm64");
    for (const invalid of [[...args, "--python-product"], [...args, "--ts-product"]])
      expect(() => desktopPackageIdentity(invalid)).toThrow("only");
    expect(() =>
      desktopMacOSWorkerCompanionSource(
        resolve("fixture", DESKTOP_MACOS_WORKER_COMPANION_NAME),
        "darwin",
        identity,
      ),
    ).toThrow("production Worker");
  });

  it("keeps the full TS candidate's production identity and requires its Worker companion", () => {
    const args = ["--ts-product"];
    const identity = desktopPackageIdentity(args);
    expect(identity).toBe(DESKTOP_PACKAGE_IDENTITY);
    expect(parseDesktopPackageArguments(args, "darwin", "arm64")).toEqual({
      tsProduct: true,
      preview: false,
      identity,
    });
    const companion = resolve("fixture", DESKTOP_MACOS_WORKER_COMPANION_NAME);
    expect(desktopMacOSWorkerCompanionSource(companion, "darwin", identity)).toBe(companion);
    for (const [platform, arch] of [["darwin", "x64"], ["linux", "arm64"], ["win32", "x64"]])
      expect(() => parseDesktopPackageArguments(args, platform, arch)).toThrow("macOS arm64");
    if (process.platform === "darwin" && process.arch === "arm64") {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("./package.ts", import.meta.url)), ...args],
        { env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("requires the macOS Worker companion");
      expect(result.stdout).not.toContain("Packaging app");
    }
  });

  it.each<[string, boolean]>([
    ["package.json", false],
    [join("dist", "main.js"), false],
    [join("dist", "renderer", "index.html"), false],
    [join("node_modules", "write-file-atomic", "lib", "index.js"), false],
    [join("node_modules", "signal-exit", "dist", "cjs", "index.js"), false],
    [join("node_modules", "electron", "index.js"), true],
    [join("node_modules", "@electron", "fuses", "dist", "index.js"), true],
    [join("src", "main.ts"), true],
    [join("scripts", "package.ts"), true],
    [join("node_modules", ".vite", "results.json"), true],
    [join("out", "OpenBot.app"), true],
  ])("applies the package allowlist to %s", (candidate, ignored) => {
    expect(shouldIgnoreDesktopSource(appRoot, join(appRoot, candidate))).toBe(ignored);
  });

  it("accepts Packager's slash-relative callback paths", () => {
    expect(shouldIgnoreDesktopSource(appRoot, "/package.json")).toBe(false);
    expect(shouldIgnoreDesktopSource(appRoot, "/dist/main.js")).toBe(false);
    expect(shouldIgnoreDesktopSource(appRoot, "/node_modules/.vite/results.json")).toBe(true);
  });

  it("normalizes callback paths independently of the CI host separator", () => {
    expect(shouldIgnoreDesktopSource(appRoot, "\\package.json")).toBe(false);
    expect(shouldIgnoreDesktopSource(appRoot, "\\dist\\renderer\\index.html")).toBe(false);
    expect(shouldIgnoreDesktopSource(appRoot, "\\src\\main.ts")).toBe(true);
  });

  it("fails closed for paths outside the Desktop workspace", () => {
    expect(shouldIgnoreDesktopSource(appRoot, join(appRoot, "..", "web", "dist"))).toBe(true);
    expect(shouldIgnoreDesktopSource(appRoot, "/dist/../src/main.ts")).toBe(true);
    expect(shouldIgnoreDesktopSource(appRoot, "\\dist\\..\\src\\main.ts")).toBe(true);
    expect(
      shouldIgnoreDesktopSource(appRoot, "/node_modules/write-file-atomic/../electron/index.js"),
    ).toBe(true);
  });

  it("maps the three declared platforms without inventing another target", () => {
    expect(packagedElectronTarget("/tmp/OpenBot-darwin-arm64", "darwin")).toMatch(/OpenBot\.app$/u);
    expect(packagedElectronTarget("/tmp/OpenBot-win32-x64", "win32")).toMatch(/openbot\.exe$/u);
    expect(packagedElectronTarget("/tmp/OpenBot-linux-x64", "linux")).toMatch(/openbot$/u);
    expect(() => packagedElectronTarget("/tmp/OpenBot", "freebsd")).toThrow(/Unsupported/u);
    expect(packagedAsarPath("/tmp/OpenBot-darwin-arm64", "darwin")).toBe(
      join("/tmp/OpenBot-darwin-arm64", "OpenBot.app", "Contents", "Resources", "app.asar"),
    );
    expect(packagedAsarPath("/tmp/OpenBot-win32-x64", "win32")).toBe(
      join("/tmp/OpenBot-win32-x64", "resources", "app.asar"),
    );
    expect(packagedAsarPath("/tmp/OpenBot-linux-x64", "linux")).toBe(
      join("/tmp/OpenBot-linux-x64", "resources", "app.asar"),
    );
    expect(() => packagedAsarPath("/tmp/OpenBot", "freebsd")).toThrow(/Unsupported/u);
    expect(
      packagedDesktopResource("/tmp/OpenBot-darwin-arm64", "darwin", DESKTOP_ICON_RESOURCE_NAME),
    ).toBe(
      join(
        "/tmp/OpenBot-darwin-arm64",
        "OpenBot.app",
        "Contents",
        "Resources",
        DESKTOP_ICON_RESOURCE_NAME,
      ),
    );
    expect(
      packagedDesktopResource("/tmp/OpenBot-win32-x64", "win32", DESKTOP_ICON_RESOURCE_NAME),
    ).toBe(join("/tmp/OpenBot-win32-x64", "resources", DESKTOP_ICON_RESOURCE_NAME));
    expect(
      packagedDesktopResource("/tmp/OpenBot-linux-x64", "linux", DESKTOP_ICON_RESOURCE_NAME),
    ).toBe(join("/tmp/OpenBot-linux-x64", "resources", DESKTOP_ICON_RESOURCE_NAME));
    expect(() =>
      packagedDesktopResource("/tmp/OpenBot", "freebsd", DESKTOP_ICON_RESOURCE_NAME),
    ).toThrow(/Unsupported/u);
  });

  it("allows only one explicit macOS companion source and fixed packaged destination", () => {
    const source = resolve("workspace", DESKTOP_MACOS_WORKER_COMPANION_NAME);
    expect(desktopMacOSWorkerCompanionSource(undefined, "darwin")).toBeUndefined();
    expect(desktopMacOSWorkerCompanionSource(source, "darwin")).toBe(source);
    expect(() => desktopMacOSWorkerCompanionSource(source, "win32")).toThrow();
    expect(() => desktopMacOSWorkerCompanionSource("relative/Worker.app", "darwin")).toThrow();
    expect(() => desktopMacOSWorkerCompanionSource("/tmp/Other.app", "darwin")).toThrow();
    expect(packagedDesktopMacOSWorkerCompanion("/tmp/OpenBot-darwin-arm64", "darwin")).toBe(
      join(
        "/tmp/OpenBot-darwin-arm64",
        "OpenBot.app",
        "Contents",
        "Resources",
        DESKTOP_MACOS_WORKER_COMPANION_NAME,
      ),
    );
    expect(packagedDesktopMacOSWorkerCompanion("/tmp/OpenBot-win32-x64", "win32")).toBeUndefined();
  });

  it("pins and validates the exact packaged runtime dependency closure", () => {
    expect(DESKTOP_RUNTIME_DEPENDENCIES).toEqual({
      postgres: "3.4.9",
      "signal-exit": "4.1.0",
      "write-file-atomic": "8.0.0",
    });
    const entries = [
      "/dist/main.js",
      "/dist/preload.cjs",
      "/dist/renderer/index.html",
      "/node_modules/postgres/package.json",
      "/node_modules/postgres/src/index.js",
      "/node_modules/signal-exit/dist/cjs/index.js",
      "/node_modules/signal-exit/package.json",
      "/node_modules/write-file-atomic/lib/index.js",
      "/node_modules/write-file-atomic/package.json",
      "/package.json",
    ];
    expect(() => validateDesktopAsarEntries(entries)).not.toThrow();
    expect(() =>
      validateDesktopAsarEntries(entries.map((entry) => entry.replaceAll("/", "\\"))),
    ).not.toThrow();
    expect(() => validateDesktopAsarEntries(entries.map((entry) => entry.slice(1)))).not.toThrow();
    expect(() => validateDesktopAsarEntries(entries.slice(1))).toThrow(/missing/u);
    expect(() =>
      validateDesktopAsarEntries([...entries, "/node_modules/electron/index.js"]),
    ).toThrow(/unexpected dependency/u);
  });

  it("declares neutral Windows executable metadata without inventing a company", () => {
    expect(DESKTOP_WINDOWS_METADATA).toEqual({ CompanyName: "OpenBot contributors" });
    expect(Object.isFrozen(DESKTOP_WINDOWS_METADATA)).toBe(true);
  });

  it("requires every known fuse and does not request a missing custom V8 snapshot", () => {
    const fuses = createDesktopFuseConfig("darwin", "arm64");

    expect(fuses.version).toBe(FuseVersion.V1);
    expect(fuses.strictlyRequireAllFuses).toBe(true);
    expect(fuses.resetAdHocDarwinSignature).toBe(true);
    expect(fuses[FuseV1Options.RunAsNode]).toBe(false);
    expect(fuses[FuseV1Options.EnableCookieEncryption]).toBe(true);
    expect(fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false);
    expect(fuses[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false);
    expect(fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(true);
    expect(fuses[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true);
    expect(fuses[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]).toBe(false);
    expect(fuses[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(false);
    expect(fuses[FuseV1Options.WasmTrapHandlers]).toBe(false);
  });
});

// Electron V1 wire: sentinel, numeric version, byte count, then the declared fuse states.
// Exercise the installed reader against bytes rather than substituting its decoded result.
async function withFuseWire(states: readonly number[], check: (target: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "openbot-fuses-"));
  const target = join(root, "electron-fixture");
  const bytes = Buffer.concat([
    Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),
    Buffer.from([1, states.length, ...states]),
  ]);
  try {
    await writeFile(target, bytes);
    await check(target);
    expect(await readFile(target)).toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("packaged Electron fuse verification", () => {
  // Independent expected wire: Node/debug/extra file privileges disabled, ASAR confinement enabled.
  const wire = [48, 49, 48, 48, 49, 49, 48, 48, 48];

  it.each(["darwin", "win32", "linux"])(
    "reads the retained policy without writing on %s",
    async (platform) => {
      await withFuseWire(wire, (target) => verifyDesktopFuses(target, platform, "arm64"));
    },
  );

  it.each([
    FuseV1Options.RunAsNode,
    FuseV1Options.EnableCookieEncryption,
    FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    FuseV1Options.EnableNodeCliInspectArguments,
    FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    FuseV1Options.OnlyLoadAppFromAsar,
    FuseV1Options.LoadBrowserProcessSpecificV8Snapshot,
    FuseV1Options.GrantFileProtocolExtraPrivileges,
    FuseV1Options.WasmTrapHandlers,
  ])("rejects opposite, removed, inherited and missing fuse %s", async (index) => {
    for (const state of [wire[index] === 48 ? 49 : 48, FuseState.REMOVED, FuseState.INHERIT]) {
      const changed = [...wire];
      changed[index] = state;
      await withFuseWire(changed, async (target) => {
        await expect(verifyDesktopFuses(target, "win32", "x64")).rejects.toThrow(
          `Packaged Desktop fuse ${FuseV1Options[index]} did not match policy.`,
        );
      });
    }
    await withFuseWire(wire.slice(0, index), async (target) => {
      await expect(verifyDesktopFuses(target, "linux", "x64")).rejects.toThrow(
        `Packaged Desktop fuse ${FuseV1Options[index]} did not match policy.`,
      );
    });
  });
});

describe("packaging execution boundaries", () => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const entries = [
    "scripts/build-macos-worker-host-candidate.ts",
    "scripts/package-macos-worker-host-distribution.ts",
    "apps/desktop/scripts/package.ts",
  ];
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  // Each child Node process has its own bound, and each test's budget covers every child it
  // starts: in a full parallel `npm run test` one cold start can outlast Vitest's default 5 s.
  const childTimeout = 15_000;

  it("imports all packaging entries without starting a build, credential lookup or signing", {
    timeout: childTimeout + 5_000,
  }, () => {
    const program =
      entries
        .map(
          (entry) =>
            `await import(${JSON.stringify(pathToFileURL(join(repositoryRoot, entry)).href)});`,
        )
        .join("\n") + '\nprocess.stdout.write("imported");';
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: tmpdir(),
      env,
      encoding: "utf8",
      timeout: childTimeout,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("imported");
  });

  it("keeps direct CLI refusal active, including POSIX symlink invocation", {
    timeout: entries.length * 2 * childTimeout + 5_000,
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-package-cli-"));
    try {
      for (const [index, entry] of entries.entries()) {
        const direct = join(repositoryRoot, entry);
        const invocations = [direct];
        if (process.platform !== "win32") {
          // Windows non-elevated symlink creation is not an installation prerequisite.
          const link = join(directory, `${index}.ts`);
          await symlink(direct, link);
          invocations.push(link);
        }
        for (const script of invocations) {
          const result = spawnSync(process.execPath, [script, "--unexpected", "value"], {
            cwd: directory,
            env,
            encoding: "utf8",
            timeout: childTimeout,
          });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(1);
          expect(result.stderr).toMatch(/Unknown macOS|only.*macOS|Desktop packaging accepts only/);
          expect(result.stdout).toBe("");
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("defaults to the sole TS payload on macOS arm64 and remote clients elsewhere", () => {
    expect(parseDesktopPackageArguments([], "darwin", "arm64")).toEqual({
      tsProduct: true, preview: false, identity: DESKTOP_PACKAGE_IDENTITY,
    });
    expect(parseDesktopPackageArguments([], "win32", "x64")).toEqual({
      tsProduct: false, preview: false, identity: DESKTOP_PACKAGE_IDENTITY,
    });
    expect(parseDesktopPackageArguments(["--preview"], "linux", "x64").identity).toBe(DESKTOP_PREVIEW_IDENTITY);
    for (const args of [["--python-product"], ["--preview", "--python-product"]])
      expect(() => parseDesktopPackageArguments(args)).toThrow("only");
  });
});
