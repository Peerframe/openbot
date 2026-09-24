# S5 scoped memory and reviewed skill experiment

[English](README.md) · [简体中文](README.zh-CN.md)

This standalone synthetic fixture demonstrates correction → candidate lesson/skill → exact Owner
review → held-out comparison → suspension/resume → terminal revocation → deletion. It supplies the
first offline S5 evidence, not S5 completion. The learning and provenance direction is inspired by
[Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/63279301bcbdc185c1b07b98a9312eb0c862f26d).
See the [research and S2 interface review](../../docs/research/s5-memory-skills.md).

## Reproduce

Run from the repository root with Python 3.12+. No install, credentials, network, model, database,
product configuration or running service is needed:

```sh
python3.12 -B -m unittest discover -s experiments/s5-memory-skills -p 'test_*.py' -v
python3.12 -B experiments/s5-memory-skills/probe.py
```

To retain the full report, generated candidate SKILL.md and each stage's CSV output, choose a
**new** directory. Existing directories are rejected:

```sh
python3.12 -B experiments/s5-memory-skills/probe.py --output-dir /tmp/openbot-s5-evidence
```

`report.json` records actual/expected outputs, fixture digest, candidate review digest, source
identities, scope, consumed references, denials and content-free lifecycle events. Export reopens
each CSV and checks its digest and length. An expected sub-cent refusal retains selected/consumed
skill references and produces no output file. The committed [local report](evidence/local-result.json)
contains only synthetic data.

## Experiment design

`fixtures/training.json` is the only input to candidate generation. Two corrected examples induce a
constant decimal scale. The supported hypothesis is deliberately small: an integer multiplier from
1 to 1000, preserving row IDs/order and requiring exact integer outputs. The generated SKILL.md
describes that rule. The evaluator uses the same digest-bound structured rule; it does not interpret
arbitrary Markdown, execute code or call an LLM.

`fixtures/held-out.json` holds two new CSV tasks (sales and refunds/zero) and a sub-cent rejection
case. Task IDs, Run IDs and row IDs are disjoint from training. The interpreter accepts task inputs
only; a separate scorer reads the answer key. A reviewed but wrong factor is a negative control
and scores 0/3. The baseline intentionally reproduces the original defect: renaming the column while
copying dollar values unchanged.

Memory and skill states are separate. Memory starts pending and sharing defaults off; Owner review
can enable retrieval. A skill needs its own review. Review binds the immutable version, Markdown,
inferred rule, source and scope through an envelope SHA-256, plus the current assignment revision.
This envelope is an experiment format, not a replacement for the product's SKILL.md content digest.

| State change | Subsequent behavior |
| --- | --- |
| Candidate → verified | Owner identity, current revision and exact envelope digest required |
| Verified → suspended | Skill and derived memory excluded; memory revision advances |
| Suspended → verified | Owner reviews again; new revisions invalidate old references |
| Candidate/verified/suspended → revoked | Terminal; derived memory remains excluded |
| Delete lesson | Remove current lesson and derived skill text/rule/digest; retain ID-only tombstones and content-free audit |

This conservative descendant invalidation policy awaits product contract agreement. It prevents a
revoked correction from returning through memory. Deletion removes current in-memory records;
immutable synthetic inputs, exported evidence and previously returned context are separate retention
domains and are not erased by this method.

Retrieval requires the exact Owner/Bot/workspace/task-kind tuple. Workspace/task kind are **synthetic
policy dimensions**, absent from current S2 work Task projections. Within that scope, it ranks
overlap of a declared vocabulary: CSV, dollar, cent and refund (singular/plural), requiring two terms.
This tests scope-before-ranking, stable ordering, opt-in and bounds. It is not general semantic
retrieval, multilingual relevance or a production search recommendation.
Queries are at most 512 bytes; at most 8 memories within 10 KiB; lesson text at most 2000 bytes;
CSV inputs at most 4096 bytes/32 rows; evaluation at most 16 cases.

Trusted fixture control supplies Owner identity, source facts and grants. Corrections cannot add
authorization fields. The only simulated grants are `csv.read` and `artifact.write`; skill prose
cannot alter them. Network requests are denied, and removing `artifact.write` prevents output even
with a verified skill. The interpreter admits no actual network or file effects; the separate CLI
writes only the selected evidence directory.

## Observed evidence

Local run, 2026-09-24: macOS / Python 3.12.13, source baseline
`e176e90a9de3854f0bf745773b7996e7bd572c83`, interpreter `decimal-scale-fixture/1`.

| Stage | Held-out cases passing | Skill applied |
| --- | --- | --- |
| Baseline | 0/3 | No |
| Pending | 0/3 | No |
| Reviewed | 3/3 | Yes; sub-cent case refuses output |
| Suspended | 0/3 | No; derived memory absent |
| Resumed | 3/3 | Yes; old reference still rejected |
| Revoked | 0/3 | No; derived memory absent |

New sales baseline: `2.37, 19.99, 10`; reviewed output: `237, 1999, 1000`.
These are deterministic fixture results, not statistics about model quality.

All 16 dedicated tests pass: provenance corruption, unauthorized review, altered envelope/rule,
stale revisions, four scope dimensions, unrelated queries, pending/disabled/revoked exclusion,
model-use default, deletion, replay prevention, grant removal, train/evaluation separation,
score sensitivity, output refusal and reopened export bytes.
Independent review initially reproduced three gaps: memory survived skill revocation, common words
caused irrelevant matches, and a refusal omitted consumed references. All three were corrected and
are now covered by regressions.

`npm run check` passed, using existing Turbo cache hits for unchanged workspace tasks.
Database/live-provider/native-platform tests remain skipped by their normal gates; no new evidence
for those systems is claimed. Python experiment tests run separately because shared scripts/CI
are outside this work package.

## Product handoff

Python S2 already has independent work Task/Run/Artifact records, authenticated snapshots,
byte-verified downloads and trusted completion. Reuse those identities and storage. Agree first:

1. Authenticated, idempotent post-completion correction bound to Task/Run/Artifact/digest/revision.
2. Source-resolution reads and source access/deletion policy using existing byte verification.
3. Approved scope dimensions; model-selected scope must never become authority.
4. Consumed memory/skill references in work checkpoints and final publication, with current
   revision/digest checks and a serialization point for revocation.
5. Review conflicts, descendant invalidation, rejection/expiry, version rollback and retention.

Not implemented: general proposal queue, free-text teaching, executable skill archives, rollback to
an earlier release, concurrent/durable review, deletion from backups/providers, model poisoning
protection, live task quality or product integration. No product service, S3 Runtime, S4 executor,
default backend or deployment is changed.
