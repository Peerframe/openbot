# Desktop attachment upload proxy exception

- Status: accepted; 2026-09-11.
- Existing reuse entry: Desktop Server connection in `OPEN_SOURCE_REUSE.md`,
  [desktop-server-connection.md](desktop-server-connection.md), and
  [ADR-0042](../decisions/0042-desktop-server-connection.md).
- Observed gap: the main-process proxy forwarded only `accept`, `content-type`, `if-match`, and
  `last-event-id`, and capped bodies at 3 MiB. The renderer POSTs channel attachments as
  `application/octet-stream` with `X-OpenBot-Filename` (percent-encoded, including Chinese names).
  The Server route requires that header. The proxy stripped it, so Desktop uploads failed with
  "Missing attachment filename". Bodies between 3 MiB and the Server task attachment budget were
  also dropped.

## Evidence and decision

Reviewed 2026-09-11. Reuse the existing Electron **44.2.0** `protocol.handle` plus `Session.fetch`
adapter from ADR-0042. The Electron docs host may 409; this note relies on the pinned 44.2.0
Session.fetch pattern and the 2026-09-04 Origin-rewrite experiment already recorded in
desktop-server-connection.md. No new runtime dependency.

Local and GitHub queries: `x-openbot-filename`, `forwardedRequestHeaders`,
`MAX_TASK_ATTACHMENT_BYTES`, `electron v44.2.0 session.fetch protocol.handle`. Inspected
`apps/web/src/composer-context.ts` (sends `encodeURIComponent(file.name)`),
`apps/server/src/channel-attachment-routes.ts`, and
`apps/server/src/channel-attachments.ts` (`MAX_TASK_ATTACHMENT_BYTES = 20 * 1024 * 1024`).

The first viable option is a route-scoped exception inside the existing proxy. A generic custom
header allowlist, multipart parser, IPC upload channel, or global 20 MiB body cap would widen the
already-reviewed Session.fetch adapter without closing this OpenBot-specific gap.

- Match only `POST /api/v1/channels/:channelId/attachments` with one path segment (`[^/]+`), the
  same style as the existing channel-events regex. Nested `cleanup`, `process`, `restore`, and
  attachment-id routes keep the default 3 MiB allowlist and do not receive `x-openbot-filename`.
- On that route only, forward `x-openbot-filename` in addition to the four existing request
  headers. `forbiddenCredentialHeaders` stay rejected. Arbitrary custom headers, including
  `X-Renderer-Secret`, stay dropped.
- On that route only, raise the body cap to 20 MiB, mirroring Server `MAX_TASK_ATTACHMENT_BYTES`.
  Other routes keep `MAXIMUM_DESKTOP_PROXY_REQUEST_BYTES` (3 MiB). The Server remains
  authoritative for type, filename, and storage policy.
- No copied upstream source. No new `OPEN_SOURCE_REUSE.md` ledger row: this is an OpenBot-specific
  gap in the already-reviewed Desktop Server connection adapter.

## Verification

Proxy tests cover filename plus binary forwarding including a 0-byte body; the percent-encoded
Chinese filename the renderer sends; bodies above 3 MiB and within 20 MiB on the upload route;
413 without fetch above 20 MiB; unrelated POSTs still 413 above 3 MiB and do not forward
`x-openbot-filename`; Authorization still rejected on the upload route. Run `npm run check`.
