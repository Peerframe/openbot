---
name: openbot-change
description: Make a scoped OpenBot repository change using current owners, consumers and existing decisions. Use for implementation; not for review-only or check-only requests.
---

# openbot-change

## Inputs

Use the requested outcome, reproduction or acceptance condition, and the actual checkout/diff.

## Steps

1. Read root `AGENTS.md`; verify `git status --short --branch`, `git rev-parse HEAD` and the target
   paths. Preserve unrelated work. Use the current handoff only when continuing that task.
2. Follow one relevant route in [the repository map](../../../docs/REPOSITORY_MAP.md). Read its local
   rules, contract, actual consumer and test; use `rg` to extend the route when evidence is missing.
3. Find the relevant [reuse entry](../../../docs/OPEN_SOURCE_REUSE.md). Ordinary fixes keep its decision
   and reviewed pins. Record the reference, scope and unchanged assumptions in the PR/handoff.
   New dependencies, public protocols, permission/persistence boundaries or architecture choices
   require targeted evidence under [the contribution rule](../../../CONTRIBUTING.md#research-evidence-and-documentation-exemptions).
4. Make the smallest complete change. Keep control-owned identity, approvals, root budget, facts
   and audit; preserve ordinary-process versus Temporal Activity lifecycles. No second loop or ledger.
5. Select focused checks via [openbot-check](../openbot-check/SKILL.md); for rendered changes use
   [openbot-ui](../openbot-ui/SKILL.md). Update affected English docs and maintained translations.

## Output and stop conditions

Deliver the diff, observed behavior, actual test counts/results and precise unverified dependencies.
Update the existing task handoff, never a parallel status platform. Stop dependent work for an
unresolved authority/data choice or conflicting edits; continue independent work. A missing fixture
is not a passed check. Publishing and paid/live-service effects need explicit task authorization.
