import { auditCsv, readAudit } from "./audit-read.js";
import { readRunProgress } from "./run-progress.js";
import { ProductBytes } from "./product-response.js";
import type { ProductRoute } from "./product-identity.js";

export const productReadRoutes: readonly ProductRoute[] = [
  {
    method: "GET",
    path: "/api/v1/audit",
    kind: "product",
    error: "identity_lifecycle_unavailable",
    execute: (db, _ids, _body, request) => readAudit(db, request.query),
  },
  {
    method: "GET",
    path: "/api/v1/audit/export",
    kind: "product",
    error: "identity_lifecycle_unavailable",
    execute: async (db, _ids, _body, request) => {
      const page = await readAudit(db, request.query, true);
      return new ProductBytes(auditCsv(page.events), {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="openbot-audit.csv"',
        ...(page.nextBefore ? { "X-OpenBot-Next-Before": page.nextBefore } : {}),
      });
    },
  },
  {
    method: "GET",
    path: "/api/v1/runs/{run_id}/progress",
    kind: "product",
    isolation: "repeatable read",
    execute: (db, ids, _body, request) => readRunProgress(db, ids[0]!, request.query),
  },
];
