import { getOpenBotDesktopBridge } from "./desktop-runtime";
import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchEmployeeTemplate,
  isEmployeeProfileChangedEvent,
  updateEmployeeProfileDetails,
  updateEmployeeSkillState,
} from "./api";
import { downloadEmployeeTemplate } from "./employee-template-delivery";

vi.mock("./desktop-runtime", () => ({ getOpenBotDesktopBridge: vi.fn() }));

afterEach(() => {
  vi.mocked(getOpenBotDesktopBridge).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("employee profile realtime invalidation", () => {
  it("accepts a content-free event with unique allowlisted sections", () => {
    expect(
      isEmployeeProfileChangedEvent({
        type: "employee.profile.changed",
        botId: "00000000-0000-4000-8000-000000000001",
        sections: ["skills", "evolution"],
        occurredAt: "2026-09-04T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it.each([
    { sections: [] },
    { sections: ["memory", "memory"] },
    { sections: ["authority"] },
    { sections: ["memory"], occurredAt: "not-a-timestamp" },
    { sections: ["memory"], content: "must not ride the event stream" },
  ])("rejects malformed or content-bearing events: %o", (override) => {
    expect(
      isEmployeeProfileChangedEvent({
        type: "employee.profile.changed",
        botId: "00000000-0000-4000-8000-000000000001",
        occurredAt: "2026-09-04T00:00:00.000Z",
        ...override,
      }),
    ).toBe(false);
  });
});

describe("employee skill review API", () => {
  it("sends the explicit Owner-reviewed transition without widening the request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ skill: { id: "skill-1" }, evolution: { id: "event-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await updateEmployeeSkillState("employee-1", "skill-1", {
      state: "verified",
      confidence: 87,
      reason: "The Owner reviewed the stored evidence.",
      evidence: [],
      ownerReviewed: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/bots/employee-1/skills/skill-1/state");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(init?.body))).toEqual({
      state: "verified",
      confidence: 87,
      reason: "The Owner reviewed the stored evidence.",
      evidence: [],
      ownerReviewed: true,
    });
  });
});

describe("Employee profile details API", () => {
  it("sends only descriptive fields and the Server revision", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          employee: { id: "employee-1" },
          details: { revision: 4 },
          evolution: { id: "event-1" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await updateEmployeeProfileDetails("employee-1", {
      role: "Evidence reviewer",
      description: "Review evidence and document limitations.",
      expectedRevision: 3,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/bots/employee-1/profile");
    expect(init).toMatchObject({ method: "PATCH", credentials: "include" });
    expect(JSON.parse(String(init?.body))).toEqual({
      role: "Evidence reviewer",
      description: "Review evidence and document limitations.",
      expectedRevision: 3,
    });
  });
});

describe("Employee export review binding", () => {
  it("returns verified bytes without invoking a shell save operation", async () => {
    const body = '{"portable":true}\n';
    const reviewToken = createHash("sha256").update(body).digest("hex");
    vi.stubGlobal("crypto", webcrypto);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 200, headers: { ETag: `"${reviewToken}"` } }),
    );

    const blob = await fetchEmployeeTemplate("employee-1", {
      ...exportPreview(),
      downloadReviewToken: reviewToken,
    });

    expect(await blob.text()).toBe(body);
  });

  it("returns the reviewed package identity and strong tag on download", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "The export changed." }), {
        status: 412,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(downloadEmployeeTemplate("employee/1", exportPreview())).rejects.toMatchObject({
      status: 412,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "/api/v1/bots/employee%2F1/export?packageId=00000000-0000-4000-8000-000000000099&generatedAt=2026-09-04T00%3A00%3A00.000Z",
    );
    expect(init).toMatchObject({
      credentials: "include",
      headers: { "If-Match": `"${"b".repeat(64)}"` },
    });
  });

  it("rejects response bytes that do not match the reviewed digest before download", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("changed bytes", {
        status: 200,
        headers: { ETag: `"${"b".repeat(64)}"` },
      }),
    );

    await expect(downloadEmployeeTemplate("employee-1", exportPreview())).rejects.toThrow(
      "未通过完整性检查",
    );
  });

  it.each([
    ["missing", undefined],
    ["changed", `"${"c".repeat(64)}"`],
  ])("rejects a %s response tag before creating a download", async (_label, responseTag) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("changed bytes", {
        status: 200,
        headers: responseTag === undefined ? undefined : { ETag: responseTag },
      }),
    );

    await expect(downloadEmployeeTemplate("employee-1", exportPreview())).rejects.toThrow(
      "未匹配已审核的员工模板",
    );
  });

  it("fails closed when the browser cannot hash the received bytes", async () => {
    const body = '{"portable":true}\n';
    const reviewToken = createHash("sha256").update(body).digest("hex");
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { ETag: `"${reviewToken}"` },
      }),
    );

    await expect(
      downloadEmployeeTemplate("employee-1", {
        ...exportPreview(),
        downloadReviewToken: reviewToken,
      }),
    ).rejects.toThrow("无法安全校验员工模板");
  });

  it("creates a browser download only after the response tag and received bytes match", async () => {
    const body = '{"portable":true}\n';
    const reviewToken = createHash("sha256").update(body).digest("hex");
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("document", {
      body: { append },
      createElement: vi.fn(() => ({ click, remove })),
    });
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:reviewed");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { ETag: `"${reviewToken}"` },
      }),
    );

    await downloadEmployeeTemplate("employee-1", {
      ...exportPreview(),
      downloadReviewToken: reviewToken,
    });

    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:reviewed");
  });
});

