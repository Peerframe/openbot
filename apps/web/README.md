# Shared OpenBot client

[Repository map](../../docs/REPOSITORY_MAP.md)

This React client is used by both Web and Electron Desktop. `App.tsx` coordinates navigation and authenticated workspace state. Feature components render controlled data and call Server APIs; they do not grant tools, choose authorization or read provider credentials.

`api.ts` is the HTTP/SSE boundary. `conversation-session.ts` owns per-channel draft/send continuity; `run-output-state.ts` projects transient streamed output. `ChannelWorkspace.tsx` composes the transcript/composer; independent message actions, reactions, attachments and plugin panels live in `components`.

Run `npm run dev:web` from the repository root after starting the documented Server. Use `npm run test --workspace @openbot/web` for component/state tests and root `npm run typecheck` for dependency-ordered checks. A UI change also needs actual rendered interaction at wide and narrow widths; JSDOM tests cannot prove pixel layout, focus behavior in Electron or platform media permissions.

Reuse component styles, the tokens in `tokens.css` and the primitives in `primitives.css`. Global stylesheets are listed once, in cascade order, in `global-styles.ts`; avoid adding another generation of global overrides.

**Design preview.** `npm run design:preview -w @openbot/web` serves `preview.html` on http://127.0.0.1:5179. It renders the real UI on synthetic data for side-by-side comparison with the canvas artboards (`?scene=channel`, `profile`, `new`, `launch` …). It is dev only: no build step, `connect-src 'none'`, and the transport in `src/preview` fails closed. It is not evidence of backend behaviour. The renderer may call only the declared Desktop bridge; native permissions and lifecycle belong in `apps/desktop`. Plugin app content stays behind the existing sandbox/host protocol.
