# Desktop contributor rules

The renderer shares Web components; read `apps/web/AGENTS.md` when changing them. Keep main/preload
bridges narrow and typed, validate trusted frames, and keep credentials out of the renderer.
`native-server.ts` supervises the Python product payload; Node parser helpers remain required.
Tests cover host lifecycle and bridge behavior; packaging/start/stop on the affected target OS is
separate evidence. Use [the repository map](../../docs/REPOSITORY_MAP.md) and the existing Desktop
scripts. Do not infer Windows/Intel Mac local Python support from macOS arm64 results or from remote
service connectivity. Preserve user profiles and installed applications.
