# Web contributor rules

The Server owns persisted state and authorization. Components project it through `api.ts`,
`work-api.ts` and workspace hooks; never infer success from a closed request or UI state.
Read the [design index](../../docs/design/README.md) and the
[UI route](../../docs/REPOSITORY_MAP.md#ui-interaction). Reuse the `--ob-*` tokens in `src/tokens.css`, the
shared primitives in `src/primitives.css` (pills, segmented control, `Dialog` frame) and nearby
component/CSS/test patterns; avoid a new global styling system. Compare rendered screens with their
artboard in the design preview (`npm run design:preview -w @openbot/web`, synthetic data only). Check keyboard/focus, wide/narrow,
loading, failure and stale/offline states for affected interactions. Keep Electron APIs behind the
existing typed bridge; read `apps/desktop/AGENTS.md` for main/preload changes.

Run focused Vitest from the root, after shared builds where needed; see the route for exact commands.
Rendering evidence must use the actual page. Fixtures and screenshots alone do not establish backend
execution or supported platform behavior.
