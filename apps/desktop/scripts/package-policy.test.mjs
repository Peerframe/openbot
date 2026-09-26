import { join, resolve } from "node:path";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { describe, expect, it } from "vitest";
import {
  createDesktopFuseConfig,
  DESKTOP_ICON_RESOURCE_NAME,
  DESKTOP_MACOS_WORKER_COMPANION_NAME,
  DESKTOP_PACKAGE_IDENTITY,
  DESKTOP_PREVIEW_IDENTITY,
  DESKTOP_PYTHON_PREVIEW_IDENTITY,
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
} from "./package-policy.mjs";

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

  it("isolates Python qualification from canonical apps retaining the legacy Preview profile", () => {
    const identity = desktopPackageIdentity(["--preview", "--python-product"]);
    expect(identity).toBe(DESKTOP_PYTHON_PREVIEW_IDENTITY);
    expect(desktopPackageIdentity(["--python-product", "--preview"])).toBe(identity);
    const manifest = { name: "@openbot/desktop", productName: "OpenBot" };
    const staged = desktopPackagedManifest(manifest, identity);
    expect(staged.productName).toBe("OpenBot Python Preview");
    for (const retained of [DESKTOP_PACKAGE_IDENTITY, DESKTOP_PREVIEW_IDENTITY]) {
      expect(staged.productName).not.toBe(retained.name);
      expect(identity.appBundleId).not.toBe(retained.appBundleId);
      expect(identity.executableName).not.toBe(retained.executableName);
    }
    expect(manifest.productName).toBe("OpenBot");
    expect(packagedAsarPath("/fixture", "darwin", identity)).toBe(
      join("/fixture", `${identity.name}.app`, "Contents", "Resources", "app.asar"),
    );
    expect(() =>
      desktopMacOSWorkerCompanionSource(
        resolve("workspace", DESKTOP_MACOS_WORKER_COMPANION_NAME),
        "darwin",
        identity,
      ),
    ).toThrow(/production Worker/u);
    for (const args of [
      ["--python-product"],
      ["--preview", "--python-product", "--python-product"],
    ]) {
      expect(() => desktopPackageIdentity(args)).toThrow(/only/u);
    }
  });

  it.each([
    ["package.json", false],
    [join("dist", "main.js"), false],
    [join("dist", "renderer", "index.html"), false],
    [join("node_modules", "write-file-atomic", "lib", "index.js"), false],
    [join("node_modules", "signal-exit", "dist", "cjs", "index.js"), false],
    [join("node_modules", "electron", "index.js"), true],
    [join("node_modules", "@electron", "fuses", "dist", "index.js"), true],
    [join("src", "main.ts"), true],
    [join("scripts", "package.mjs"), true],
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
