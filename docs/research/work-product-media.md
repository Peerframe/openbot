# Research: retained Work media inputs

- Status: approved and implemented in the isolated packet; root composition/Temporal media qualification pending.
- Date: 2026-09-25.
- Acceptance: preserve explicitly attached unprocessed PNG/JPEG/PDF as actual model input without
  putting raw bytes in Workflow history or weakening Server authority/recovery.
- Boundary: only immutable source-Run refs, current file/data authority, actual admitted model
  Activity, no provider URL download/upload and no new SDK, Agent or executor.

## Existing decisions and primary evidence

Read actual retained `apps/server/src/agent-attachments.ts`, native-agent.ts and
agent-runtime-host.ts; current ProductWorkReads, OwnerFiles/AttachmentProcessingService,
ProductWorkModel, model_request/ModelReceipts, ProductModelPort/ModelConnectionPort,
ProductWorkResultVerifier and product Runtime composition. Read reuse-ledger entries for channel
attachments, empty extraction, Python model services, durable model observations and tool results.
Reused their exact release/license/security decisions rather than initiating a dependency upgrade.

Searches: GitHub `pydantic/pydantic-ai BinaryContent PDF input issue OpenAI Anthropic`, official
Pydantic multimodal input, OpenAI file inputs and Claude PDF support. Opened these primary sources:

