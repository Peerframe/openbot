# Research: Owner additional approval policy (C4)

- Date: 2026-10-01
- Decision: [ADR-0049](../decisions/0049-owner-approval-policy.md), written before implementation.

Reuse the prior Server-authoritative approval catalog decision, trusted Work proposals, original
adapter minimum approvals and bounded product read/public web authority. Exact original main pin,
Cedar4.13.0/OPA1.21.1 source releases, licenses, tests, issues, official precedence rules, local
transaction choice, failure behavior and replacement trigger are recorded in ADR-0049. No candidate
source copied/adapted or new dependency. Public settings cannot grant a new operation or override a
mandatory adapter approval. Delete/install/permission changes always reject exceptions.

Negative tests were written first: the pre-implementation run failed collection because the new
module did not exist. They cover protected categories, unknown targets/wildcards/private URLs,
category mismatch/duplicate/Bot bounds and preservation of adapter mandatory confirmation.
Independent C2/C7/C4 append migration0046 from the same latest main: after one merges, rebase and
reindex subsequent migrations, preserving committed SQL history and rerun migration checks.

## Completed candidate verification

- `npm run check`: passed; final full check repeats after deployment/security follow-up.
- Real disposable PostgreSQL/HTTP control:895 passed,2 existing skips. Concurrent revisions,
  audit rollback, exact Bot/target, tightened admission/dispatch and SQL adapter minimum tested.
- Verified Worker interpreter matches all64 locked distributions. Actual Worker run:1566 passed,
 1 failed,1 existing skip; the only failure was the negative command test expecting the raw SQL
  exception through a wrapper. Corrected it to use a raw connection; the entire103-test command
  module then passed against fresh disposable PostgreSQL. Both new actual product-read and
  approved web/Deferred execution cases passed in that Worker run. No unchanged Worker rerun.
- Fresh/previous migration and repeat/constraints probe passed. All40 paired S7 PostgreSQL/blob
  lineage/backup/restore cases passed with exact pristine seeded-target validation.
- Compiled actual Zod/Python URL-contract agreement passed20 canonical/refusal cases.
- Final PR-head hosted native container/full-history CI remains required; no main merge/release.

Final review also requires intact policy storage for already approved supported reads. After that
change, all107 actual PostgreSQL settings/read/web tests passed with the reviewed Worker runtime
(one existing dependency warning). The103-test command module evidence above remains valid.
A concurrent multi-worktree npm check encountered existing short-timeout tests; final full checks
run sequentially with unchanged test timeouts. Genuine failed logs are retained separately.
