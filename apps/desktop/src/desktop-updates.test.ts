import { describe, expect, it, vi } from "vitest";
import { DesktopUpdateController, type DesktopUpdaterPort } from "./desktop-updates.js";
import { createSignedUpdaterPort, parseSignedUpdateConfiguration } from "./signed-update-port.js";

function fixture() {
  let listener: Parameters<DesktopUpdaterPort["subscribe"]>[0] = () => {};
  const order: string[] = [];
  const port: DesktopUpdaterPort = {
    check: vi.fn(async () => ({ available: true, version: "1.2.3" })),
    download: vi.fn(async () => {
      listener({ status: "downloaded", percent: 150 });
      listener({ status: "downloaded", version: "1.2.3" });
    }),
    install: vi.fn(() => {
      order.push("install");
    }),
    subscribe: (value) => {
      listener = value;
      return vi.fn();
    },
  };
  const confirm = vi.fn(async () => {
    order.push("confirm");
    return true;
  });
  const shutdown = vi.fn(async () => {
    order.push("shutdown");
  });
  return {
    port,
    order,
    confirm,
    shutdown,
    controller: new DesktopUpdateController(port, undefined, confirm, shutdown),
  };
}
describe("signed Desktop updates", () => {
  it("requires an immutable feed and explicit signer configuration", async () => {
    const config = {
      openbotFormat: "openbot.signed-updates/v1",
      provider: "github",
      owner: "Peerframe",
      repo: "openbot",
      channel: "alpha",
      macTeamIdentifier: "ABCDEFGHIJ",
    };
    expect(parseSignedUpdateConfiguration(JSON.stringify(config), "darwin").owner).toBe(
      "Peerframe",
    );
    for (const value of [
      { ...config, url: "https://attacker.example" },
      { ...config, repo: "other" },
      { ...config, macTeamIdentifier: "" },
      { ...config, token: "secret" },
    ])
      expect(() => parseSignedUpdateConfiguration(JSON.stringify(value), "darwin")).toThrow();
    expect(() =>
      parseSignedUpdateConfiguration(
        JSON.stringify({ ...config, publisherName: ["Publisher"] }),
        "win32",
      ),
    ).toThrow();
    expect(
      await createSignedUpdaterPort({
        packaged: false,
        platform: "darwin",
        resources: "/missing",
        executable: "/missing",
      }),
    ).toEqual({ code: "not_packaged" });
    expect(
      await createSignedUpdaterPort({
        packaged: true,
        platform: "linux",
        resources: "/missing",
        executable: "/missing",
      }),
    ).toEqual({ code: "unsupported_platform" });
    expect(
      await createSignedUpdaterPort({
        packaged: true,
        platform: "win32",
        resources: "/missing",
        executable: "/missing",
      }),
    ).toEqual({ code: "configuration_unavailable" });
  });
  it("installs only a completed verified download after native consent and shutdown", async () => {
    const f = fixture();
    await f.controller.install();
    expect(f.port.install).not.toHaveBeenCalled();
    expect((await f.controller.check()).status).toBe("available");
    expect((await f.controller.download()).status).toBe("downloaded");
    f.confirm.mockResolvedValueOnce(false);
    expect((await f.controller.install()).status).toBe("downloaded");
    expect(f.shutdown).not.toHaveBeenCalled();
    f.order.length = 0;
    expect((await f.controller.install()).status).toBe("installing");
    expect(f.order).toEqual(["confirm", "shutdown", "install"]);
    f.controller.close();
  });
  it("fails closed on failed shutdown or a download without verification completion", async () => {
    const f = fixture();
    await f.controller.check();
    await f.controller.download();
    f.shutdown.mockRejectedValueOnce(new Error("private path"));
    expect(await f.controller.install()).toEqual({ status: "failed", code: "shutdown_failed" });
    expect(f.port.install).not.toHaveBeenCalled();
    const g = fixture();
    vi.mocked(g.port.download).mockResolvedValueOnce();
    await g.controller.check();
    expect(await g.controller.download()).toEqual({ status: "failed", code: "update_failed" });
    vi.mocked(g.port.check).mockResolvedValueOnce({ available: true, version: "<script>" });
    expect(await g.controller.check()).toEqual({ status: "failed", code: "update_failed" });
  });
  it("serializes concurrent checks and never auto-installs", async () => {
    const f = fixture();
    let finish: ((v: { available: boolean; version: string }) => void) | undefined;
    vi.mocked(f.port.check).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = f.controller.check();
    expect((await f.controller.check()).status).toBe("checking");
    expect(f.port.check).toHaveBeenCalledTimes(1);
    finish?.({ available: false, version: "1.0.0" });
    await first;
    f.controller.automatic(true);
    await vi.waitFor(() => expect(f.controller.state().status).toBe("downloaded"));
    expect(f.port.install).not.toHaveBeenCalled();
    f.controller.close();
  });
});
