import { afterEach, describe, expect, it, vi } from "vitest";
import { type ArtifactShellSaver, getArtifactShellSaver } from "./artifact-shell-save";
import { getOpenBotDesktopBridge } from "./desktop-runtime";

vi.mock("./desktop-runtime", () => ({ getOpenBotDesktopBridge: vi.fn() }));
afterEach(() => vi.mocked(getOpenBotDesktopBridge).mockReset());

type Bridge = NonNullable<ReturnType<typeof getOpenBotDesktopBridge>>;

function bridgeWith(saveReport: Bridge["saveReport"]): Bridge {
  return { saveReport } as unknown as Bridge;
}
function requireSaver(): ArtifactShellSaver {
  const saver = getArtifactShellSaver();
  if (!saver) throw new Error("Expected a shell saver.");
  return saver;
}
describe("artifact shell save adapter", () => {
  it("returns no saver without a Desktop shell so the browser keeps the native download", () => {
    vi.mocked(getOpenBotDesktopBridge).mockReturnValue(undefined);
    expect(getArtifactShellSaver()).toBeUndefined();
  });
  it("forwards only the artifact ID and returns the saved status", async () => {
    const saveReport = vi.fn(async () => ({ status: "saved" as const }));
    vi.mocked(getOpenBotDesktopBridge).mockReturnValue(bridgeWith(saveReport));
    await expect(requireSaver().save("report-id")).resolves.toBe("saved");
    expect(saveReport).toHaveBeenCalledExactlyOnceWith("report-id");
  });
  it("passes through every bridge status without reinterpreting it", async () => {
    for (const status of ["cancelled", "exists", "busy", "unavailable"] as const) {
      vi.mocked(getOpenBotDesktopBridge).mockReturnValue(
        bridgeWith(vi.fn(async () => ({ status }))),
      );
      await expect(requireSaver().save("report-id")).resolves.toBe(status);
    }
  });
  it("reports unavailable when the bridge omits saveReport", async () => {
    vi.mocked(getOpenBotDesktopBridge).mockReturnValue(bridgeWith(undefined));
    await expect(requireSaver().save("report-id")).resolves.toBe("unavailable");
  });
  it("propagates bridge failures so the card can show the retry notice", async () => {
    const failure = new Error("bridge unavailable");
    vi.mocked(getOpenBotDesktopBridge).mockReturnValue(
      bridgeWith(
        vi.fn(async () => {
          throw failure;
        }),
      ),
    );
    await expect(requireSaver().save("report-id")).rejects.toBe(failure);
  });
});
