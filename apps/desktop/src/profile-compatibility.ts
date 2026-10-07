import { existsSync } from "node:fs";
import { join } from "node:path";

/** Keep the established encryption namespace when replacing the early macOS Preview. */
export function desktopProfileCompatibility(
  appData: string,
  platform: string,
  productName: string,
  exists: (path: string) => boolean = existsSync,
  explicitUserData?: string,
): Readonly<{ userData: string; encryptionName: string }> | undefined {
  // A chosen Electron profile owns its bootstrap; never redirect it to another installation.
  if (explicitUserData !== undefined || platform !== "darwin" || productName !== "OpenBot")
    return undefined;
  const canonical = join(appData, "OpenBot");
  const legacy = join(appData, "OpenBot Preview");
  // A partial or damaged canonical installation still owns its data; never silently switch users.
  const retainedFiles = [
    "setup-plan.json",
    "server.json",
    "local-server/bootstrap.json",
    "local-server/postgres/PG_VERSION",
  ];
  if (retainedFiles.some((file) => exists(join(canonical, "openbot", file)))) return undefined;
  if (!exists(join(legacy, "openbot", "setup-plan.json"))) return undefined;
  return { userData: legacy, encryptionName: "OpenBot Preview" };
}
