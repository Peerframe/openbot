/** Imports and exports bounded Employee packages under existing identity and resource locks. */
import { LOCK_NAMESPACE } from "./database-locks.js";
import { scalarText } from "./owner-auth-crypto.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type postgres from "postgres";
import {
  activateEmployeeImportRequestSchema,
  employeeExportDownloadInputSchema,
  employeeImportActivationResponseSchema,
  employeeImportReceiptSchema,
  portableEnvelopeHttpSchema,
  unsignedPortablePackageHttpSchema,
  type EmployeeTemplatePackage,
} from "@openbot/protocol";
import {
  inspectEmployeeTemplate,
  prepareEmployeeTemplateExport,
  type EmployeeTemplateExportPublisher,
} from "@openbot/employee-publisher/employee-package";
import { skillContentProblem } from "@openbot/employee-publisher/employee-package-content";
import { employeeProfile, employeeRows, employeeTime } from "./employee-records.js";
import { botProjection } from "./channel-read-projection.js";
import { primarySettings, publishPrimary } from "./identity-lifecycle.js";
import { refuse } from "./owner-transaction.js";
import { ProductBytes, ProductJson } from "./product-response.js";
import type { ProductRoute } from "./product-identity.js";

const activationInput = activateEmployeeImportRequestSchema.extend({
  employeeName: z
    .string()
    .trim()
    .refine((s) => [...s].length >= 1 && [...s].length <= 64)
    .optional(),
});
const parsed = <T>(schema: z.ZodType<T>, value: unknown, error: string): T => {
  const result = schema.safeParse(value);
  return result.success ? result.data : refuse(422, error);
};
function packageDocument(
  input: unknown,
  publisher?: EmployeeTemplateExportPublisher,
): { document: EmployeeTemplatePackage; trusted?: string } {
  if (Buffer.byteLength(JSON.stringify(input)) > 2 * 1024 * 1024)
    return refuse(413, "employee_package_too_large");
  const pending: unknown[] = [input];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string" && !scalarText(value))
      return refuse(422, "invalid_employee_package");
    if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) {
        if (!scalarText(key)) return refuse(422, "invalid_employee_package");
        pending.push(child);
      }
  }
  const unsigned = unsignedPortablePackageHttpSchema.safeParse(input);
  if (unsigned.success) return { document: unsigned.data };
  const envelope = portableEnvelopeHttpSchema.safeParse(input);
  if (!envelope.success) return refuse(422, "invalid_employee_package");
  if (!publisher) return refuse(422, "employee_publisher_trust_required");
  const result = publisher.verify(envelope.data);
  if (result.status !== "verified") return refuse(422, "employee_package_signature_" + result.code);
  return { document: result.document, trusted: result.trustedKeyId };
}
const receipt = (row: Record<string, any>) =>
  employeeImportReceiptSchema.parse({
    id: row.id,
    packageId: row.package_id,
    packageDigest: row.package_digest,
    employeeId: row.employee_id,
    signatureStatus: row.signature_status,
    ...(row.publisher_key_id ? { publisherKeyId: row.publisher_key_id } : {}),
    reviewedBy: "owner",
    reviewedAt: employeeTime(row.reviewed_at),
    importedSkillCount: row.imported_skill_count,
    createdAt: employeeTime(row.created_at),
  });