- [Pydantic AI multimodal input](https://pydantic.dev/docs/ai/core-concepts/input/): local bytes via
  BinaryContent; URL objects have separate provider/local download behavior and are excluded here.
- [OpenAI file inputs](https://developers.openai.com/api/docs/guides/file-inputs): inline base64 PDF
  is supported by Responses and Chat; not all models can interpret PDF visuals. Other document
  types advertised by current Responses are NOT automatically added to OpenBot's retained allowlist.
- [Claude PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support): current
  request-size/page/context/encryption limits remain provider constraints; OpenBot's 20-MiB raw cap
  is not a guarantee every PDF is accepted.
- [Pydantic issue #1161](https://github.com/pydantic/pydantic-ai/issues/1161): historical unsupported
  MIME behavior; reinforces that byte serialization is not universal format/model support.
- [Pydantic 2.47.0 release](https://github.com/pydantic/pydantic-ai/releases/tag/v2.47.0): confirms
  `77d5fce`, including strict UserPromptPart content validation. The exact installed release's
  OpenAI and Anthropic BinaryContent converter branches and public BinaryContent fields were read.

Direct fresh GitHub/raw URLs for the exact pinned upstream tests returned cache misses. The
previous accepted source/test reviews remain the basis for that release; do not claim a new full
upstream test/security audit. A local exact-release three-protocol probe supplies the added behavior
measurement instead. No remote issue attachment, image, user file or upstream implementation was copied.

## Candidate comparison

| Candidate | Exact pin / license | Actual fit and decision |
| --- | --- | --- |
| Pydantic AI BinaryContent + existing model SDKs | 2.47.0 / `77d5fce751ab8ab04bd5db4ed6acc1131a4baed6`, MIT | First viable released API. Local bytes encode into all three existing protocols. Tiny name/title adaptation needed for TS fidelity. |
| OpenAI Python SDK | 3.17.0 / `8c72a700d900fb2578227df564a54462abfe67f8`, Apache-2.0 | Existing fixed explicit credential/endpoint/no-retry clients retained; no Files API. |
| Anthropic Python SDK | 1.8.0 / `4421d56a4dd23550c7097c9b7ab5668bd11e09c4`, MIT | Existing Messages client/base64 conversion retained; no new client or beta upload capability. |
| Existing explicit processing | PDF.js6.3.289 / `1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56`, Apache-2.0; Tesseract.js7.0.0 / `42eae669e4b3a66429d8516f078912cc747a89df`, Apache-2.0 | Retain for Owner-selected extraction/OCR. Does not fully substitute for visual image interpretation or scanned PDF. |
| New OCR/parser/tokenizer/framework | None selected | Adds cost and changes material sent/read; cannot provide full visual fidelity or accurate generic provider token cost. |

Select the existing SDK plus a narrow Server adapter. The precise local gap is retaining private
scoped binary evidence beyond a text-only Runtime request, not encoding another HTTP protocol.
No dependency or lockfile change is proposed, and no upstream source is copied/adapted. Existing
notices remain applicable. Upgrade requires rerunning protocol/name/size differential fixtures.

## Why explicit processing is not a full replacement

Current Owner processing supports PDF/Office extraction, raster image OCR and configured audio
transcription. Existing PDF extraction obtains text items, not OCR; the accepted empty-extraction
review explicitly excludes scanned-PDF OCR and forbids silent binary fallback for an already
processed empty record. Raster OCR yields text but loses chart structure, layout and non-text
visual meaning. Making that mandatory would remove retained image/PDF functionality and add an
unrequested processing step. Keep the two paths explicit: valid processed text pages, or eligible
unprocessed direct binary. A model rejecting binary is a visible failure, not permission to switch.

## Measured SDK probe

`probes/sdk_binary_probe.py` calls only the already installed SDK behind current production's
text-only boundary. Each protocol uses httpx2.MockTransport and one synthetic response. It asserts
that decoded PNG, JPEG and PDF bytes equal the authored probe inputs; no network request, account,
real credential, parser or meaningful document is involved.

| Protocol | Wire parts | Decoded byte lengths | Requests | Filename/title behavior |
| --- | --- | --- | --- | --- |
| responses-v1 | input_text, input_image, input_image, input_file | 30,27,37 | 1 | filename.pdf |
| chat-completions-v1 | text, image_url, image_url, file | 30,27,37 | 1 | filename.pdf |
| anthropic-messages-v1 | text, image, image, document | 30,27,37 | 1 | document title absent |

Retained installed TS AI SDK converters use original filename for OpenAI and document title for
Anthropic. Therefore direct SDK reuse alone is not exact metadata parity. The implementation now contains the narrow shared metadata adapter; its three-protocol
retained TS differential gate passed (see implementation evidence below).
The small authored probe is encoding evidence, not a valid real-provider media acceptance test.

## Budget evidence

Retained agent-runtime-host.ts checks eight model steps and accumulated reported input/output
usage (64000/5120 thresholds) before the next call. It has no image/PDF preflight token estimator.
The root-approved candidate policy is an explicit host allowance of 8192 input tokens per binary
attachment plus current text/output reservation, bounded by Task balance; actual usage remains the
same authoritative receipt settlement. This is not a tokenizer, inferred billing limit or base64
byte count presented as tokens. See DESIGN.md for failure behavior, limits and all affected files.


## Implementation evidence (2026-09-25)

Root approved the design and the packet implements the two narrow modules plus five existing
model/result seams. No upstream source, credential or user document was copied; test inputs are
authored synthetic media (a 1-pixel PNG, wire-only JPEG bytes and a minimal PDF object).

- `probes/retained_sdk_media.mjs` executes retained `ai.generateText` with `@ai-sdk/openai` 4.0.66
  and `@ai-sdk/anthropic` 4.0.53 using a synthetic fetch function. The captured request projection
  is frozen at `tests/fixtures/retained_media_wire.json`. Current TS emits deprecation warnings
  for its retained image-part form; this is not a protocol failure or a dependency change.
- Python tests execute the pinned production SDK ports over httpx2.MockTransport and compare
  ordered media MIME, base64 original bytes and original Chinese filename/title against all
  three TS projections. No provider URL, upload endpoint, account or real key is used.
- Two 10-MiB synthetic PDFs exercise the full retained 20-MiB aggregate in all three protocols;
  encoded request bodies exceed the unchanged 512-KiB ordinary limit and remain below the
  trusted per-request closed formula (under 30 MiB). This measures bounded encoding, not a
  live provider's parsing, page/context limits, latency or document understanding.
- Real disposable PostgreSQL, current canonical migrations, OwnerFiles, SDK Activity/history
  facts seam, Action admission, ModelReceipts and independent reviewer cover all three protocols,
  recovery without hydration/send, before/after revocation, metadata/raw-byte changes, removal,
  cancelled Task, source mutation, native no-ref/forged-ref scope, original-generation/fence
  refusal, full Owner corrections, manifest conflict, empty extraction, budget and reviewer
  media equality. No test claims actual Temporal media replay; root owns that integration.
- The focused run passed 163 tests (39 new media cases plus 124 existing product-model cases).
  The current existing result suite passed 44 tests, including root's approved MCP-observation
  distinction. Two additional correction/manifest cases passed afterwards. The three differential
  projection cases were rerun after adding their retained TS assertion; all passed. Total unique
  passing cases: 209.

The short scopes release the OwnerFiles lock before model HTTP. SQL admission checks source and
anchored descriptor only; hydration and send gates perform full original/derived-byte checks.
Actual configuration/fence validation remains the last transaction after awaited data gates.
Historical receipts do not renew authority; Runtime must check media before and after consuming
recovered output.

# Product media journey scope

2026-09-25. Reuse the accepted `docs/research/work-product-media.md` and
`python-product-runtime.md` reviews: PydanticAI 2.47.0, Temporal Python 1.33.0,
OpenAI Python 3.17.0, current PostgreSQL/HTTP/OwnerFiles adapters. No new dependency,
protocol, framework, parser, model account or upstream source is incorporated.

The existing real product-runtime journey and owned PostgresServer lifecycle are imported
from the caller-selected checkout, not copied. New scripts select one existing protocol,
OpenAI Responses, behind an injected httpx2.MockTransport. The actual serve entry, Owner HTTP
upload/submission, SQL authority, Workflow, Worker, producer and independent reviewer stay
unchanged. Tests assert exact original bytes and names at the final SDK wire boundary.

PNG/PDF samples are authored synthetic fixtures made with Python standard-library encoding;
they are not private documents or generated screenshots. This qualification does not claim
live-provider document understanding, all model protocols, OCR, processing, or paid-model
compatibility. Existing three-protocol unit/differential evidence remains separate.

Acceptance: completed product Task/report; both producer and reviewer receive the two exact
original media blobs; engine history contains bounded manifests but no raw/encoded media or
key in decoded Payload data; offline replay of that actual original history succeeds. Owned
Compose project/processes and generated SQL entities must be cleaned on success or failure.
