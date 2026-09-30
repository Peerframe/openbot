import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const macOSLaunchAgentURL = new URL(
  "../apps/worker-host-macos/Resources/com.openbot.worker-host.node.plist",
  import.meta.url,
);

export const expectedMacOSLaunchAgentPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openbot.worker-host.node</string>
  <key>BundleProgram</key>
  <string>Contents/MacOS/OpenBotWorkerHostControl</string>
  <key>ProgramArguments</key>
  <array>
    <string>OpenBotWorkerHostControl</string>
    <string>--worker-host</string>
  </array>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ExitTimeOut</key>
  <integer>25</integer>
  <key>Umask</key>
  <string>077</string>
</dict>
</plist>
`;

const maximumPlistBytes = 4 * 1024;

export async function validateMacOSLaunchAgent(
  plistURL: URL | string = macOSLaunchAgentURL,
): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(plistURL);
  } catch {
    throw new Error("The macOS LaunchAgent contract is unavailable.");
  }

  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumPlistBytes) {
    throw new Error("The macOS LaunchAgent contract is invalid.");
  }

  const actual = await readFile(plistURL, "utf8");
  if (actual !== expectedMacOSLaunchAgentPlist) {
    throw new Error("The macOS LaunchAgent contract is invalid.");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await validateMacOSLaunchAgent();
  console.info("macOS LaunchAgent contract checks passed.");
}
