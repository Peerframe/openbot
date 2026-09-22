# Research: Attachment input evidence in delivered reports

- Status: Accepted for implementation (F1a)
- Date: 2026-09-23
- Owner: OpenBot maintainers
- Acceptance journey: upload a synthetic channel file through the Owner API, explicitly attach it
  to a task, read bounded pages, then download a report with Server-recorded input identity and
  coverage. Unread files must not be presented as read.
- Security boundary: existing Run/channel authority, immutable file storage and report publication.
  No shell, arbitrary paths, new binary decoder, outbound service or model-created provenance.

## Search evidence

Searched GitHub for `vercel ai source-document tool`, `vercel/ai sources tool result citation` and
official documentation for `PROV-DM used entity activity`, AI SDK model messages and tool results.
Reviewed existing attachment/report/reuse entries, channel-attachments, agent-attachments,
AgentExecutionState and the real headless journey at OpenBot `8264114`.

## Candidate comparison

| Candidate | Pin and license | Source, release, tests and issues | Decision |
| --- | --- | --- | --- |
| W3C PROV-DM | [2013-04-30 Recommendation](https://www.w3.org/TR/2013/REC-prov-dm-20130430/), W3C document terms | Stable specification distinguishes input entities, usage and generated entities. It does not provide an attachment reader or infer that a conclusion follows from supplied evidence. | Reuse the conceptual separation; do not claim PROV serialization/conformance or introduce an RDF engine. |
| Existing AI SDK | ai 7.0.93 / `6359fd58fe68eaade096b5d923bac26de84ca3bd`, Apache-2.0 | [Release](https://github.com/vercel/ai/releases/tag/ai%407.0.93), [generation source](https://github.com/vercel/ai/blob/6359fd58fe68eaade096b5d923bac26de84ca3bd/packages/ai/src/generate-text/generate-text.ts), [tests](https://github.com/vercel/ai/blob/6359fd58fe68eaade096b5d923bac26de84ca3bd/packages/ai/src/generate-text/generate-text.test.ts), [license](https://github.com/vercel/ai/blob/6359fd58fe68eaade096b5d923bac26de84ca3bd/LICENSE). `result.sources` aggregates model step sources; tests cover source aggregation and abort during tools. Open [#9254](https://github.com/vercel/ai/issues/9254) distinguishes sources from citations; open [#10219](https://github.com/vercel/ai/issues/10219) requests source emission from custom tools. Neither issue establishes an OpenBot defect by itself. | Keep the released tool/message loop; model/provider sources cannot establish Server-authorized local file identity or exact returned ranges. |
| Existing storage and digest adapters | Node crypto, write-file-atomic 8.0.0 (ISC), reviewed [attachment](channel-attachments.md) and [report](agent-research-artifacts.md) adapters | Existing digest reads, atomic publication, paged UTF-8 text and byte-only model parts are already tested. | First viable thin adapter. Record facts only after successful authorized reads, with no dependency or new storage protocol. |

## Reuse decision

The missing application fact is which immutable attachment bytes and text ranges the Server
delivered to the current Run. Keep a bounded Run-owned collector across final-answer continuations.
Only a successful text read or prepared binary model part can add evidence; task markers alone
cannot. Retain original SHA-256, and hash the actual decoded/extracted text separately. Original
document hashes do not identify OCR/extraction output. Merge overlapping UTF-16 half-open ranges
for the same text version; preserve extraction truncation separately from read coverage. Reject
mixing changed text versions under one attachment identity during a Run instead of falsely joining
their coverage. Binary input is labelled supplied to the model, never independently read/verified.

Append an input-evidence section when finalizing existing Markdown reports and store the same
bounded metadata alongside their current web provenance. Authored report text stays untouched in
continuation state so the appendix is generated once. Preserve the 32 KiB final-report bound,
8-attachment authority bound, current read/tool budgets, task cancellation and atomic publication.
Do not persist raw attachment content in metadata or claim per-sentence citation verification.
This metadata can later map to a standard provenance export; no public contract or database
migration is needed for the existing opaque artifact metadata.

## Source incorporation

No source copied or substantially adapted. Existing dependency notices remain. No new package.

## Verification plan

- Real Owner upload/task/report download with production PostgreSQL, attachment/artifact storage
  and deterministic SDK model; assert body, hashes, metadata and no inclusion of unread files.
- Paged overlap/gaps, UTF-16/non-ASCII boundaries, partial and truncated extraction, changed
  extraction, binary labelling, denied reads and unchanged authority rejection.
- Final-answer continuation keeps one appendix and cumulative coverage; failed/cancelled work
  cannot publish an artifact. Run focused tests, headless acceptance and `npm run check`.
- Update Native Agent documentation in English/Chinese. Evidence does not establish model
  correctness, code execution, a tested patch workflow, or real paid-provider binary understanding.

## Unresolved questions

F1b code execution needs its own sandbox/Provider and policy research. General document outputs,
source-to-claim verification and externally exported provenance remain separate packages.
