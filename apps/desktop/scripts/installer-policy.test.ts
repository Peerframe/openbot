import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashInstaller,
  installerConfig,
  installerFileNames,
  installerTarget,
  validateInstallerVersion,
} from "./installer-policy.ts";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("Desktop installer boundary", () => {
  it("uses baseline resources until export, then the generated Linux icon set", () => {
    const input = { appRoot: "/app", outputDirectory: "/out", version: "0.1.0-alpha.2",
      platform: "linux", arch: "x64", electronVersion: "44.3.0" };
    const baseline = installerConfig(input);
    expect(baseline.directories.buildResources).toBe(join("/app", "resources"));
    expect(baseline.linux.icon).toBe("openbot-icon.png");
    const generated = installerConfig({ ...input, generatedIcons: true });
    expect(generated.directories.buildResources).toBe(join("/app", "out", "icons"));
    expect(generated.linux.icon).toBe("icons");
  });
  it("rejects unreviewed targets and filenames that could escape a release directory", () => {
    for (const version of ["0.0.0", "../1.0.0", "1.0.0;echo", "latest", "1.0.0\n", "1.0.0+local"]) {
      expect(() => validateInstallerVersion(version)).toThrow();
    }
    for (const [platform, arch] of [
      ["darwin", "x64"],
      ["win32", "arm64"],
      ["linux", "arm64"],
    ]) {
      expect(() => installerTarget(platform, arch)).toThrow();
    }
    expect(installerFileNames("0.1.0-alpha.2", "linux", "x64")).toEqual([
      "openbot-desktop-0.1.0-alpha.2-linux-x64.AppImage",
      "openbot-desktop-0.1.0-alpha.2-linux-x64.deb",
    ]);
  });
  it("keeps publication, automatic execution, elevation and data deletion out of the installer", () => {
    const config = installerConfig({
      appRoot: "/app",
      outputDirectory: "/out",
      version: "0.1.0-alpha.2",
      platform: "win32",
      arch: "x64",
      electronVersion: "44.3.0",
    });
    expect(config.publish).toBeNull();
    expect(config.nsis).toMatchObject({
      oneClick: true,
      perMachine: false,
      packElevateHelper: false,
      runAfterFinish: false,
      deleteAppDataOnUninstall: false,
    });
    expect(config.win.signAndEditExecutable).toBe(false);
    expect(config.mac.identity).toBeNull();
  });
  it("hashes regular installer content and rejects a substituted symbolic link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-installer-policy-"));
    directories.push(directory);
    const path = join(directory, "installer");
    await writeFile(path, "abc");
    expect(await hashInstaller(path)).toEqual({
      bytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
    await expect(hashInstaller(directory)).rejects.toThrow("regular file");
    if (process.platform !== "win32") {
      await symlink(path, join(directory, "alias"));
      await expect(hashInstaller(join(directory, "alias"))).rejects.toThrow("regular file");
    }
  });
});

it("uses the caller's exact Electron pin and refuses ranges or missing pins", () => {
  const input = {
    appRoot: "/app",
    outputDirectory: "/out",
    version: "0.1.0-alpha.2",
    platform: "win32",
    arch: "x64",
    electronVersion: "44.3.0",
  };
  expect(installerConfig(input).electronVersion).toBe("44.3.0");
  for (const value of [undefined, null, "44.3", "v44.3.0", "^44.3.0", "latest", "44.3.0\n"]) {
    expect(() =>
      Reflect.apply(installerConfig, undefined, [{ ...input, electronVersion: value }]),
    ).toThrow("exact pinned Electron version");
  }
});
