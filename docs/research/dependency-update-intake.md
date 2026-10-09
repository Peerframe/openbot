# Research: Reviewed dependency update intake

- Status: Reviewed before configuration changes
- Date: 2026-09-15
- Owner: OpenBot maintainers
- Related PRs: #79, #80, #81, #82, #83
- Acceptance journey: Resolve the five existing dependency proposals with real research and complete CI; stop unsolicited ordinary version proposals while keeping security updates available.
- Security boundary: No research exemption, automatic approval, privileged PR execution, disabled test, or branch-protection bypass. Security updates still require review and all checks.

## Search evidence

Reviewed the existing research gate, contributor guide, reuse ledger and `.github/dependabot.yml` at main `87987d9d3b47238cf2b1d23fb5e03557d78938ab`. All five PRs fail `validate` because their generated bodies omit `Open-source research`; the other eight jobs pass and the final aggregate correctly fails. Main CI passes. The configuration change in #78 triggered npm, Docker and Actions update scans at 12:31:21 UTC, followed by five npm proposals.

Queries: `site:docs.github.com dependabot disable version updates open-pull-requests-limit 0 security`; official Dependabot pull-request concepts and options reference. The service documentation was reviewed on 2026-09-15; repository administration uses REST API version 2022-11-28. There is no vendored service release to pin.

## Candidate comparison

| Candidate | Exact contract | Fit | Decision |
| --- | --- | --- | --- |
| Official `open-pull-requests-limit: 0` | Dependabot configuration v2, reviewed 2026-09-15 | Disables ordinary version PR creation per ecosystem; security proposals are exempt | Select |
| Weekly schedule, groups or a limit of one | Existing service options | Reduces volume but keeps producing unreviewed proposals; configuration edits also cause immediate scans | Insufficient for the current intake gap |
| Skip research for bots or auto-fill approval claims | Local policy bypass | A generated release link cannot establish completed source, license, security and compatibility review | Reject |
| Remove dependency scanning/security updates | Service controls | Would suppress needed vulnerability signals | Reject |

## Reuse decision

Use the official zero limit for npm, GitHub Actions and Docker ordinary version updates. Keep ecosystem declarations, existing React grouping, default-branch targeting and Docker Node-major restrictions. Existing proposals remain open until individually reviewed or integrated with preserved history and full checks; do not close them merely to hide failures.

The reviewed intake is documented in CONTRIBUTING: select a bounded update batch, inspect exact releases and existing reuse records, record evidence before applying the bump, fill the seven PR research fields, validate clean installation and all current checks, then merge. Retain exact workspace declarations and package integrity. Re-enable ordinary automated proposals only after a maintained process can complete their research; warn that editing the configuration initiates an immediate scan and the PR limit is concurrent rather than per week.

Repository API inspection found vulnerability alerts and automated security fixes disabled. Enable those repository controls independently of the zero ordinary-update limit, and verify their state. Do not change secret-scanning settings or introduce a new workflow with write privileges. A security PR still needs evidence and CI; this change does not promise it will auto-merge or arrive pre-reviewed.

Both controls were subsequently enabled and the automated-security-fixes API returned `enabled: true`, `paused: false`. The initial alert inventory contains one existing development-only esbuild advisory, `GHSA-67mh-4wv8-2f99` (medium), already present in the previous dependency baseline. This intake change does not claim to resolve that advisory; production audit and the existing development-tool restrictions remain separate checks.

## Source incorporation and validation

No upstream source copied or substantially adapted; only official hosted-service options are reused. GitHub documentation terms apply. Verify all three zero limits, existing ignore/group semantics, enabled security controls, research-body validation and full `npm run check`. Require hosted checks on the integrated PR and merged main commit. No new platform or product authority is introduced.

## Primary sources

