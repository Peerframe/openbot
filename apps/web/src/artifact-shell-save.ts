import { getOpenBotDesktopBridge } from "./desktop-runtime";

export type ArtifactSaveStatus = "saved" | "cancelled" | "busy" | "unavailable" | "exists";

export interface ArtifactShellSaver {
  save(artifactId: string): Promise<ArtifactSaveStatus>;
}

/**
 * Shell-owned report save. The returned saver hides the Desktop bridge from the component.
 * `undefined` means no shell owns the save, so the caller keeps the browser's native download
 * path. A bridge without `saveReport` is reported as `unavailable` rather than falling through
 * to the browser, preserving the existing "update Desktop" outcome. The artifact ID is the only
 * value crossing the boundary; the shell resolves the file name and location.
 */
export function getArtifactShellSaver(): ArtifactShellSaver | undefined {
  const desktop = getOpenBotDesktopBridge();
  if (!desktop) return undefined;
  return {
    async save(artifactId) {
      const result = await desktop.saveReport?.(artifactId);
      return result?.status ?? "unavailable";
    },
  };
}
