# Desktop contributor rules

The renderer shares Web components; read `apps/web/AGENTS.md` when changing them. Keep main/preload
bridges narrow and typed, validate trusted frames, and keep credentials out of the renderer.
`native-server.ts` supervises the Python product payload; Node parser helpers remain required.
The strict TS resource marker selects the P2 Python/TS pair; Python remains the issuer/background owner and default operation writer. Explicit v2 resources
select the bounded TS primary-Bot manual PUT; identity lifecycle updates stay in Python. Use the separate TS Preview identity for API-only coexistence qualification;
it refuses the production Worker companion. Full macOS arm64 `--ts-product` packaging keeps the
canonical identity and requires the validated existing companion. Keep full candidates uninstalled
and use disposable startup profiles unless the task explicitly authorizes installation/registration.
Tests cover host lifecycle and bridge behavior; packaging/start/stop on the affected target OS is
separate evidence. Use [the repository map](../../docs/REPOSITORY_MAP.md) and the existing Desktop
scripts. Do not infer Windows/Intel Mac local Python support from macOS arm64 results or from remote
service connectivity. Preserve user profiles and installed applications.
