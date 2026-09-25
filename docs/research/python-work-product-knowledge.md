# Durable Work knowledge adapter

2026-09-25. Thin composition over accepted code; no new dependency, SQL, retrieval framework,
model loop or automatic learning. Employee learning remains inspired by Hermes Agent.

Before implementation, reviewed the reuse ledger's Employee learning/reviewed knowledge,
Work-bound knowledge, durable tool observations and correction entries. Reuse their pinned
source/release/test/security/license reviews: Hermes Agent
63279301bcbdc185c1b07b98a9312eb0c862f26d (MIT); Agent Skills
69ef37e9424c0a7ea9dd2293b559e43ec8176379 (Apache-2.0 code / CC-BY-4.0 docs);
Pydantic AI 2.47.0 / 77d5fce751ab8ab04bd5db4ed6acc1131a4baed6 and Temporal Python
1.33.0 / ab52fdde33ee8ed193402625bfdba25d240a762d (MIT); PostgreSQL 17.11 / psycopg 3.3.6.
Primary retained contracts: https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/
and https://www.postgresql.org/docs/17/explicit-locking.html.
Read root `python-work-knowledge-runtime.md`, `work-tool-results.md`, original native-agent
tool schemas, Python knowledge/correction/deferred/receipt/completion code and migrations
0020/0037. No upstream source is copied; existing OpenBot code remains under its MIT notice.

The first viable option is the existing PostgresKnowledgeRuntime + ToolResponseAdapter/Verifier.
The local gap is retaining a private typed knowledge receipt with the observed public payload,
then checking that receipt under current Activity authority before returning or reusing it.
Do not put a receipt in model arguments, Action effect metadata or the model result.
The 128-KiB ToolResults envelope and existing unique source-run proposal index suffice.

Use fixed tools `knowledge_catalog` (optional query), `read_skill` (skillId),
`read_employee_memory` (empty arguments), `propose_memory` (kind/title/content).
`knowledge_tool_descriptors()` returns fresh Runtime ToolDescriptors using the existing
ChannelBotId UUID schema and KnowledgeProposal schema. The released offline ToolCatalog
validates the schemas and rejects private fields; Control repeats semantic validation.
Plans have no approval requirement or token charge; they authorize neither reads nor proposals.
Actual apply checks admission, current SDK facts, source/member/correction and Activity fence.
Skill reads select only a prior applied catalog, never a model-supplied receipt. Read receipts
and drafts are private JSON dataclasses decoded only from verified Control blobs. Reuse the
strict carry methods across Activity epochs; authority generations never carry.

Add only `ToolResults.load_in_transaction` to reuse its existing scope, metadata, settlement,
codec and private hash/size readback inside caller-owned admission/publication transactions.
Calling the independent-connection load while holding Task UPDATE would self-lock.
The shared read takes Task/Action/receipt SHARE locks and still checks the exact persisted
scope, intent hash and applied settlement; standalone load delegates to this same path.
Use a per-operation in-transaction knowledge subclass solely to route the existing algorithms
through that same transaction; no selection, review, fingerprint or scope algorithm is copied.

Result Activities acquire a fresh actual-SDK-derived claim outside the read transaction. A
retry of the same live Activity reuses the claim; an expired/superseded claim refuses. Recovery
of an already observed Action remains ToolResults readback and never reapplies an unknown tool.

Default correction behavior fails closed if any applied knowledge belongs to an older authority
generation. Trusted `history_reset_on_correction=True` may omit old generations only with root's
recorded correctionHistoryProtocol=1, which discards all old model history/results and restarts
from objective + all corrections + content-free prior Action facts. Match generation and full
corrections, not only context-token equality. Old result reads always raise CorrectionsChanged.

Completion takes Bot UPDATE before any knowledge-record locks, verifies all current consumed
receipts and at most one prepared draft, and returns a private same-transaction candidate.
After root's verified terminal update, insertion checks the exact terminal scope/generation,
fence and transaction identity, then creates only a pending Owner-review proposal. Existing
unique sourceRun and the 50-pending cap are retained; saturation records a content-free skip and
does not undo task completion. Repeating the same insertion in the same commit is readback.
Root alone owns Task completion, publication and future activation.

Focused qualification: 29 real PostgreSQL tests passed in 17.49s; the final descriptor/UUID
addition passed all 8 affected cases in 5.79s (30 distinct adapter cases total). Retained
ToolResults' 16 tests passed against the shared transaction reader, including cancellation,
scope, corrupt blobs/metadata/evidence, missing results, retained JSON shapes and no resend.
The two-completion concurrent probe at 49 existing pending records produced exactly one insert
and one content-free skip, leaving 50 pending and both Tasks completed. Real Temporal scheduling
and root's verified publication hook remain integration work, not inferred from synthetic SDK
Activity/history fixtures. No provider or private user credentials were used.
