# Channel command source adapter

2026-09-25, before implementation. This is the final narrow source/profile adapter around the
already reviewed Work command profiles. Reuse `docs/research/work-command-authority.md`,
`work-command-transactions.md`, `python-work-task-profiles.md` and their existing Open Source
Reuse ledger entries. The frozen CommandProfiles and same-transaction source helpers are the
first viable existing implementation; only their previously disconnected product entry is new.
No new library, crypto, schema, scheduler or alternate executor is required. Existing OpenBot
MIT code is adapted locally; no upstream source is copied.

PostgreSQL17.11 is the existing pinned backend; official row-lock semantics were revisited at
https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS . Existing source/channel
locks precede Task locks. Capture joins the original source creation transaction and reads
current node_credentials with FOR SHARE. It does not acquire a registry/network guard or make
a network call. Dispatch still owns its later real connection/Work/signature checks.

The retained runs constraint deliberately permits model_selection only for legacy model Runs.
Docker Runs therefore keep model_selection=NULL and node_id=NULL. The inserted immutable
CommandProfile owns the modelSelection and trusted route/policy/credentialDigest. Each product
resolution reuses its current model connection, Node credential and policy checks. Missing,
ambiguous, revoked or changed profiles never select a current Bot/environment fallback.

Approved semantic distinction: selection identity is immutable, while a legal Owner revision
to that same model connection before the first step resolves current credentials. Existing
ProductWorkModel._fresh rejects configuration/key changes during a model step. This packet
does not invent a frozen model connection revision absent from the accepted Profile contract.

The owned real PostgreSQL runner reuses ControlDatabase from the existing active restore
experiment, creating a new independent random container/volume/DB and applying canonical
migrations. It removes only its recorded owned resources. All model requests are synthetic SDK
transports; there is no paid request, real protected Host or Linux qualification claim.

## Exact reuse and integration scope

The six source baselines are pinned by `BASELINES.json`. No upstream implementation was
replaced: this is an adapter into the existing CommandProfiles, WorkSourceAdmission,
ProductWorkBinding, ProductWorkModel and ProductWorkReads services. Their maintained tests and
reviewed dependencies remain authoritative. The relevant ledger entry is **Work command identity and fingerprints**, including
its same-transaction adapter paragraph and the native Task product-profile reuse paragraph. The maintained repository source and migration 0041 were inspected before editing;
this packet deliberately does not alter their schema, signing or frozen-profile contract.

`CommandProfiles.capture_in_transaction` describes a route/identity guard; this source hook
performs that check against current persisted `node_credentials`, under the original SQL
transaction, without claiming a current socket. The later CommandDispatches admission must
still use its actual registry identity guard and signed protected-Host protocol.

No new package or standard adapter is needed. PostgreSQL row locks, the released psycopg3.3.6
transaction adapter, and the existing Pydantic2.13.5 strict profile parser are retained. The
concrete gap was the omitted docker branch in source admission and product source resolution.
The public default remains off; installations that do not supply both trusted services and a
fixed route/policy still reject this source. Upgrading or replacing CommandProfiles remains
possible through an explicit trusted composition change, never through a model argument.

## Verification and limits

The qualification runner uses canonical43 PostgreSQL migrations, isolated Owner/Node/Bot/channel
records, and current released provider SDKs through synthetic transports. Existing SDK/history
fixture seams supply accepted Activity facts; no real Temporal history or Linux protected Host
was executed in this packet. It proves source/SQL/current-authority/adapter behavior, not native
command execution, wall deadlines or enforcement. No dependency/license notice is newly needed.
Invalid captured selection is a finite `WorkConflict('command_profile_invalid')`, with source,
message, Run and Work rows rolled back together. Unknown model sends retain their original
Action; tests do not add claims of automatic retry or effect completion.
