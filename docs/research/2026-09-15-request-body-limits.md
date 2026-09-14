# Research: bound JSON input while reading

[English](2026-09-15-request-body-limits.md) · [简体中文](2026-09-15-request-body-limits.zh-CN.md)

- Status: Accepted for implementation
- Date: 2026-09-15
- Owner: OpenBot maintainers
- Acceptance journey: an oversized streamed login request is rejected before authentication and
  before the remaining body is read; normal login and larger Employee packages still work.
- Security boundary: the Server sets each route's byte limit. Client length headers do not grant
  permission to consume additional input. Existing authorization, status codes and limits remain.

## Search evidence

- Search date: 2026-09-15.
- GitHub queries: `repo:honojs/hono body-limit`, `repo:honojs/node-server body-limit`;
  inspected the pinned middleware, its tests, MIT license, release and current open body/stream
  issues. Reviewed [node-server #327](https://github.com/honojs/node-server/issues/327), which
  documents transport reset behavior during early rejection, and the fixed
  [chunked-body advisory](https://github.com/honojs/hono/security/advisories/GHSA-9vqf-7f2p-gf9v).
- Primary documentation: [Hono body limit](https://hono.dev/docs/middleware/builtin/body-limit),
  [WHATWG Streams snapshot](https://streams.spec.whatwg.org/commit-snapshots/b9ba9f49d95b4280be0dc2372377a006c3a91c18/)
  (reader read/cancel/release semantics), and [RFC 9110 section 8.6](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6)
  (content length counts octets).
- Existing coverage: the Browser control-plane security and Employee export/import entries in
  `docs/OPEN_SOURCE_REUSE.md`; `app.ts` common JSON and Employee package readers; existing bounded
  readers in attachment routes and model metadata. The latter have route-specific errors and
  await cancellation, so they are not reused unchanged for a public rejection path.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| WHATWG Streams reader and native `TextDecoder` | Streams `b9ba9f49d95b4280be0dc2372377a006c3a91c18`; existing supported Node runtime | WHATWG standard terms; Node.js license | Standard links to web-platform-tests; built into supported Node versions | Read bytes before decoding, preserve split UTF-8/BOM behavior, cancel the unused remainder and release the lock | Adopt the standard with a narrow route-policy adapter |
| Existing Hono `bodyLimit` | [4.13.7 / `eebdf7be39abf0a872671835ccce0c4f03ea497a`](https://github.com/honojs/hono/tree/eebdf7be39abf0a872671835ccce0c4f03ea497a/src/middleware/body-limit) | MIT | Released dependency; tests cover chunked input, conflicting length headers and handler bypasses | The inspected version trusts a lone `Content-Length`; its overflow branch does not cancel or release the reader. Middleware also needs route registration and normally returns 413 | Retain existing uses; not sufficient unchanged for this parser's byte and cleanup contract |

## Reuse decision

- Selected option: open standard, with a thin application adapter; no dependency or fork.
- Selected upstream: the WHATWG reader lifecycle and native streaming UTF-8 decoder.
- First viable option: standard primitives provide the required control without copying a
  framework implementation or introducing another parser dependency.
- Exact local gap: centralize only the existing JSON readers' route-specific byte limit and
  `RequestValidationError` mapping. Count each raw chunk before decoding, stop at the first chunk
  over the cap, and use declared length only for early rejection. Initiate cancellation without
  awaiting an untrusted source's completion promise; release the reader in all cases.
- Preserve the 64 KiB default, smaller explicit overrides, 2 MiB Employee preview limit and
  2 MiB + 64 KiB activation limit. Multipart and raw attachments keep their own contracts.
- Upgrade/exit: reevaluate Hono's public API when its header and cancellation behavior satisfies
  this contract; retain route-entry regression tests during any replacement.
- Failure behavior: oversized input keeps the existing 422 error; malformed or failed common JSON
  reads keep the validation error and never reach authentication/storage. This bounds application
  consumption, not bytes already buffered by an HTTP transport or the duration of a slow request.

## Source incorporation

- Source copied or substantially adapted: no.
- Files: `apps/server/src/app.ts` and its route tests use standard public APIs.
- Required additional notices: none; the existing Hono dependency retains its own MIT notice.

## Verification plan

- Exercise `createApp` login with absent, understated and oversized length headers; check reads,
  cancellation, released locks, unchanged errors and absence of login calls on overflow.
- Exercise exact byte boundaries, a BOM and split multibyte UTF-8, malformed JSON, failed reads,
  and cancellation that rejects or never settles.
- Exercise a smaller explicit route limit, valid Employee preview/activation above 64 KiB, and
  streamed Employee overflow. Use bounded synthetic fixtures without credentials or databases.
- Run focused Server route tests and the required repository check. No new platform support claim.
- This English record and its Chinese translation describe the same scope and limitations.

## Unresolved questions

- HTTP transport behavior during early rejection remains adapter-dependent; a client can see a
  connection close while it is still transmitting. Do not describe application-level tests as a
  network-level denial-of-service guarantee.
