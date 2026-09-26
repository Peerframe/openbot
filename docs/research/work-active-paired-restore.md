# Research checkpoint: cold restoration of active Work

2026-09-25. Research recorded before implementation; the bounded scripted-port design was then
approved and qualified. No product module, dependency or public protocol changes. The prior
completed product restore remains a separate scope; existing shared fixtures were not used.

## Reuse and native tools

Read the reuse ledger and existing `temporal-postgres-operations.md`,
`s7-migration-qualification.md`, `work-deferred-approval.md`, `work-temporal-journey.md`, and
the completed product/connection paired-restore probes. Source examined: `maintain.py`,
the pinned Compose/initialization SQL, `PostgresServer.backup/restore`, `probe.py`'s older-engine
restore, `product_approval_probe.py`/worker, EffectService, and the product HTTP/process helpers.

Preserve these reviewed releases rather than adding a framework:

| Component | Pin and provenance | Reuse |
| --- | --- | --- |
| Temporal Server/admin | 1.32.0, commit `d94e34a1ebba5410a2e7d07119a76896909591aa`, MIT | Existing digest-pinned mTLS Compose profile, schemas history 1.19/visibility 1.14, maintenance preflight and runtime role sealing |
| PostgreSQL | 17.11 / `REL_17_11`, PostgreSQL License; existing image digest `051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0` | Native custom dump and single-transaction restore into empty destinations |
| Temporal Python | Existing Worker lock 1.33.0 / `ab52fdde33ee8ed193402625bfdba25d240a762d`, MIT | Actual product Workflow/Activity execution and official offline Replayer |
| Existing Work fixture | Repository MIT; no external source copied | Owner HTTP, product Worker with bounded scripted ports, SQLite-backed external effect/receipt service, canonical Node migrator |
| Paired files/keys | Already integrated product restore probe | Full Control table/sequence/file hashes; actual settings/plugin/connection readers and key rejection checks |