async function activate(
  db: postgres.TransactionSql,
  document: EmployeeTemplatePackage,
  digest: string,
  trusted: string | undefined,
  value: z.infer<typeof activationInput>,
) {
  const payload = document.payload;
  for (const skill of payload.skills)
    if (skillContentProblem(skill)) return refuse(422, "employee_import_invalid_skill_content");
  const name = value.employeeName ?? payload.employee.name;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        packageId: payload.packageId,
        packageDigest: digest,
        employeeName: name,
        signatureStatus: trusted ? "dsse" : "unsigned",
        publisherKeyId: trusted ?? null,
      }),
    )
    .digest("hex");
  for (const key of [
    "employee-import:idempotency:" + value.idempotencyKey,
    "employee-import:package:" + payload.packageId,
  ].sort())
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${key},${LOCK_NAMESPACE.portability}))`;
  const [prior] = await employeeRows(
    db,
    "SELECT to_jsonb(r) AS receipt,to_jsonb(b) AS employee FROM employee_import_receipts r JOIN bots b ON b.id=r.employee_id WHERE r.idempotency_key=$1 LIMIT 1",
    [value.idempotencyKey],
  );
  if (prior) {
    if (prior.receipt.request_fingerprint !== fingerprint)
      return refuse(409, "employee_import_idempotency_conflict");
    return {
      employee: botProjection({
        ...prior.employee,
        created_at: new Date(prior.employee.created_at),
      }),
      receipt: receipt(prior.receipt),
      replayed: true,
    };
  }
  if (
    (
      await db`SELECT id FROM employee_import_receipts WHERE package_id=${payload.packageId} LIMIT 1`
    ).length
  )
    return refuse(409, "employee_package_already_activated");
  const workspace = await primarySettings(db);
  const [time] = await db`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  const stamp = time!.now,
    botId = randomUUID();
  const [bot] =
    await db`INSERT INTO bots(id,name,role,description,profile_revision,status,computer_profile,configuration,created_at,updated_at) VALUES(${botId},${name},${payload.employee.role},${payload.employee.description ?? ""},1,'idle',${payload.configuration.recommendedExecutionProfile},${db.json(payload.employee.appearance ? { appearance: payload.employee.appearance } : {})},${stamp},${stamp}) RETURNING *`;
  if (workspace.primary_bot_id === null) await publishPrimary(db, workspace, botId, "imported");
  const bySlug = new Map<string, Record<string, any>>(),
    inserted = new Set<string>();
  for (const portable of [...payload.skills].sort((a, b) =>
    a.slug < b.slug
      ? -1
      : a.slug > b.slug
        ? 1
        : a.version < b.version
          ? -1
          : a.version > b.version
            ? 1
            : 0,
  )) {
    const content = portable.content;
    let [skill] =
      await db`INSERT INTO skills(id,slug,name,description,version,source,required_capabilities,metadata,skill_markdown,content_sha256,created_at,updated_at) VALUES(${randomUUID()},${portable.slug},${portable.name},${portable.description},${portable.version},'imported',${db.json(portable.requiredCapabilities)},'{"format":"agentskills.io"}'::jsonb,${content?.markdown ?? null},${content?.sha256 ?? null},${stamp},${stamp}) ON CONFLICT(slug,version) DO NOTHING RETURNING *`;
    if (skill) inserted.add(skill.id);
    else
      [skill] = await employeeRows(
        db,
        "SELECT * FROM skills WHERE slug=$1 AND version=$2 FOR SHARE",
        [portable.slug, portable.version],
      );
    if (!skill) return refuse(409, "employee_import_skill_definition_changed");
    const required = (skill.required_capabilities as unknown[]).filter(
      (v) => typeof v === "string",
    );
    if (
      skill.skill_markdown !== (content?.markdown ?? null) ||
      skill.content_sha256 !== (content?.sha256 ?? null) ||
      skill.name !== portable.name ||
      skill.description !== portable.description ||
      JSON.stringify([...new Set(required)].sort()) !==
        JSON.stringify([...new Set(portable.requiredCapabilities)].sort())
    )
      return refuse(409, "employee_import_skill_definition_conflict");
    bySlug.set(portable.slug, skill);
  }
  for (const portable of payload.skills) {
    const skill = bySlug.get(portable.slug)!,
      dependencies = portable.dependencySlugs.map((slug) => bySlug.get(slug)!.id as string);
    if (inserted.has(skill.id)) {
      for (const id of dependencies)
        await db`INSERT INTO skill_dependencies(skill_id,depends_on_skill_id) VALUES(${skill.id},${id})`;
    } else {
      const actual =
        await db`SELECT depends_on_skill_id FROM skill_dependencies WHERE skill_id=${skill.id} LIMIT 65`;
      if (
        JSON.stringify([...new Set(actual.map((row) => row.depends_on_skill_id))].sort()) !==
        JSON.stringify([...new Set(dependencies)].sort())
      )
        return refuse(409, "employee_import_skill_dependencies_conflict");
    }
    await db`INSERT INTO employee_skills(bot_id,skill_id,state,source,confidence,evidence,acquired_at,updated_at) VALUES(${botId},${skill.id},'candidate','imported',0,${db.json([{ kind: "import", id: payload.packageId, label: "Reviewed Employee package" }])},${stamp},${stamp})`;
  }
  await db`INSERT INTO employee_evolution_events(id,bot_id,type,title,summary,source,source_id,evidence,created_at) VALUES(${randomUUID()},${botId},'imported','Employee imported',${name + " was activated from an Owner-reviewed portable package."},'import',${payload.packageId},${db.json([{ kind: "import", id: payload.packageId, label: digest }])},${stamp})`;
  await db`INSERT INTO run_events(id,bot_id,type,payload,created_at) VALUES(${randomUUID()},${botId},'BOT_IMPORTED',${db.json({ packageId: payload.packageId, packageDigest: digest, importedSkillCount: payload.skills.length })},${stamp})`;
  const [saved] =
    await db`INSERT INTO employee_import_receipts(id,package_id,package_digest,employee_id,idempotency_key,request_fingerprint,signature_status,publisher_key_id,reviewed_by,reviewed_at,imported_skill_count,created_at) VALUES(${randomUUID()},${payload.packageId},${digest},${botId},${value.idempotencyKey},${fingerprint},${trusted ? "dsse" : "unsigned"},${trusted ?? null},'owner',${stamp},${payload.skills.length},${stamp}) RETURNING *`;
  return { employee: botProjection(bot!), receipt: receipt(saved!), replayed: false };
}
export function portabilityRoutes(publisher?: EmployeeTemplateExportPublisher): ProductRoute[] {
  const noSQL = async () => {
    throw new Error("Portability operation requires fresh authority.");
  };
  return [
    ...["/api/v1/bots/{bot_id}/export/preview", "/api/v1/bots/{bot_id}/export"].map(
      (path): ProductRoute => ({
        method: "GET",
        path,
        kind: "product",
        execute: noSQL,
        error: "employee_portability_storage_unavailable",
        remote: async (owner, ids, _body, _signal, request) => {
          const query = request.query,
            selection = query.getAll("includeSkillContent"),
            download = path.endsWith("/export");
          if (
            download &&
            ([...query.keys()].some(
              (key) => !["packageId", "generatedAt", "includeSkillContent"].includes(key),
            ) ||
              ["packageId", "generatedAt"].some((key) => query.getAll(key).length !== 1))
          )
            return refuse(422, "invalid_employee_export_instance");
          if (selection.length && (selection.length !== 1 || selection[0] !== "true"))
            return refuse(422, "invalid_employee_export_selection");
          const tag = request.headers["if-match"];
          if (download && tag === undefined) return refuse(428, "employee_export_review_required");
          if (download && (typeof tag !== "string" || !/^"[a-f0-9]{64}"$/.test(tag)))
            return refuse(422, "invalid_employee_export_review_tag");
          const instance = download
            ? parsed(
                employeeExportDownloadInputSchema,
                { packageId: query.get("packageId"), generatedAt: query.get("generatedAt") },
                "Invalid request input.",
              )
            : {};
          const profile = await owner((db) => employeeProfile(db, ids[0]!));
          const prepared = await owner(async () =>
            prepareEmployeeTemplateExport(profile, {
              ...instance,
              includeSkillContent: selection.length === 1,
              ...(publisher ? { publisher } : {}),
            }),
          );
          if (!download) return { preview: prepared.preview };
          if (prepared.preview.blocked) return refuse(422, "employee_export_blocked");
          if (prepared.preview.downloadReviewToken !== (tag as string).slice(1, -1))
            return refuse(412, "employee_export_changed");
          return new ProductBytes(Buffer.from(prepared.body), {
            "Content-Type": publisher
              ? "application/vnd.openbot.employee.dsse+json; charset=utf-8"
              : "application/vnd.openbot.employee+json; charset=utf-8",
            ETag: tag as string,
            "Content-Disposition": `attachment; filename="${prepared.preview.fileName}"`,
          });
        },
      }),
    ),
    ...["preview", "activate"].map(
      (action): ProductRoute => ({
        method: "POST",
        path: "/api/v1/employees/import/" + action,
        kind: "typed",
        error: "employee_portability_storage_unavailable",
        maxBytes: 2 * 1024 * 1024 + (action === "activate" ? 65536 : 0),
        execute: noSQL,
        remote: async (owner, _ids, body, signal, request) => {
          const input =
            action === "activate"
              ? parsed(activationInput, body, "Invalid request input.")
              : undefined;
          const { document, trusted } = packageDocument(input ? input.package : body, publisher);
          if (!request.runtime) return refuse(503, "portability_node_inventory_unavailable");
          const runtime = await request.runtime.snapshot(signal);
          return owner(async (db) => {
            const preview = inspectEmployeeTemplate(
              document,
              runtime.nodes,
              trusted ? { trustedKeyId: trusted } : {},
            );
            if (!input) return { preview };
            if (
              preview.packageId !== input.expectedPackageId ||
              preview.integrity.digest !== input.expectedDigest
            )
              return refuse(409, "employee_import_preview_changed");
            if (preview.blocked || !preview.quarantine.canActivate)
              return refuse(422, "employee_import_blocked");
            if (!trusted && !input.allowUnsigned)
              return refuse(422, "employee_import_unsigned_acceptance_required");
            try {
              const result = employeeImportActivationResponseSchema.parse(
                await activate(db, document, preview.integrity.digest, trusted, input),
              );
              return new ProductJson(result, result.replayed ? 200 : 201);
            } catch (error) {
              if ((error as { code?: string }).code === "23505")
                return refuse(409, "employee_import_conflict");
              throw error;
            }
          });
        },
      }),
    ),
  ];
}
