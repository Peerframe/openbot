import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { discardBody, readBoundedBytes } from "./bounded-response.js";
import type { DesktopConnectionState, DesktopServerFetcher } from "./connection-controller.js";
import { isDesktopSessionAuthenticated } from "./desktop-server-actions.js";

export type ReportSaveResult = Readonly<{
  status: "saved" | "cancelled" | "busy" | "unavailable" | "exists";
}>;
export type EmployeeTemplateSaveInput = Readonly<{
  botId: string;
  packageId: string;
  generatedAt: string;
  downloadReviewToken: string;
  includeSkillContent?: boolean;
}>;
export type EmployeeTemplateSaveResult = ReportSaveResult | Readonly<{ status: "changed" }>;

interface Options {
  connection(): DesktopConnectionState;
  fetch: DesktopServerFetcher;
  active(): boolean;
  choosePath(name: string): Promise<string | undefined>;
  chooseAttachmentPath?(name: string): Promise<string | undefined>;
}

/** The renderer chooses an artifact identity; only the native dialog can choose a local path. */
export class DesktopReportSaver {
  #busy = false;
  constructor(readonly options: Options) {}
  async save(value: unknown): Promise<ReportSaveResult> {
    if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value))
      return { status: "unavailable" };
    return this.#save(value) as Promise<ReportSaveResult>;
  }
  async saveAttachment(input: unknown): Promise<ReportSaveResult> {
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
    if (!input || typeof input !== "object" || Array.isArray(input))
      return { status: "unavailable" };
    const value = input as Record<string, unknown>;
    if (
      Object.keys(value).sort().join() !== "attachmentId,channelId" ||
      typeof value.channelId !== "string" ||
      typeof value.attachmentId !== "string" ||
      !uuid.test(value.channelId) ||
      !uuid.test(value.attachmentId)
    )
      return { status: "unavailable" };
    if (this.#busy) return { status: "busy" };
    const connection = this.options.connection();
    if (connection.status !== "configured" || !this.options.active())
      return { status: "unavailable" };
    this.#busy = true;
    try {
      const url = new URL(
        `/api/v1/channels/${value.channelId}/attachments/${value.attachmentId}`,
        connection.serverUrl,
      );
      const request = {
        credentials: "include" as const,
        redirect: "manual" as const,
        signal: AbortSignal.timeout(30000),
      };
      const metadata = await this.options.fetch(url.href, request);
      if (
        metadata.status !== 200 ||
        !metadata.headers.get("content-type")?.startsWith("application/json")
      ) {
        discardBody(metadata.body);
        throw new Error("Invalid attachment metadata");
      }
      const { attachment } = JSON.parse(
        (await readBoundedAttachment(metadata, 16384)).toString("utf8"),
      ) as {
        attachment: {
          id: string;
          channelId: string;
          name: string;
          sha256: string;
          sizeBytes: number;
        };
      };
      if (
        !attachment ||
        attachment.id !== value.attachmentId ||
        attachment.channelId !== value.channelId ||
        !/^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,159}$/u.test(attachment.name) ||
        !/^[a-f0-9]{64}$/u.test(attachment.sha256) ||
        !Number.isSafeInteger(attachment.sizeBytes) ||
        attachment.sizeBytes < 1 ||
        attachment.sizeBytes > 10 * 1024 * 1024
      )
        throw new Error("Invalid attachment descriptor");
      const response = await this.options.fetch(`${url.href}/content`, request);
      if (
        response.status !== 200 ||
        response.headers.get("content-type") !== "application/octet-stream"
      ) {
        discardBody(response.body);
        throw new Error("Invalid attachment content");
      }
      const bytes = await readBoundedAttachment(response, attachment.sizeBytes);
      if (
        bytes.length !== attachment.sizeBytes ||
        createHash("sha256").update(bytes).digest("hex") !== attachment.sha256
      )
        throw new Error("Attachment integrity check failed");
      if (!this.#sameConnection(connection)) return { status: "unavailable" };
      const path = await (this.options.chooseAttachmentPath ?? this.options.choosePath)(
        attachment.name,
      );
      if (path === undefined) return { status: "cancelled" };
      if (
        !isAbsolute(path) ||
        extname(path) !== extname(attachment.name) ||
        !this.#sameConnection(connection) ||
        !(await isDesktopSessionAuthenticated(connection, this.options.fetch)) ||
        !this.#sameConnection(connection)
      )
        return { status: "unavailable" };
      await writeNewPrivateFile(path, bytes);
      return { status: "saved" };
    } catch (error) {
      return {
        status:
          error instanceof Error && "code" in error && error.code === "EEXIST"
            ? "exists"
            : "unavailable",
      };
    } finally {
      this.#busy = false;
    }
  }
  async saveEmployeeTemplate(value: unknown): Promise<EmployeeTemplateSaveResult> {
    if (!isEmployeeTemplateSaveInput(value)) return { status: "unavailable" };
    return this.#save(value);
  }
  async #save(value: string | EmployeeTemplateSaveInput): Promise<EmployeeTemplateSaveResult> {
    if (this.#busy) return { status: "busy" };
    const connection = this.options.connection();
    if (connection.status !== "configured" || !this.options.active())
      return { status: "unavailable" };
    this.#busy = true;
    try {
      const employee = typeof value !== "string" ? value : undefined;
      const url = new URL(
        employee ? `/api/v1/bots/${employee.botId}/export` : `/api/v1/artifacts/${value}/content`,
        connection.serverUrl,
      );
      if (employee) {
        url.searchParams.set("packageId", employee.packageId);
        url.searchParams.set("generatedAt", employee.generatedAt);
        if (employee.includeSkillContent) url.searchParams.set("includeSkillContent", "true");
      }
      const response = await this.options.fetch(url.href, {
        method: "GET",
        credentials: "include",
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: employee
          ? {
              Accept:
                "application/vnd.openbot.employee+json, application/vnd.openbot.employee.dsse+json",
              "If-Match": `"${employee.downloadReviewToken}"`,
            }
          : { Accept: "text/markdown, image/png" },
      });
      if (employee && response.status === 412) {
        discardBody(response.body);
        return { status: "changed" };
      }
      const bytes = employee
        ? await readEmployeeTemplate(response, employee.downloadReviewToken)
        : await readArtifact(response);
      const image = response.headers.get("content-type") === "image/png";
      const disposition = response.headers.get("content-disposition") ?? "";
      if (disposition.length > 1024) return { status: "unavailable" };
      const encodedName = /^attachment; filename="report\.md"; filename\*=UTF-8''([^;]+)$/u.exec(
        disposition,
      )?.[1];
      const employeeName =
        /^attachment; filename="([a-z0-9][a-z0-9-]{0,63}\.openbot-employee(?:\.dsse)?\.json)"$/u.exec(
          disposition,
        )?.[1];
      const name = employee
        ? (employeeName ?? "")
        : image
          ? `screenshot-${value}.png`
          : encodedName
            ? decodeURIComponent(encodedName)
            : "";
      if (
        employee
          ? !employeeName
          : image
            ? disposition !== "inline"
            : !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,100}\.md$/u.test(name)
      )
        return { status: "unavailable" };
      if (!this.#sameConnection(connection)) return { status: "unavailable" };
      const path = await this.options.choosePath(name);
      if (path === undefined) return { status: "cancelled" };
      if (!isAbsolute(path) || extname(path) !== extname(name) || !this.#sameConnection(connection))
        return { status: "unavailable" };
      if (
        !(await isDesktopSessionAuthenticated(connection, this.options.fetch)) ||
        !this.#sameConnection(connection)
      )
        return { status: "unavailable" };
      await writeNewPrivateFile(path, bytes);
      return { status: "saved" };
    } catch (error) {
      return {
        status:
          error instanceof Error && "code" in error && error.code === "EEXIST"
            ? "exists"
            : "unavailable",
      };
    } finally {
      this.#busy = false;
    }
  }
  #sameConnection(connection: Extract<DesktopConnectionState, { status: "configured" }>): boolean {
    const current = this.options.connection();
    return (
      this.options.active() &&
      current.status === "configured" &&
      current.serverUrl === connection.serverUrl
    );
  }
}

