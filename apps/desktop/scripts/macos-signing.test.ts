import { beforeEach, describe, expect, it, vi } from "vitest";
import { macosSigningOptions, verifyNotarizedDesktop } from "./macos-signing.ts";

describe("explicit signed distribution prerequisites", () => {
  const env = {
    OPENBOT_DESKTOP_MACOS_SIGNING_IDENTITY: "Developer ID Application: Fixture (ABCDEFGHIJ)",
    OPENBOT_DESKTOP_MACOS_NOTARY_PROFILE: "openbot-notary",
  };
  it("keeps development packaging independent of distribution credentials", () => {
    expect(macosSigningOptions({}, "darwin")).toBeUndefined();
    expect(macosSigningOptions({}, "win32")).toBeUndefined();
  });
  it("fails closed for incomplete, wrong-platform, preview or ad hoc signing", () => {
    for (const invalid of [
      { OPENBOT_DESKTOP_MACOS_SIGNING_IDENTITY: env.OPENBOT_DESKTOP_MACOS_SIGNING_IDENTITY },
      { ...env, OPENBOT_DESKTOP_MACOS_SIGNING_IDENTITY: "-" },
    ])
      expect(() => macosSigningOptions(invalid, "darwin")).toThrow();
    expect(() => macosSigningOptions(env, "win32")).toThrow();
    expect(() => macosSigningOptions(env, "darwin", true)).toThrow();
  });
  it("uses the existing Packager signing and notary profile adapters with strict failure", () => {
    const options = macosSigningOptions(env, "darwin");
    if (!options) throw new Error("Missing signing options");
    expect(options.osxSign.continueOnError).toBe(false);
    expect(options.osxSign.optionsForFile().hardenedRuntime).toBe(true);
    expect(options.osxNotarize).toEqual({ keychainProfile: "openbot-notary" });
  });
});

// Exercise command order and refusal without accessing a real signing identity or Keychain.
const { run } = vi.hoisted(() => ({
  run: vi.fn<
    (
      command: string,
      args: readonly string[],
      options: { timeout: number },
    ) => Promise<{ stderr: string }>
  >(),
}));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: run }) };
});
beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({
    stderr: "Authority=Developer ID Application: Fixture\nTeamIdentifier=ABCDEFGHIJ\n",
  });
});

describe("native signature verification", () => {
  const app = "/fixture with spaces/OpenBot.app";
  it("runs each independent native gate in order with the same bounded deadline", async () => {
    await verifyNotarizedDesktop(app);
    expect(run.mock.calls).toEqual([
      ["/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { timeout: 60_000 }],
      ["/usr/bin/codesign", ["--display", "--verbose=4", app], { timeout: 60_000 }],
      ["/usr/bin/xcrun", ["stapler", "validate", app], { timeout: 60_000 }],
      ["/usr/sbin/spctl", ["--assess", "--type", "execute", app], { timeout: 60_000 }],
    ]);
  });
  it.each([
    "",
    "Authority=Developer ID Application: Fixture",
    "TeamIdentifier=ABCDEFGHIJ",
    "Authority=adhoc\nTeamIdentifier=ABCDEFGHIJ",
    "Authority=Developer ID Application: Fixture\nTeamIdentifier=SHORT",
  ])("refuses invalid identity before notary or Gatekeeper checks: %j", async (stderr) => {
    run.mockResolvedValue({ stderr });
    await expect(verifyNotarizedDesktop(app)).rejects.toThrow(/Developer ID signature/u);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it.each([0, 1, 2, 3])("preserves gate %i failure and runs no later command", async (index) => {
    const failure = new Error("native gate failed");
    for (let earlier = 0; earlier < index; earlier++)
      run.mockResolvedValueOnce({
        stderr: "Authority=Developer ID Application: Fixture\nTeamIdentifier=ABCDEFGHIJ",
      });
    run.mockRejectedValueOnce(failure);
    await expect(verifyNotarizedDesktop(app)).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(index + 1);
  });
});
