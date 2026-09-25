# Collaboration reuse review for a design-only packet

2026-09-25, before implementation. No new dependency or protocol proposed.

Existing exact reviewed implementation pins and notices are retained:
- AI SDK7.0.93 /6359fd58fe68eaade096b5d923bac26de84ca3bd (Apache-2.0) is the old
  tool declaration/behavior reference, not the Python runtime dependency.
- Temporal Python1.33.0 (MIT), existing Pydantic AI2.47.0 (MIT) deferred ports, and
  PostgreSQL17.11/Psycopg3.3.6 are the current released execution/transaction primitives.
- OpenBot retained local MIT collaboration/Run source is the adaptation target. No
  third-party source was copied and no source was substantially adapted in this design packet.

Read ledger entries `Channel Bot collaboration and richer attachments`, `Native asynchronous
collaboration`; docs/research/channel-bot-collaboration.md, async-collaboration.md,
python-work-product-reads.md; docs/ASYNC_COLLABORATION.md; actual installed Python SDK
`temporalio/workflow/_context.py` durable sleep API and root's current pending Action workflows.

Rechecked official primary documentation:
- https://docs.temporal.io/develop/python/workflows/timers: persisted durable timers release Worker
  resources and resume via Workflow history. This supports reusing Workflow sleep, not holding an
  Activity or an in-process Future while a child runs.
- https://www.postgresql.org/docs/17/explicit-locking.html: conflicting row locks and transaction
  advisory locking establish the creation/cancellation linearization; strongest/root-first lock
  order is required to prevent upgrades/inversions.
- https://github.com/temporalio/sdk-python/tree/1.33.0 was requested but web cache unavailable;
  installed exact pin's source is available and existing repository research owns upstream
  release/license/security/test inspection. No dependency replacement is needed.

Candidate order: existing released Temporal/PydanticAI/PG -> thin domain adapter. A2A v0.3.0
was already reviewed and deferred because external federation does not own local Bot membership,
Run ancestry or atomic Work admission. Temporal Child Workflow APIs are maintained but would add
another child-launch path beside the accepted WorkSourceAdmission/ingress; that path is unnecessary.
Reuse the single existing Temporal ingress and continuation owner instead. Do not resurrect the
old native-agent recursive execution/promise registry or legacy Run claim loop.

Observed concrete differences and unresolved root policy choices are recorded in DESIGN.md:
none-only legacy child SQL constraint versus current none/model platform; missing central ancestor
checks/cancel cascade; inherited root context cutoff; exact delegate and final-completion joins;
fixed300-second root-tree origin. These require root acceptance, not speculative product code.

## Accepted implementation checkpoint

Parent approved the design and none/model target policy on2026-09-25. The root origin is
the earliest exact-root-WorkRun run.claimed event, never submission time. SQL39 is assigned
to this packet; parent alone records migration history. Existing MIT OpenBot sources are
substantially adapted for tool contracts/ancestry; no third-party source or dependency added.
Implementation uses the existing released PG/Temporal primitives reviewed above.

## Accepted integration decision

Targets use their own none/model profile. Tree lifetime is300 seconds from the exact root
Work Run's first immutable run.claimed event; it never resets at child creation/restart.
A ready/pending callback runs before admission, and Workflow timers wait without a resident
Activity. Trusted join_request derives wait_for_task solely from the original creation Action.
The control-generated preparation Activity owns the new join Action key. A recorded
collaborationProtocol flag gates new Workflow commands so prior histories keep their old path.
Final drafts join outstanding direct children, then resume the same model conversation with
committed untrusted colleague observations. Publication rechecks that all children were joined.
Core accepts only finite child IDs and no caller-supplied source/target/assignment override.


## Composed product acceptance, 2026-09-25

The real HTTP/PostgreSQL/mTLS journey created two same-channel children through product
Work admission. It killed API/Worker after child SQL commit but before acknowledgement,
then recovered the original Workflow and original creation receipt without a second
child or model request. delegate_task joined its child; a provisional parent draft
waited for the other child at the final completion barrier and continued the same model
conversation. All nine distinct synthetic model requests occurred exactly once. Parent
and both children completed, with three actual histories replayed offline. The later
deadline-gated Workflow replayed these earlier flagged histories unchanged; actual new
expiry/cancellation qualification is recorded in python-work-collaboration-deadline.md.
The safe result is experiments/work-journey/evidence/product-collaboration.json.