// Both save routes reach this only after their own content, dialog and current-session checks.
async function writeNewPrivateFile(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

async function readArtifact(response: Response): Promise<Buffer> {
  if (!response.body) throw new Error("Missing report body.");
  try {
    const mediaType = response.headers.get("content-type");
    const image = mediaType === "image/png";
    if (response.status !== 200 || (!image && mediaType !== "text/markdown"))
      throw new Error("Invalid report response.");
    const maxBytes = image ? 5 * 1024 * 1024 : 32 * 1024;
    const bytes = await readBoundedBytes(response.body, maxBytes, "Artifact too large.");
    if (image) {
      // Saving bytes grants no renderer path authority and never decodes untrusted image content.
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new Error("Invalid PNG signature.");
      return bytes;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.trim() || text.includes("\0")) throw new Error("Invalid report text.");
    return bytes;
  } finally {
    discardBody(response.body);
  }
}

export function isEmployeeTemplateSaveInput(value: unknown): value is EmployeeTemplateSaveInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
  return (
    (keys.length === 4 || keys.length === 5) &&
    (input.includeSkillContent === undefined || typeof input.includeSkillContent === "boolean") &&
    keys.every((key) =>
      ["botId", "packageId", "generatedAt", "downloadReviewToken", "includeSkillContent"].includes(
        key,
      ),
    ) &&
    typeof input.botId === "string" &&
    uuid.test(input.botId) &&
    typeof input.packageId === "string" &&
    uuid.test(input.packageId) &&
    typeof input.generatedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.generatedAt) &&
    Number.isFinite(Date.parse(input.generatedAt)) &&
    new Date(input.generatedAt).toISOString() === input.generatedAt &&
    typeof input.downloadReviewToken === "string" &&
    /^[a-f0-9]{64}$/u.test(input.downloadReviewToken)
  );
}

async function readEmployeeTemplate(response: Response, reviewToken: string): Promise<Buffer> {
  if (!response.body) throw new Error("Missing Employee template body.");
  try {
    if (
      response.status !== 200 ||
      ![
        "application/vnd.openbot.employee+json; charset=utf-8",
        "application/vnd.openbot.employee.dsse+json; charset=utf-8",
      ].includes(response.headers.get("content-type") ?? "") ||
      response.headers.get("etag") !== `"${reviewToken}"`
    )
      throw new Error("Invalid Employee template response.");
    const bytes = await readBoundedBytes(
      response.body,
      2 * 1024 * 1024,
      "Employee template too large.",
    );
    if (createHash("sha256").update(bytes).digest("hex") !== reviewToken)
      throw new Error("Employee template did not match its reviewed bytes.");
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return bytes;
  } finally {
    discardBody(response.body);
  }
}

async function readBoundedAttachment(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error("Missing attachment body");
  return readBoundedBytes(response.body, limit, "Attachment response exceeds bound");
}