- [Dependabot trigger behavior](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-pull-requests)
- [PR limit and security exemption](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#open-pull-requests-limit)
- [Security-only update configuration](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-security-updates)

## Cleanup advisory review (2026-09-29, PR104)

The full npm audit at `8b5c4d3` reported five moderate package entries, not five independent
exploits: four entries propagate one esbuild advisory through Drizzle's installed legacy-loader dependency; one covers
three vulnerable undici installations. Production audit is clean, but that does not classify all
build/test use as safe. `npm explain`, lock entries and actual installed consumer source were read.

| Entry / installed consumer | Reachability and disposition |
| --- | --- |
| `esbuild`0.18.20 | [GHSA-67mh-4wv8-2f99](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99) exposes served source through permissive CORS, including loopback servers. The actual old-loader implementation invokes `transform`/`transformSync`, not `serve`; current Vite/tsx/oracle use0.28.2 and Drizzle's direct esbuild is0.25.12. The retained package graph still installs this instance; do not use its server API. Loopback alone is not mitigation. |
| `@esbuild-kit/core-utils`3.3.2 | Declares esbuild `~0.18.20`, calls its compiler transformations and reports the propagated advisory. Overriding it across the0.x compatibility boundary is not a proved fix. |
| `@esbuild-kit/esm-loader`2.6.5 | Imports core-utils, but installed Drizzle0.31.10 CLI/API source already uses tsx and does not import this legacy loader. It remains declared in the published dependency graph; no maintained OpenBot command exposes its server. Await an upstream manifest cleanup or separately verified CLI replacement, rather than hand-editing generated locks. |
| `drizzle-kit`0.31.10 | The retained `packages/db` migrate command loads reviewed config and canonical SQL; removing it based on static imports would break a real consumer. npm's proposed0.18.1 downgrade is a major compatibility reversal, not accepted remediation. SQL/history and public commands stay intact. |
| `undici`8.10.1 /7.29.0 | [GHSA-3wwx-pv8p-q78v](https://github.com/nodejs/undici/security/advisories/GHSA-3wwx-pv8p-q78v) can crash the process on a malformed over-limit compressed WebSocket frame. jsdom30.0.1 really exposes undici WebSocket to test pages; current tests use controlled inputs, which is a bounded exposure statement, not package safety. The two Electron get consumers use HTTP fetch/proxy dispatch rather than WebSocket. The product Node client imports the separate `ws` implementation. Select the compatible8.10.2 /7.29.1 patches within existing parent ranges, without new direct dependency or global override. |

Read the actual upstream inflater fix and malformed-frame regression at
[`4411a238a98e8791da5fff10cc9e3578a7668ed6`](https://github.com/nodejs/undici/commit/4411a238a98e8791da5fff10cc9e3578a7668ed6)
and its7.x counterpart
[`07c60d9c7099a910451244afe42861bbdbdd974c`](https://github.com/nodejs/undici/commit/07c60d9c7099a910451244afe42861bbdbdd974c).
The released8.10.2 source is `5e541e0b9df7563e5766bbd469fbfe383d9ae6ca`,7.29.1 is
`d39a83e7b0d631590c3b85b5cc0dbeab66c3a1d8`; npm metadata/integrities and both release notes were
read. MIT; no new runtime dependency, engine requirement or upstream code copied into OpenBot.
The patches destroy the inflater after size-limit cleanup; application WebSocket error handlers
alone cannot catch that former unhandled internal error. Existing7.29.1 SDK and6.28.1 node-gyp
closures already contain the fix. Node's bundled implementation is a distinct version boundary;
a lockfile update does not claim to update it. No product use of that bundled WebSocket was found
in the traced consumers. Revision-specific installation/regression and audit results are recorded in PR104.

Drizzle's [0.31.10 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/drizzle-kit%400.31.10)
confirms the tsx transition; the installed `bin.cjs`, `api.js` and `api.mjs` match it. The reviewed
0.31.11 registry manifest still declares the old loader, so that patch alone does not remove the
advisory. [Upstream issue5145](https://github.com/drizzle-team/drizzle-orm/issues/5145) is marked
fixed-in-beta; that label is not proof of a compatible stable fix. Retain the known residual
advisory until the actual published closure and migration consumer are verified together.
