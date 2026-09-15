# Research: Vite 8.3 lockfile coherence

[English](vite-8.3-lock-coherence.md) · [简体中文](vite-8.3-lock-coherence.zh-CN.md)

- Status: Reviewed before lockfile repair; complete CI required before merge
- Date: 2026-09-15
- Related PR: #77
- Acceptance journey: A clean checkout resolves the Vite configuration and React plugin against the same published Vite types and passes the existing build, development-CSP and sandbox tests.
- Security boundary: Development dependency maintenance only. Preserve strict TypeScript, response-specific CSP nonces, Desktop policy and plugin isolation.

## Evidence

[Original CI](https://github.com/Peerframe/openbot/actions/runs/34935951572) fails on all three platforms with TS2321 and TS2769 at vite.config.ts:49. A clean local install reproduces both errors. Node resolution confirms the configuration loads apps/web/node_modules/vite 8.3.0 while the root React plugin loads node_modules/vite 8.2.2. Their recursive Plugin/PluginOption types are compared across versions. The lockfile also retains a ranged workspace declaration where package.json pins 8.3.0.

Checked the existing [reuse ledger](../OPEN_SOURCE_REUSE.md) and [Vite CSP research](web-dev-csp-nonce.md); the official Vite 8.3.0 release, tag and plugin.ts source; npm 10.9.9 dedupe documentation; and installed peer ranges. The query `repo:vitejs/vite is:issue 8.3 stack depth` returned no matches. This does not prove the absence of upstream issues.

## Candidate comparison

| Candidate | Exact version / commit | License | Fit and decision |
| --- | --- | --- | --- |
| Existing Vite release | 8.3.0 / 434e8e9495436a60789f2b588a04a6a24a3d1661 | MIT | Select one shared resolution; Node floor ^20.19.0 or >=22.12.0 fits CI |
| Existing npm resolver | 10.9.9 | Artistic-2.0 | Reuse package manager resolution, then inspect the complete diff |
| Local casts, disabled strict checking or plugin fork | None | No source incorporated | Reject; these would conceal the inconsistent dependency graph |

plugin-react 6.1.1 accepts ^8.0.0; vitest 5.0.0 and its mocker accept Vite 8. One shared 8.3.0 satisfies all consumers without a new override or dependency. The official release includes preload/proxy performance and path/code-frame fixes. Existing integration suites, not release notes alone, determine compatibility.

## Implementation and verification

npm 10.9.9 update/dedupe encounters an Arborist null edgesOut error while rebuilding optional Vitest peers. Normalize the already-locked Vite 8.3.0 and PostCSS 8.5.28 records at the root, preserving their published URLs and integrity hashes, then validate the full lock with npm 10.9.9 install --package-lock-only and a clean npm ci. Keep unrelated package versions and lock metadata stable, remove the nested Vite copy and synchronize the workspace's exact declaration. No application code or configuration behavior changes are needed. Revert the complete upgrade if verification fails.

Verify installed paths from both the web package and React plugin, clean installation, strict typecheck, full `npm run check`, and the existing real Vite nonce/concurrency and production/Desktop build checks. Current-head hosted Linux, macOS and Windows checks remain required; no new platform support is claimed.

No source copied or substantially adapted. Preserve Vite's MIT license and existing dependency notices.

## Primary sources

- [Vite release](https://github.com/vitejs/vite/releases/tag/v8.3.0)
- [Pinned plugin types](https://github.com/vitejs/vite/blob/434e8e9495436a60789f2b588a04a6a24a3d1661/packages/vite/src/node/plugin.ts)
- [npm 10.9.9 dedupe contract](https://github.com/npm/cli/blob/v10.9.9/docs/lib/content/commands/npm-dedupe.md)