Fresh primary checks:
- [PostgreSQL SQL dump](https://www.postgresql.org/docs/17/backup-dump.html): a dump is one
  database snapshot; independent databases are not automatically synchronized and roles are separate.
- [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html): custom archives and
  transactional restore into our own empty databases, never an arbitrary imported archive.
- [Temporal deployment](https://docs.temporal.io/self-hosted-guide/deployment) and
  [Server v1.32.0 tree](https://github.com/temporalio/temporal/tree/v1.32.0): reuse the reviewed
  released server and SQL stores. This is a trusted single-host reference, not an HA/auth service.
- Fresh GitHub tree fetches for SDK `1.33.0` and PostgreSQL `REL_17_11/src/bin/pg_dump` returned
  cache misses; the accepted source/test/license reviews above supply those exact pins. No new
  dependency decision relies on the failed fetches or an unreviewed release.

Read-only local image inspection confirmed all three exact PostgreSQL/Temporal Server/admin
digests are already present. No image pull, new process, container or database was needed for
this checkpoint. The new runner must not import the old DBOS experiment merely for its small
Docker helper: retain the canonical Node migrator and use native Docker/psycopg lifecycle calls.

## Exact gaps in current helpers

`PostgresServer.backup()` stops the engine but restarts it before returning. `restore()` creates
a new empty engine volume and reseals privileges, then starts the engine immediately. This is
correct for its existing engine-only journey, but a combined Control/files/engine hold needs
opt-in `restart_engine=False` and `start_engine=False` behavior with existing defaults retained.
The active probe can then verify all stores before starting any target API/Worker. Add these
small experiment-only options in the packet, not another backup coordinator or product scheduler.

The older recovery probe deliberately restores old engine history while keeping newer product
unknown facts. It does not prove a matching full-product active snapshot. The completed paired
probe verifies encrypted files and Control rows but has no unfinished Workflow. The new bounded
probe joins these existing operations at one deliberate all-writers-stopped checkpoint.

Full rollback to an arbitrary old snapshot can resurrect grants revoked after that snapshot.
This probe therefore never resumes the source after the checkpoint, never overwrites a live
destination, and does not claim online atomicity or protection against stale full backups.
Execution hold is the test's explicit stopped API/Worker/engine lifecycle, not a new product
recovery admission feature. External side effects/receipts are not rolled back with the product.


## Executed qualification and limits

The new runner composes existing native operations around actual Owner HTTP and the product
Worker. It uses `OPENBOT_CONTROL_AUTHORITY=work` and accepted scripted model/effect ports,
not full ProductWorkRuntime or paid/provider networking. One snapshot contains pending approval,
unknown with one already committed external CSV write, and cancellation. All application and
engine writers stop before three custom archives and paired files/configuration/PKI are taken.
The source stays stopped; native transactional restores target independent empty containers/volumes.
The external effect receipt service remains independent and is never restored or rewound.

Before target execution, complete table/sequence hashes and file/mode hashes match; actual
Owner/session, media/blob, settings, disabled-plugin/audit and enabled saved-connection readers
verify decrypted data. Missing/wrong keys fail closed, including non-regeneration of a missing
connection key. The incomplete-file negative is a manifest check while the probe holds all
execution stopped; it does not add a product recovery admission API. Original visibility,
namespace/Workflow/engine Run/Work Run/Action identities and history prefixes remain. Fresh Owner
approval is required for pending work; unknown uses original-action lookup only and retains
reservation until verification. Cancellation never resumes. Original pending/terminal histories
replay without changing product rows or external counters; decoded Payloads are checked for
fixture media and the listed Owner/session, Control DB, model and saved-connection secrets. Runtime role/schema denials remain intact.

See [bounded public evidence](../../experiments/work-journey/evidence/active-paired-restore.json)
and [English](../../experiments/work-journey/README.md#active-task-paired-cold-restore) /
[Chinese](../../experiments/work-journey/README.zh-CN.md#活动-task-成套冷恢复) reproduction instructions.
The source and target resources are owned/random and removed after the run; private local
archives/keys/config/history are excluded from the integration patch. No upstream third-party
source was copied; existing repository MIT fixtures were reused/adapted. Exact Worker/server
source hashes are included in evidence to bound Replay to the tested implementation.

No online snapshot, arbitrary old-snapshot rollback, source/target concurrency, cross-version
upgrade, HA/PITR, deployment-generic roles/ACLs, Desktop keychain, live provider/model semantics
or Linux sandbox guarantee follows from this case. Restoring a stale full backup alone cannot
preserve authority revocations made after that backup. The hold flags default to existing helper
behavior, so ordinary engine-only probes retain automatic restart/start. Replacement remains
the standard PostgreSQL backup/restore and Temporal deployment operations; no overlapping
backup framework, scheduler or retry owner is introduced.

## Canonical43 repeat

The unchanged actual HTTP/PG/mTLS fixture passed after0042 in64.18s:46 Control tables,
110 rows,40 history+3 visibility tables,13 paired files and36 TLS files. All six key negatives,
original pending/unknown/cancelled continuation, row/file/TLS hashes and offline replay passed;
106 decoded Payloads excluded the checked credentials/media. Owned containers, volumes and
processes were removed with no cleanup error. Command preparation tables are empty in this
scenario, so this does not qualify recovery of in-flight native commands. The current public
evidence replaces the earlier42-entry repeat; the older result remains historical below.

## Canonical42 repeat (historical)

The unchanged actual HTTP/PG/mTLS fixture completed in52.62s after0041:45 Control tables,
109 rows,40 history+3 visibility tables,13 paired files,36 TLS files and the same six key
negatives. Original pending/unknown/cancelled behavior and106 decoded-Payload privacy checks
passed; no Replay effects or remaining owned resources. The two inactive command tables were
empty; their structure is included, but in-flight command restoration is not claimed.
# Current schema refresh — 2026-09-26

The unchanged bounded probe passed on canonical44 after browser profile integration. Native dumps
and fresh restores preserved47 Control tables/111 rows,40 history and3 visibility tables,13 paired
files and36 TLS files. All six missing/wrong-key negatives and the incomplete-pair hold passed.
Pending approval continued on its original Workflow; unknown effects used lookup only; cancellation
was not revived. Both histories replayed without side effects. Source and target execution never
overlapped. Owned containers/processes were removed. The browser profile table was empty in this
scripted active-Task fixture; this is schema/paired recovery evidence, not a real browser continuation
test. [Safe evidence](../../experiments/work-journey/evidence/active-paired-restore-schema44.json)
retains the current count instead of relabeling the earlier43-entry result.
