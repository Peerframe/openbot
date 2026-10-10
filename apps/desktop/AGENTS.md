# Desktop contributor rules

The renderer shares Web components; read `apps/web/AGENTS.md` when changing them. Keep main/preload
bridges narrow and typed, validate trusted frames, and keep credentials out of the renderer.
`ts-server.ts` supervises the explicit single-TypeScript product candidate, selected by the exact
v10 resource marker. It owns one Server process and preserves the existing profile and database
paths. The candidate includes Node parser helpers. The default packaging path still uses
`native-server.ts` and Python until the retirement/default-switch approval is resolved.
Full macOS arm64 `--ts-product` packaging keeps the canonical identity and requires the validated
existing Worker companion. Separate Previews refuse that production companion. Keep candidates
uninstalled and use disposable startup profiles unless installation/registration is authorized.
Standalone Node remains a pending target decision: Electron utility-process permission qualification
failed. Do not describe that fallback or Python retirement as an accepted completed migration.
Tests cover host lifecycle and bridge behavior; packaging/start/stop on the affected target OS is
separate evidence. Use [the repository map](../../docs/REPOSITORY_MAP.md) and the existing Desktop
scripts. Do not infer Windows/Intel Mac local runtime support from macOS arm64 evidence or remote
service connectivity. Preserve user profiles, installed applications and complete rollback sets.
