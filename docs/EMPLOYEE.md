# Portable employee model

## Product decision

An OpenBot Bot is a portable digital employee, not a chat preset and not the computer that runs
it. The employee owns a persistent identity, role, policies, learned skills, selected memories,
work history, and visual configuration. A Worker Host supplies temporary computer capabilities.

This separation gives the product three independent objects:

```text
Employee       persistent identity, growth, skills, memory, policy
Worker Host    replaceable Windows, macOS, Linux, VM, container, or managed device
Run            one auditable assignment of an Employee to a Worker Host
```

Replacing a computer must not replace the employee. Copying an employee must not silently copy
the source owner's accounts, credentials, approvals, or device authority.

## Employee profile

Selecting an employee opens a durable profile with seven views.

| View | Purpose | Source of truth |
| --- | --- | --- |
| Overview | Name, role, biography, appearance, status, work summary, and trust boundaries | Employee profile and control-plane records |
| Evolution | Chronological, evidence-backed record of meaningful capability changes | Immutable evolution events |
| Skills | Graph of acquired skills, prerequisites, provenance, version, confidence, and verification state | Versioned skill records |
| Live work | Current Run stage, tools in use, evidence, next action, approvals, and concise decision summaries | Structured Run events |
| Memory | Owner-visible working, episodic, semantic, and procedural memories with retention controls | Memory records and policy |
| Records | Runs, messages, artifacts, approvals, failures, evaluations, and audit references | Existing control-plane records |
| Configuration | Owner-editable role and biography plus read-only execution, portability, and authority boundaries | Revisioned Employee profile and Server policy |

The first profile release should be a normal product page, not the deferred office visualization.
The avatar opens the profile from the channel roster, message author, and Bot list.

The implemented editor deliberately changes only `role` and a 2,000-character descriptive
biography. PostgreSQL owns a compare-and-swap revision, so two devices cannot silently overwrite
each other. Every accepted change appends an evolution event containing changed field names rather
than biography text. Model preference, host binding, appearance, skills, schedules, and grants need
separate reviewed contracts; profile prose can never grant them.

## Evolution is evidence, not gamification

