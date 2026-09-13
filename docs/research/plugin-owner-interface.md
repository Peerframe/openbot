# Research: Owner interface for MCP tool plugins

- Status: Accepted for implementation
- Date: 2026-09-10
- Owner: OpenBot contributors
- Acceptance journey: Owner inspects an exact tool declaration, installs it disabled, grants tools to a Bot, and sees the precise pending external call before deciding.
- Security boundary: Renderer displays escaped text and calls fixed authenticated management APIs. It does not load plugin JavaScript/HTML, infer authority from annotations, or call plugin endpoints directly.

## Search evidence

- Reviewed [MCP tools specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) and its approval/annotation trust model.
- Reused the release, GitHub source, tests, issues and security review in [third-party plugin research](third-party-mcp-plugins.md): official SDK 1.30.0 at `2d889f2b329e46680ec9bdd565de4616c497825a`, MCP 2025-11-25 compatibility line.
- UI standards and existing React 19.2.8 review: [collaboration presentation research](channel-collaboration-presentation.md). Native form/select/details controls are the first viable implementation; no additional UI package is needed.
- Existing workspace skill-gallery and native modal/form reuse entries were checked. Tools are deliberately a separate panel from SKILL.md and employee packages.
- Search date for Bot-selection preservation (F05, 2026-09-13): official React docs [Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state) and [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect); GitHub pin `facebook/react` / `react` **19.2.8** at commit `1dd4ecbdabf826f527fc9a58c05ea70375b7d170` (MIT). No new UI dependency candidate was required.
- Honesty note: the first pull-request revision for the grant Bot-selection fix omitted this research extension and the Open-source research PR fields; this record and the PR body were completed in the follow-up revision before re-review.
- Follow-up (2026-09-13, same PR #64): live Owner GUI on tip `bef3243` still reproduced sticky Bot jump after second-Bot save (`index-B_JDBK9F.js`), and independent React cases showed `selectionRef` tracking only `{botId, revision}` left “已保存” sticky across availability / cleared-grant sync. This follow-up binds success feedback to Bot + availability + authoritative grant snapshot, keeps PluginManager mounted after first open with a per-plugin selection map, awaits post-mutation GET before resolving save, and covers cases A/B/C plus PluginManagerPanel keep-alive regression. No new dependency; no backend/auth-model/release version changes.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Native form/disclosure and existing React | React **19.2.8** / commit `1dd4ecbdabf826f527fc9a58c05ea70375b7d170`; WAI-ARIA 1.2, 2023-06-06 | MIT; W3C document terms | Existing repository component tests and browser support; official preserving-state and effect guidance reviewed for grant editor identity | Escaped descriptions/JSON, explicit checkboxes and per-tool permission selects; stable `key={plugin.id}`, details keep-alive, and per-plugin Bot selection map preserve sticky Bot; “已保存” bound to Bot + grant-authority snapshot | Select standard and existing renderer |
| Plugin-rendered embedded UI | Not adopted | Not applicable | Not required for this task | Would widen renderer execution and trust boundaries | Exclude |

## Reuse decision

- Thin presentation adapter over Server-owned plugin API; no protocol implementation in the renderer.
- Name, endpoint or token edits invalidate preview and review. Installation uses the exact reviewed digest and starts disabled.
- Every tool starts ungranted. Owner explicitly chooses per-call confirmation or ongoing read permission; readOnlyHint never preselects permission.
- Approval views show Bot, endpoint, tool, full JSON arguments and expiration. Missing endpoint, expired record or failed refresh disables decisions. A visible channel polls every two seconds without overlapping reads; hidden/closed views stop or pause.
- User-facing error text does not echo secret or untrusted server payloads. API credentials and pending arguments are not put in URLs or localStorage.
- Unknown completion is surfaced, never automatically retried as a write.
- Grant editor Bot selection (F05): do **not** key `PluginGrantEditor` on `plugin.revision`. A revision bump after grant PUT must preserve the Owner's sticky Bot and draft per [preserving and resetting state](https://react.dev/learn/preserving-and-resetting-state) (same component position / stable plugin id key). Keep `PluginManager` mounted after the first `<details>` open (hide when collapsed) and persist the Owner's Bot id per `plugin.id` in an SPA-session Map so details toggles, editor remounts, or leaving/re-entering Skills cannot fall back to `bots[0]`. Sync the grant draft only when the selected Bot or the plugin grant revision actually changes; same-revision parent re-renders must keep dirty drafts. Prefer adjusting that draft during render (or a narrowly keyed sync) rather than an Effect that resets on every new `plugin` object identity, per [you might not need an Effect](https://react.dev/learn/you-might-not-need-an-effect). Bind the visible “已保存” status to the current Bot **and** an authoritative authorization snapshot (availability + enabled/grants identity), not only `botId`+`revision`: confirm pending writes against the post-mutation GET snapshot so normal save success remains visible, while cleared grants / lost Bot availability invalidate “已保存” (cases A/B/C). Await the post-mutation plugin GET inside the parent mutate path before resolving `onSave` so the editor binds to the authoritative snapshot. Late `.then()` success also requires the pending write to still be live and, when revision has advanced, the live grant signature to match the submitted write — so a cleared-authority snapshot delivered while PUT is in flight cannot resurrect “已保存”.
- No permission-model, backend grant semantics, or release version changes in this slice.

## Source incorporation

- No upstream source copied or substantially adapted. Existing React and stylesheet conventions reused; no new frontend dependency.
- React remains the exact-pinned runtime **19.2.8** (`1dd4ecbdabf826f527fc9a58c05ea70375b7d170`, MIT). Official learn docs were cited for key/state guidance only; no React source was copied.

## Verification plan

- Preview invalidation on edits; reviewed digest submitted exactly; no automatic grants from annotations.
- Reject/approve payload binding; expired and unavailable calls disabled; own-channel filtering; escaped hostile descriptions/arguments.
- Desktop and narrow viewport synthetic preview; no claim of full third-party service or all-platform certification.
- English/Chinese operational documentation coordinated with backend plugin delivery.
- Grant Bot selection: unit coverage for sticky Bot after revision bump, missing-Bot unavailable state, dropped grant targets, same-revision dirty-draft retention, late-async “已保存” binding, cases A/B/C/D (cleared auth snapshot / bots=[] after success / bots=[] while save pending / cleared auth while save pending then resolve), and normal save reload keeping “已保存”; PluginManager GET → delayed PUT → revision GET regression (second Bot, path/payload, pending disabled, same Bot after save; fail and uninstall); PluginManagerPanel details keep-alive + selection map regression.
- `npm run check` on the fix branch; no new dependencies.

## Unresolved questions

- Public marketplace, OAuth and plugin-rendered resources remain outside this slice.

## Rendered verification on 2026-09-10

Using the synthetic Vite/Chrome setup documented in the collaboration presentation review, 1280 × 900 and 390 × 844 previews showed the installed plugin, add form and permission controls. Opening “Add tool plugin” exposed the connection form. The narrow approval view showed the exact endpoint and full test arguments; choosing “Reject” removed that pending call. No relevant console/page errors or horizontal document overflow occurred. This verifies the renderer and mocked API interaction only; real transport, persistence and authorization are covered by the backend tests. Screenshots remain outside the repository and contain only synthetic data.
