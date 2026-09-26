# Research: channel and schedule admission into durable work

- Status: implementation candidate, local qualification pending
- Date: 2026-09-24
- Acceptance journey: a retained channel submission or due schedule creates one durable Task;
  its existing Run surface reflects that Task, including cancellation and Owner corrections.
- Security boundary: only the authenticated control transaction admits work; Temporal remains
  the sole continuation owner. Existing historical runs are not reclassified or dispatched.

## Search evidence and decision

Reviewed the reuse ledger's product Worker, handoff, publication and corrections entries and
their pinned sources. Searches: `temporalio/sdk-python workflow id reject duplicate`,
`Temporal external database transaction workflow start`, and `PostgreSQL 17 consistent lock order`.
The official [SDK release/source](https://github.com/temporalio/sdk-python/releases/tag/1.33.0),
[workflow identity documentation](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/workflow/workflow-execution/workflowid-runid.mdx)
and [PostgreSQL lock documentation](https://www.postgresql.org/docs/17/explicit-locking.html)
confirm the existing design: SQL commit and engine acceptance are separate facts, and row locks
must follow one order. Reuse Temporal Python 1.33.0 and PostgreSQL 17.11 already pinned and
qualified in `work-temporal-journey.md` and `work-product-worker.md`; their release, source,
tests, issue and license review remains applicable. No new dependency or upstream code copy.

| Option | Fit | Decision |
| --- | --- | --- |
| Existing PostgreSQL admission plus Temporal 1.33.0 (MIT) | Already covers pending handoff, unknown starts, stable workflow identity and corrections | Selected thin adapter |
| Invoke Temporal directly inside the message transaction | No shared commit; rollback or lost response can orphan or duplicate work | Rejected |
| Retain a second native business execution/retry loop | Two writers would disagree about cancellation and continuation | Rejected |

The local gap is the product's channel/schedule identity mapping. Add immutable `work_sources`
only for newly admitted candidate work, share the existing WorkStore transaction operations,
and derive the retained Run DTO from Work facts. The old Run row is a source record, never a
second execution state writer. Publication creates the Bot message in the same transaction as
the verified Work result. All mapped Task operations acquire channel, source Run, then Task
locks; membership removal follows that order. No credentials, grants or new retry policy are
encoded in the mapping. Existing profile/model selection must be captured at admission.

## Verification and exit

Real PostgreSQL tests cover atomic message/schedule admission and rollback, historical records,
projection, cancellation/unknown effects, correction identity, one final message, and concurrent
membership revocation versus publication. The existing Temporal fault/replay cases remain the
recovery-owner evidence; a local integrated journey must additionally exercise the new ingress.
The candidate remains explicitly selected. User data/default cutover is not authorized, and
Linux/runsc execution acceptance remains deferred until its real host is available.

## Concurrent command projection correction — 2026-09-25

The integrated PostgreSQL 17.11 gate exposed duplicate cancellation events and steering after
a concurrent terminal transition. Rechecked the pinned implementation against PostgreSQL 17's
[Read Committed rules](https://www.postgresql.org/docs/17/transaction-iso.html): a locking join can
return an updated target tuple alongside the other relation's older statement snapshot. The
joined `runs_work_projection` is therefore not command authority after waiting on `runs`.
Acquire the source row lock first, then read the projection in a new statement. Apply the same
fresh read to locked descendant candidates. Existing real concurrent command tests cover this
regression; no new dependency, copied source or isolation-level change is needed.