This product direction is inspired by
[Hermes Agent's learning graph](https://github.com/NousResearch/hermes-agent/blob/63279301bcbdc185c1b07b98a9312eb0c862f26d/agent/learning_graph.py):
skills, memories, provenance, use, and their relationships should be inspectable instead of hidden
inside one prompt. OpenBot adopts that idea while keeping authorization in its own Server policy;
no Hermes source code is copied into this implementation.

An evolution event records a real change to the employee:

- a skill was installed, learned, verified, upgraded, suspended, or removed;
- a policy or role changed;
- a memory was promoted into a reusable procedure;
- an evaluation score crossed a declared threshold;
- a human explicitly certified or revoked a capability.

Each event stores an actor, timestamp, reason, evidence references, previous and new versions, and
whether the change was automatic or approved. Cosmetic levels and badges may summarize the record,
but they cannot grant execution authority.

The implemented archive keeps the Server's stable event order, offers exact event-type filtering,
and uses a native dated scrubber to reveal a truthful prefix of the history. Each row exposes the
full timestamp, event id, source id, and bounded evidence references without silently fetching
their potentially sensitive payloads. This interaction is deliberately adapted from Hermes
Desktop's Learning Journey; OpenBot retains a simple ordered-list fallback instead of copying its
canvas graph runtime.

## Skill graph

A skill is a versioned capability description with explicit provenance. Executable skill bundles
will use the open [Agent Skills](https://github.com/agentskills/agentskills) `SKILL.md` directory
format and its official validator rather than an OpenBot-only format:

```text
Skill
├── stable id and semantic version
├── name, description, inputs, outputs, and required capabilities
├── prerequisites and related skills
├── source: built-in / installed / learned / imported
├── evidence: successful Runs, evaluations, and human verification
├── state: candidate / verified / suspended / revoked
└── policy: allowed hosts, risk ceiling, and approval requirements
```

Learning creates a `candidate` skill. It becomes `verified` only after deterministic validation or
human review. Skill confidence can influence recommendations, but routing and authorization still
use explicit Server policy.

The current lifecycle API registers graph metadata only. It does not install scripts, load a
`SKILL.md` into a runtime, or grant tools. Those actions require a later quarantined archive,
license/provenance checks, official format validation, and a separate local policy grant.

## Visible runtime reasoning

The UI must show an auditable **decision trace**, not private model chain-of-thought. A trace may
contain:

- the current stage and goal;
- evidence or observations used;
- a concise explanation of the chosen action;
- the next intended action;
- uncertainty, blockers, and approval requirements;
- tool calls and their structured outcomes.

Raw hidden reasoning, provider-internal tokens, secrets, and credentials are never required for
the feature. This keeps the interface useful across model providers and avoids presenting verbose
internal text as reliable audit evidence.

## Memory boundaries

Memory is split by purpose and portability:

| Class | Example | Default export |
| --- | --- | --- |
| Working | Current task scratch state | Never |
| Episodic | A completed interaction or Run summary | Excluded |
| Semantic | Stable facts approved for future work | Owner selects |
| Procedural | Reusable instructions and learned routines | Included when licensed and verified |
| Secret reference | Credential or vault reference | Never |

Every memory has provenance, sensitivity, portability, and a monotonically increasing revision.
The current Owner-only lifecycle provides bounded create, edit, and physical delete operations.
Updates and deletion require the revision the Owner reviewed, so a concurrent change returns a
conflict instead of being overwritten. Each successful mutation appends a content-free audit event
containing only the memory id, action, revision, changed field names, actor, and time. Deleted text
is not retained in that event.

Memory titles and content pass the same credential/private-key scanner used by Employee export.
`secret-reference` stores only an opaque vault reference, is always `restricted`, and is never
portable. Machine-local paths remain valid in local-only memories. Models and Worker Hosts cannot
call the Owner lifecycle. Native tasks may propose reviewed lessons and retrieve only explicitly model-enabled memory; autonomous active-memory writes remain disabled, and
`openbot.employee/v1` still exports zero memories.

### Portable instruction content (v2)

The sharing dialog includes reviewed single-file `SKILL.md` instructions by default; uncheck the
content option for metadata-only sharing. API clients retain v1 by default and opt into v2 with
`includeSkillContent=true` on both preview and download. The reviewed download token binds this
selection to the exact file. The portable document is limited to 1 MiB before signing to fit the
DSSE and 2 MiB import limits; each instruction remains subject to the existing 12 KiB parser limit.

Included content preserves its original normalized text, notices, license and SHA-256 digest.
Supported license identifiers are MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, CC0-1.0,
CC-BY-4.0 and CC-BY-SA-4.0. Authors remain responsible for permission and required notices.
Unknown/missing licenses, unreviewed or changed content, and scripts/assets/dependency bundles
block content export. No referenced file is silently fetched. Metadata-only skills are explicitly
identified and do not become runnable through import.

Import checks the content again, refuses a conflicting local slug/version, creates a new identity,
and keeps skills as disabled candidates. The recipient reviews the exact content digest before
it appears in the native Agent skill catalog. Memory, credentials and host grants never transfer.

## Copy, export, and transfer

OpenBot supports three different operations. They must not share one ambiguous “clone” button.

| Operation | Result | Identity rule |
| --- | --- | --- |
| Export template | Reusable role, appearance, policies, and selected verified skills | Creates a new employee on import |
| Clone employee | Local duplicate with owner-selected, sanitized experience | Always receives a new employee id |
| Transfer employee | Ownership handoff of an employee package and selected history | Revokes source access before activation |

The portable package is a versioned, signed archive containing a manifest, profile, skill records,
approved memory, appearance assets, compatibility requirements, licenses, and checksums. It excludes
credentials, cookies, session tokens, Node identities, capability leases, raw screenshots, private
audit events, and local filesystem paths by default.

Import always shows a preview:

1. verify signature, checksums, schema version, and licenses;
2. list included memories, skills, assets, and requested capabilities;
3. highlight missing providers and incompatible platforms;
4. let the owner remove optional data;
5. assign a new local identity unless this is an authenticated transfer;
6. keep all imported skills disabled until policy validation finishes.

The implemented template path now follows those boundaries for identity-free packages: activation
repeats validation, requires the exact reviewed package id and canonical digest, requires explicit
Owner acceptance for an unsigned source, creates a fresh local identity, and records an immutable
idempotent receipt. On the sending side, export preview is derived from the exact package builder
used by download and shows the selected role, optional biography, appearance, and each verified
skill with its description, version, requested capabilities, and dependencies. Before activation,
the receiving quarantine view shows the Employee name, role,
optional biography, skills, requested capabilities, publisher trust, compatible hosts, and
zero-authority boundary. The biography is untrusted descriptive text and grants nothing. This path
does not implement authenticated ownership transfer or optional-memory selection. If a verified
skill depends on a skill outside the verified export set, the sending Server blocks download rather
than silently removing that edge from the portable graph. `dependencySlugs` remains an OpenBot v1
extension because the Agent Skills specification does not yet define skill-to-skill dependencies.
The sender also binds download to the preview's package id, generation time, and strong validator
over the exact serialized file. A missing review is rejected, and a changed profile or publisher
state returns `412` so the Owner must inspect a fresh preview; the Client never accepts or downloads
a newly generated replacement silently.

An employee package carries knowledge and configuration. It never carries authority to a computer.
The receiving owner must explicitly bind it to a Worker Host and grant a local policy profile.

## Data ownership and deletion

- The Server remains the source of truth for employee identity and history.
- Worker Hosts receive only Run-scoped context and short-lived capabilities.
- Owners can inspect, edit, and delete Employee memory; memory export and category-wide retention
  policies remain planned.
- Connected Web Clients receive a content-free profile invalidation after committed Employee
  mutations and reload the selected profile from the authenticated Server aggregate. Reconnect also
  reloads the selected profile, so another device's changes do not require a manual refresh.
- Audit records needed to explain security decisions are retained separately from portable memory.
- Shared skills preserve authorship, source URL, license, and integrity metadata.
- Transfer and deletion are explicit lifecycle events and cannot be inferred from file download.

## Delivery slices

1. **Profile foundation:** overview, configuration, Run history, and existing artifacts.
2. **Evolution ledger:** append-only events generated from existing Bot, Run, and skill changes.
3. **Skill registry:** versioned records and a read-only dependency graph.
4. **Memory controls:** Owner-managed typed memories, sensitivity, revision-safe editing, deletion,
   and content-free audit are implemented, with default-off model sharing and Owner-reviewed task proposals; retention and semantic/full-text search remain future work.
5. **Portable templates:** safe export/import without private memory or authority.
6. **Selective clones:** owner-reviewed memories and local re-identification.
7. **Authenticated transfer:** signed ownership handoff, source revocation, and import receipts.

## Current implementation status

Implemented on the `feat/cross-platform-employees` development line:

- a persisted employee evolution ledger, versioned skill registry, dependency graph, and typed memory
  storage;
- an authenticated `GET /api/v1/bots/:botId/profile` aggregate projection;
- an authenticated, revision-checked `PATCH /api/v1/bots/:botId/profile` command and profile editor
  for role and biography only, with content-free evolution/realtime metadata;
- automatic creation events for new employees and a safe backfill for existing Bots;
- a responsive seven-view employee profile opened from the Bot list, channel roster, and message
  authors;
- a Hermes-inspired evolution archive with exact type filters, a truthful dated cutoff, stable
  newest-first presentation, and inspectable event/source/evidence identifiers;
- structured Run progress presented as decision summaries rather than private chain-of-thought;
- an authenticated, same-builder export preview and checksum-protected JSON template containing
  only role, descriptive biography, appearance, execution preference, and verified skills; the
  sender can inspect the exact profile and selected skill metadata before download;
- a strong reviewed-download precondition that binds package id, generation time, and exact
  serialized bytes, with explicit refresh after a stale `412` response;
- dependency-closed verified skill exports; a missing, candidate, suspended, or revoked dependency
  blocks download instead of being silently removed from the portable graph;
- structural exclusion of identity, authority, memory, and work history, plus blocking checks for
  credential-like text, private keys, and user-specific local paths;
- a 2 MiB-bounded, strict-schema import inspection endpoint and UI that validate checksum, skill
  dependency/capability consistency, sensitive text, and connected Worker Host compatibility,
  then show the role, optional biography, requested capabilities, and zero-authority boundary;
- complete metadata review for every imported skill: Agent Skills description, version, required
  capabilities, dependency slugs, and explicit disabled-pending-review state;
- a read-only quarantine projection that cannot create an Employee, activate a skill, persist
  memory, bind a host, or grant authority;
- an authenticated activation command that revalidates the package and current-host compatibility,
  binds the exact preview digest, creates a fresh Employee identity in one PostgreSQL transaction,
  imports every skill as `candidate` with confidence `0`, and writes an immutable idempotency
  receipt without granting host authority;
- strict Owner-authenticated commands that add Agent Skills-compatible metadata as a `candidate`
  and explicitly verify, suspend, or permanently revoke it while appending evolution evidence;
- an Owner skill-review surface that exposes description, provenance, dependencies, required host
  capabilities, and evidence references, limits actions to valid transitions, records a reason and
  confidence, and separates terminal revocation from the first click;
- conditional state updates that reject concurrent review races and never change Worker Host
  capability claims or policy grants;
- strict Owner-only memory create/update/delete commands with bounded fields, credential-value
  blocking, optimistic revision checks, physical content deletion, and content-free lifecycle
  events; the profile provides the corresponding accessible editor and explicit delete review;
- a bounded DSSE envelope schema plus tested Ed25519 signing and trust-store verification over the
  exact bytes later parsed as the employee package; envelope key hints never make trust decisions.

HTTP export is unsigned and memory-free by default. An experimental Owner filesystem keyring now
supports encrypted Ed25519 private-key storage, explicit public-key trust, rotation, revocation,
signed DSSE export, verified quarantine preview, and reviewed activation. It does not provide global
publisher identity, automatic revocation distribution, native keyring/KMS custody, registry
installation, selective-memory cloning, or ownership transfer. See the
[signing runbook](EMPLOYEE_SIGNING.md). Skill review supports graph metadata and exact-digest review of single-file instruction content. Autonomous skill proposals, executable Agent Skills archives, full-diff
review, semantic/full-text retrieval and retention, autonomous active-memory writes, selective cloning, and
authenticated ownership transfer are not implemented yet. Their data and authority boundaries are defined here
so contributors can add them without coupling employee knowledge to Worker Host access.

## Acceptance criteria

- Clicking a Bot anywhere in the core UI opens the same employee profile.
- The profile can explain every displayed skill and evolution event with evidence.
- Live work shows structured progress and decision summaries without exposing secrets.
- Exporting a default template contains no credential, session, lease, Node identity, or private
  memory.
- Importing on a machine without the required Provider remains safe and clearly blocked.
- A copied employee cannot operate any Worker Host until the receiving owner grants local authority.
- Deleting an employee follows an explicit retention policy and does not silently corrupt audits.
