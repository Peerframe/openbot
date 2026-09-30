import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Options } from "@electron/packager";

const nativeTimeoutMs = 60_000;

export function macosSigningOptions(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
  preview = false,
) {
  const identity = env.OPENBOT_DESKTOP_MACOS_SIGNING_IDENTITY;
  const profile = env.OPENBOT_DESKTOP_MACOS_NOTARY_PROFILE;
  if (!identity && !profile) return undefined;
  if (
    platform !== "darwin" ||
    preview ||
    !identity?.startsWith("Developer ID Application: ") ||
    !profile ||
    /[\r\n\0]/u.test(identity + profile)
  )
    throw new Error(
      "Signed Desktop packaging requires macOS, the canonical app, a Developer ID Application identity and a notarytool Keychain profile.",
    );
  return {
    osxSign: {
      identity,
      continueOnError: false,
      optionsForFile: () => ({
        hardenedRuntime: true,
        entitlements: fileURLToPath(
          new URL("../resources/desktop-entitlements.plist", import.meta.url),
        ),
      }),
    },
    osxNotarize: { keychainProfile: profile },
  } satisfies Pick<Options, "osxSign" | "osxNotarize">;
}

/** Read-only native checks in fixed order; each command has its own bounded lifetime. */
export async function verifyNotarizedDesktop(appPath: string): Promise<void> {
  const run = promisify(execFile);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], {
    timeout: nativeTimeoutMs,
  });
  const { stderr } = await run("/usr/bin/codesign", ["--display", "--verbose=4", appPath], {
    timeout: nativeTimeoutMs,
  });
  if (
    !/^Authority=Developer ID Application:/mu.test(stderr) ||
    !/^TeamIdentifier=[A-Z0-9]{10}$/mu.test(stderr)
  )
    throw new Error("The application does not have a Developer ID signature.");
  await run("/usr/bin/xcrun", ["stapler", "validate", appPath], { timeout: nativeTimeoutMs });
  await run("/usr/sbin/spctl", ["--assess", "--type", "execute", appPath], {
    timeout: nativeTimeoutMs,
  });
}
