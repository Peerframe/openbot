# Usable Agent delivery status

[English](DELIVERY_STATUS.md) · [简体中文](DELIVERY_STATUS.zh-CN.md)

Follow-up: [reviewed single-file skill instructions](REVIEWED_SKILLS.md) now support import, digest-bound Owner review, progressive native loading and revocation. Scripts and additional resources remain pending.

This is the September 8, 2026 delivery branch status, not a public release announcement.
[PR #19](https://github.com/yxflc11/openbot/pull/19) was merged; the skill-content follow-up builds on that main branch. The
[delivery evidence](DELIVERY_WORKLOG.md) retains historical checks, constraints and evidence limits.
The older [roadmap](ROADMAP.md) describes earlier milestones. Current implementation and remaining
work are routed by the [repository map](REPOSITORY_MAP.md) and [contributor tasks](CONTRIBUTOR_TASKS.md).

## What this milestone delivers

| Area | Implemented behavior | Evidence and practical limit |
| --- | --- | --- |
| Desktop distribution | macOS arm64 DMG; Windows x64 per-user EXE; Linux x64 AppImage and DEB; manifests, SHA-256, CI retention and draft-release gate | Native installer CI and local DMG mount/ASAR/fuse validation. Public Desktop Release is not published; signed or certified installation is not claimed. See [installation](DESKTOP_INSTALLATION.md). |
| Command installation | Version-specific shell and PowerShell bootstraps; retained OS trust checks; bounded verified downloads; Linux failed-copy recovery | Real Bash and PowerShell failure/retry fixtures. The documented public command requires a published matching Desktop Release. |
| Model configuration | Private persistent encrypted configuration, OpenAI/Anthropic/OpenRouter, Desktop and Web settings | Real settings persistence plus official SDK response fixtures. Public OpenRouter catalog metadata succeeded; live paid inference remains unverified. One active Server configuration; no per-Bot profiles or arbitrary endpoints. |
| Agent work loop | Bot role context, bounded model/tool/observation iteration, scoped channel reads, durable reply and task state | Server/SDK/database tests and actual UI. The native loop does not currently call interactive Worker tools. |
| Research/report delivery | Up to three task-supplied HTTPS URLs, bounded public text extraction, provenance-bearing Markdown, authenticated download and exclusive native save | Real UI/Server/database/disk with deterministic source/model fixtures. Local proxy DNS maps public sites to a reserved range; successful real public source reading is unverified here. No general web search, PDF or arbitrary filesystem access. |
| Execution control | Durable native task stop, explicit new-task resubmission, reported token counts and categorized failures | Cancellation/publication database races and real UI passed. No checkpoint resume, token streaming, model billing or Worker cancellation claim. |
| Reviewed knowledge | Candidate lesson from a successful task, Owner edit/accept/reject, explicit default-off sharing, revision-bound memory use and revocation | Actual Desktop/Web review/use/revoke/reload; private and other-Bot memories excluded. No automatic active-memory approval; reviewed skill instruction loading is now described separately below. |
| Desktop continuity | Old event streams aborted on replacement, navigation, Server switch, renderer exit and close | Actual built ASAR completed four distinct report tasks with intervening reloads and four further reloads. QA uses isolated identity and save-dialog selection, not signed-app certification. |

## Existing capabilities and remaining Hermes comparison

These rows describe the historical checkpoint, not today's implementation status.

| Capability | Evidence at this checkpoint | Work then remaining |
| --- | --- | --- |
| Timed automation | `apps/server/src/automations.ts` and `postgres-automation-store.ts`: durable 15-minute to 7-day intervals, pause/resume/delete and due-task dispatch | Natural-language schedule creation, cron/timezone semantics, external message delivery and multi-Server coordination |
| Skills and portability | Versioned metadata, controlled template import/export, single-file SKILL.md import, digest-bound full-text review, bounded native loading and revision-bound revocation | Scripts, referenced resources, content portability, skill dependencies in native execution and live model quality |
| Messaging gateway | No Telegram/Discord/Slack/WhatsApp/Signal gateway adapter in the runtime | Start with one platform, bind identities and approvals to Server, then validate incoming-event idempotency and authorized replies |
| Delegation and parallel agents | Native runner admits at most two runs; no isolated child-agent protocol | Parent/child authority, isolated context, cancellation, budgets, aggregation and recovery. Concurrent independent runs are not delegation. |
| Computer interaction | Explicit URL screenshots plus default-off, Server-reviewed single-button click on trusted test origins; see [controlled browser](CONTROLLED_BROWSER.md) | Browser-side egress, signed single-use leases, native input, global exclusive takeover and additional real-device conformance |
| Additional environments | Existing Server containers and Worker routing; no SSH/Daytona/Modal/Singularity runtime adapters | Select an actual backend through the research/reuse process, then prove lifecycle, isolation and cleanup |
| TUI and conversational recall | Web/Desktop channels and bounded recent context | Full terminal editing/commands, full-text or semantic recall, background consolidation and Honcho-style user modelling |
| Training/research exports | Operational Run events and audit records | Deliberate redacted training trajectory export, replay/quality format and privacy/retention controls. Audit logs are not a training dataset. |

The learning direction remains explicitly inspired by
[Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/63279301bcbdc185c1b07b98a9312eb0c862f26d).
This milestone supplies a reviewed-memory loop, not full Hermes parity.

## Gates left open at this milestone

1. **Public installation:** complete native PostgreSQL binary/source correspondence and LGPL
   source/relinking evidence, then maintainer release review, main-branch CI and actual public
   installer downloads. Add signing/notarization and clean-device install/upgrade/uninstall evidence.
   Until then, retain the explicit development-artifact download path.
2. **Live useful work:** validate a real supported provider and public HTTPS sources in a suitable
   network, then verify a source-backed report, cancellation and remembered lesson without fixtures.
3. **Skill resources:** reviewed standalone instruction loading is implemented. Scripts, referenced
   resources and portable skill bodies need their own execution/containment review.
4. **Controlled computer work:** the reviewed browser-click slice is implemented. Enforce browser
   egress and validate additional devices before widening claims. See [Provider conformance](PROVIDER_CONFORMANCE.md).
5. **Ecosystem:** add one messaging gateway, then delegation or another backend according to an
   actual user workflow. Preserve the explicit remaining scope instead of adding declaration-only adapters.

At this milestone, macOS included a local Server; Windows and Linux were remote clients. Desktop quitting
stops app-owned local services. Unattended automation requires a continuously running Server.
There is no automatic updater, complete backup/restore flow or cross-platform local-Server claim.
