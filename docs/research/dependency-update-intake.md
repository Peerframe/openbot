# Research: Reviewed dependency update intake

[English](dependency-update-intake.md) · [简体中文](dependency-update-intake.zh-CN.md)

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
