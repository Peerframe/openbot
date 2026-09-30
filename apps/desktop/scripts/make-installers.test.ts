import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { installerSourceCommit } from "./make-installers.ts";

const script = fileURLToPath(new URL("./make-installers.ts", import.meta.url));

test("source identity admits only the exact commit or an explicitly absent local identity", () => {
  expect(installerSourceCommit({})).toBeNull();
  const sha = "abcdef0123456789".repeat(2) + "abcdef01";
  expect(installerSourceCommit({ GITHUB_SHA: sha })).toBe(sha);
  for (const value of ["", "main", sha.toUpperCase(), `${sha}\n`, `${sha}0`, sha.slice(1)]) {
    expect(() => installerSourceCommit({ GITHUB_SHA: value })).toThrow(
      "GitHub source commit must be a full commit id.",
    );
  }
});

test("import does not start installer preparation or alter signing discovery", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(new URL("./make-installers.ts", import.meta.url).href)}); console.log(process.env.CSC_IDENTITY_AUTO_DISCOVERY);`,
    ],
    {
      env: {
        ...process.env,
        GITHUB_SHA: "invalid",
        CSC_IDENTITY_AUTO_DISCOVERY: "sentinel",
        OPENBOT_DESKTOP_MACOS_SIGNING_IDENTITY: "invalid",
      },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  expect(output.trim()).toBe("sentinel");
});

test("the actual TypeScript CLI refuses arguments before signing or artifact access", () => {
  const result = spawnSync(process.execPath, [script, "--publish"], {
    env: {
      ...process.env,
      GITHUB_SHA: "invalid",
      OPENBOT_DESKTOP_MACOS_SIGNING_IDENTITY: "invalid",
    },
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Installer creation takes no positional arguments.");
  expect(result.stdout).toBe("");
});
