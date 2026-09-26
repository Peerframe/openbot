# Research: S5 scoped memory, reviewed skills, and offline evaluation

- Status: Implemented offline fixture; product integration is not approved by this record
- Date: 2026-09-24
- Owner: OpenBot contributors
- Related plan: S5 in `docs/ARCHITECTURE_MIGRATION_PLAN.md`
- Acceptance journey: a synthetic Owner correction to a completed Task yields a scoped lesson and candidate skill; an Owner reviews the exact candidate; a distinct held-out CSV task improves; suspension and terminal revocation remove subsequent use.
- Security boundary: the Server remains the only prospective authority for source verification, Bot scope, review, grants, and Artifact publication. The offline evaluator is a reference fixture, not a Server or model.

## Search evidence

- Search date: 2026-09-24.
- GitHub queries: `hermes-agent learning_graph.py write_approval.py memory skills tests`, `agentskills specification skills-ref security`, `langmem memory update delete scope tests`, `letta archival memory search provenance`. Inspected pinned Hermes `learning_graph.py`, `write_approval.py` and their tests, Agent Skills specification/validator tests/evaluation guide, and LangMem extraction source. Reviewed Agent Skills issues #144 and #485 and LangMem's issue list, including retrieval mismatch #140 and poisoning proposal #164. Issues are risk signals, not verified defects in OpenBot. GitHub HTML fetches for Hermes failed; exact raw files were subsequently fetched successfully. No upstream test suite was run.
- Primary documents: [Agent Skills specification at `69ef37e9`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx), [PostgreSQL 17 row locking](https://www.postgresql.org/docs/17/explicit-locking.html), and OpenBot's `docs/WORK_EXECUTION_CONTRACT.md`.
- Existing OpenBot review: `docs/OPEN_SOURCE_REUSE.md` entries for Hermes, Owner memory, review, and reviewed skill content; `docs/research/agent-reviewed-knowledge.md`, `docs/research/reviewed-skill-content.md`, ADR-0026, and current TS protocol. Python has both legacy Run projections and an opt-in independent work Task/Run/Artifact slice. Its S5 integration contract remains open.

## Candidate comparison

| Candidate | Exact reviewed release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/63279301bcbdc185c1b07b98a9312eb0c862f26d) learning graph and write approval | `63279301bcbdc185c1b07b98a9312eb0c862f26d` | MIT | Inspected source and tests for pending writes, inline denial, configured bounds, graph edges, and memory cards; existing review places this commit after v2026.8.31 | Direct inspiration; its write gate defaults off and file-based authority cannot own OpenBot's Server state | Preserve attribution and review concepts; copy no source |
| [Agent Skills](https://github.com/agentskills/agentskills/tree/69ef37e9424c0a7ea9dd2293b559e43ec8176379) | `69ef37e9424c0a7ea9dd2293b559e43ec8176379` | Apache-2.0 code, CC-BY-4.0 docs | Specification and `skills-ref` reference tests; issue #144 records `allowed-tools` ambiguity | Standard `SKILL.md` shape is useful, but it does not define OpenBot review, scope, or authority | Use a single-file candidate shape; never interpret `allowed-tools` as a grant |
| [LangMem](https://github.com/langchain-ai/langmem/tree/f8c7ebd6110c124a36995dab645a8cb0eb0b8210) | `f8c7ebd6110c124a36995dab645a8cb0eb0b8210` | MIT | Extraction and typed memory API; deletion defaults off; current issue #140 illustrates retrieval/write integration risk | Model-assisted memory manager would add a second write authority and model dependency to a deterministic fixture | Reference for evaluation questions only |
| Existing OpenBot review and Python standard library | Current `e176e90a9de3854f0bf745773b7996e7bd572c83` | MIT / PSF | TS Server lifecycle has PostgreSQL and protocol tests; Python `unittest`, `json`, `decimal`, `hashlib` are already available | Only choice that runs from a fresh checkout without credentials or new authority | Use a narrow standalone adapter over synthetic facts |

## Reuse decision

- Selected option: Agent Skills single-file shape plus an isolated Python standard-library evaluator. No new dependency or model call.
- Why this is first viable: the standard covers skill representation, while existing OpenBot lifecycle covers review. Neither supplies a safe offline score tied to a Server-owned Task/Artifact provenance check. Adding a full memory service would duplicate S2 authority before its Task/Artifact interface is final.
- Exact local gap: a deterministic fixture that rejects unverifiable correction sources, distinguishes memory from skill state, filters retrieval by Bot/workspace/task kind and query relevance, binds Owner review to a content digest, compares held-out outputs before/after review, and proves disable/revoke/deletion do not silently reapply a lesson. The fixture's arithmetic interpreter is deliberately **not** a production skill executor or model-quality test.
- Replacement plan: reuse S2's existing work identities and verified Artifact storage after agreeing the correction, source-validation, consumed-reference, review-revision and publication interfaces. Replace the fixture interpreter with model/runtime evaluation while retaining the same source/scope/authority cases. Do not port its in-memory store into production.
- Failure behavior: missing source facts, mismatched scopes, stale digest, unauthorized review, unsupported rule, missing grants, or revoked/deleted records fail closed.

## S2 contract dependency and design boundary

The target contract makes a Task the objective, Run an attempt, and Artifact an independently addressable verified result. This experiment proposes correction provenance containing Task ID, Run ID, source Artifact ID and digest, Owner identity, Bot ID and scope. For this bounded journey it requires a completed Task and a byte-verified source Artifact, checked against authoritative fixture facts. Completion and byte integrity do not imply the original result was semantically correct. A pending candidate cannot be retrieved as active knowledge. An Owner's decision binds version, scope, structured rule, provenance and exact content via an envelope digest; cancellation, revision conflict, or deletion prevents later application. Retrieval returns IDs, revisions, source refs and bounded content after current scope and model-use checks. A Runtime may propose a lesson but cannot approve or expand grants.

Python S2 includes opt-in independent `work_tasks`, `work_runs` and `work_artifacts` (migrations 0027/0028), authenticated `/api/v1/tasks` snapshots and `/api/v1/artifacts/{id}` downloads (`work_routes.py`), and trusted completion checks for authority, revision, fencing, resolved actions and stored bytes (`work_completion.py`). Legacy channel Run APIs remain alongside this slice. Legacy Python completion already checks consumed memory/skill references, while work completion has no corresponding S5 reference input. Existing legacy steering rejects completed Runs.

Before product integration, agree: (1) authenticated, idempotent post-completion correction binding Task/Run/Artifact/digest/revision; (2) an authoritative source-validation read using existing Artifact verification; (3) scope fields, because workspace/task kind below are synthetic policy dimensions absent from current work Task projections; (4) checkpoint and publication reference rechecks with a serialization point; (5) source deletion, descendant invalidation, stale review, suspension/resume, terminal revocation and version rollback semantics. The work Artifact API currently has no delete command. TS skill review has a digest check but does not currently accept `expectedRevision`; the fixture's revision input is a proposed contract, not an existing feature.

This experiment uses synthetic IDs only and performs no product write. It does not establish S5 completion, model generalization, real deletion of previously sent context, or live evaluation quality.

## Source incorporation

- Source copied or substantially adapted: no.
- Files and upstream locations: none copied; upstream links above are design references.
- Required notices: existing OpenBot reuse ledger retains upstream licenses and Hermes Agent attribution.

## Verification plan

- Automated tests: reproduce the same JSON fixture and score, train/held-out separation, source validation, digest-bound Owner review, state transitions, scope and query filtering, memory deletion, and unchanged grant set.
- Negative tests: wrong Bot/workspace/task kind, unrelated query, pending/suspended/revoked skill, changed candidate content, missing verified Artifact, non-Owner reviewer, requested capability without grant, and deleted lesson.
- Platform: Python standard library on the current local host; no network, database, or model required.
- Documentation: English experiment README plus Simplified Chinese companion; this research record is contributor evidence, not user-facing product documentation.

## Unresolved questions

- Exact S2 public command/schema for corrections and verified Artifact references is not fixed.
- Real retrieval ranking, poisoning checks, version rollback semantics, prompt behavior and task quality need separate evaluation using isolated data and explicit Owner review.

## Completed experiment and corrections

The [experiment](../../experiments/s5-memory-skills/README.md) uses training-only correction
pairs to infer a bounded decimal scale, emits a single-file Agent Skills candidate and compares
new input/output tasks against a separate static answer key. This follows the pinned
[Agent Skills evaluation guide](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/skill-creation/evaluating-skills.mdx)
baseline/comparison pattern without adopting a model runner. Retrieval uses a declared English CSV
vocabulary, exact synthetic scope, explicit memory opt-in and bounded results. No semantic-search
quality is claimed.

The first interrupted draft incorrectly inferred that S2 had no independent work Artifact API
from its legacy Run projection. Full inspection of migrations 0027/0028 and work models/routes/
completion corrected that statement before implementation; the dependency is now the S5 integration
contract, not creation of Task/Artifact infrastructure.

Independent experiment review then reproduced three gaps: skill revocation left its lesson
retrievable, common words triggered unrelated retrieval, and expected refusal lost its consumed
skill reference. Fixed behavior vetoes descendant retrieval during suspension/revocation, advances
memory eligibility revisions, restricts the fixture vocabulary, and separates selected/consumed
references from output publication. These are now regression cases.

On 2026-09-24, Python 3.12.13/macOS passed 16 dedicated checks. The real CLI exported a fresh
synthetic evidence directory and reopened CSV bytes. Held-out results were baseline/pending 0/3,
reviewed 3/3, suspended 0/3, resumed 3/3, revoked 0/3. A reviewed incorrect rule independently scored
0/3. The generated 454-byte candidate passed the existing OpenBot `parseSkillDocument` parser;
its content SHA-256 is `afba238402f55a33f1768fba79836f52a3f560da3084bd19f97b8d3f449c33b7`.
This is parser compatibility evidence, not an import or an official skills-ref run.

`npm run check` passed using existing Turbo caches for unchanged workspace tasks. Its normal
environment-dependent skips remain; no new PostgreSQL, provider, native platform or S3/S4
qualification was performed. The [committed report](../../experiments/s5-memory-skills/evidence/local-result.json)
contains full synthetic failure/pass outputs and limits. S5 remains pending product integration
and real-model evaluation.


## Independent integration acceptance (2026-09-24)

Codex reviewed `5d838b5` and ran the unchanged candidate independently with
Python 3.12.13. All 16 unit checks passed, and the actual CLI exported and reopened
synthetic evidence in `/private/tmp/openbot-s5-independent-evidence-20260924`.
Logs: `/private/tmp/openbot-s5-independent-tests-20260924.log` and
`/private/tmp/openbot-s5-independent-probe-20260924.log`. Results were
baseline/pending/suspended/revoked 0/3 and reviewed/resumed 3/3; old references
were refused and the grant set was unchanged. These scores describe the fixed
arithmetic interpreter only, not general learning or live-model performance.

The original task's handoff message had failed, but its clean committed worktree
was available and directly inspected; no implementation was repeated. The fixture
is integrated as offline S5 preparation. Its synthetic scope fields, in-memory
state machine and structured review envelope are not approved product contracts
or a second control authority. Product integration still depends on correction
provenance, access/deletion policy and serialized reference rechecks in S2/S3.