function exportPreview() {
  return {
    format: "openbot.employee/v1" as const,
    kind: "template" as const,
    packageId: "00000000-0000-4000-8000-000000000099",
    fileName: "employee.openbot-employee.json",
    generatedAt: "2026-09-04T00:00:00.000Z",
    employee: { name: "Employee", role: "Research" },
    skills: [],
    employeeName: "Employee",
    verifiedSkillCount: 0,
    requestedCapabilities: [],
    includedMemoryCount: 0 as const,
    exclusions: [],
    findings: [],
    blocked: false,
    checksum: "a".repeat(64),
    downloadReviewToken: "b".repeat(64),
    signatureStatus: "unsigned" as const,
    identityOnImport: "new" as const,
    hostAuthority: "none" as const,
  };
}

describe("native Agent progress", () => {
  it("accepts a Server-owned progress event without inventing a Node and rejects cross-channel data", async () => {
    const { isRunProgressProjection } = await import("./api");
    const progress = {
      id: "event",
      runId: "run",
      channelId: "channel",
      stage: "planning",
      message: "Model step 1.",
      createdAt: "2026-09-07T00:00:00Z",
    };
    expect(isRunProgressProjection(progress, "channel")).toBe(true);
    expect(isRunProgressProjection(progress, "other")).toBe(false);
    expect(isRunProgressProjection({ ...progress, nodeId: 42 }, "channel")).toBe(false);
  });
});

describe("native Employee package download", () => {
  it.each(["saved", "cancelled", "changed", "exists", "busy", "unavailable", "missing"])(
    "preserves native result semantics without browser download: %s",
    async (status) => {
      const saveEmployeeTemplate = vi.fn(async () => ({ status }));
      vi.mocked(getOpenBotDesktopBridge).mockReturnValue({
        saveEmployeeTemplate: status === "missing" ? undefined : saveEmployeeTemplate,
      } as unknown as NonNullable<ReturnType<typeof getOpenBotDesktopBridge>>);
      const fetcher = vi.spyOn(globalThis, "fetch");
      const result = downloadEmployeeTemplate("employee-1", exportPreview());
      if (status === "saved" || status === "cancelled") await expect(result).resolves.toBe(status);
      else await expect(result).rejects.toMatchObject({ status: status === "changed" ? 412 : 0 });
      if (status !== "missing")
        expect(saveEmployeeTemplate).toHaveBeenCalledExactlyOnceWith({
          botId: "employee-1",
          packageId: exportPreview().packageId,
          generatedAt: exportPreview().generatedAt,
          downloadReviewToken: exportPreview().downloadReviewToken,
        });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
