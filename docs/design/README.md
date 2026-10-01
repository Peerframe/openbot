# Design asset status

[English](README.md) · [简体中文](README.zh-CN.md)

- [Office concept](m0-office-concept.png): historical M0 exploration only. It is not an implementation contract; the office plugin remains deferred.
- [Avatar system](openbot-avatar-system.png): the earlier modular robot reference. It is superseded by the frameless head avatars in the [Avatars artboard](desktop-ui-2026-10/Avatars.dc.html); the stored appearance layers it introduced remain compatible.
- [Avatar source](avatars/README.md): the owner's frameless avatar artwork (v2 SVGs) that the app's v3 avatars are drawn from.
- [README banner](openbot-readme-banner.png) and [channel demonstration](openbot-channel-demo.png): current README illustrations.
- [Desktop UI design contract (2026-10)](desktop-ui-2026-10/README.md): the owner-approved artboards every
  screen is being rebuilt to, with the [implementation plan and division of work](desktop-ui-2026-10/IMPLEMENTATION.md).

The retired public pixel-bot PNG/SVG and unused login/member selectors were removed from application assets. Git history retains their earlier use; they should not be restored into the runtime bundle as historical documentation.

## Read before a UI change

Read the relevant section of [INTERFACE](../INTERFACE.md), then the actual component and its test via
[the UI route](../REPOSITORY_MAP.md#ui-interaction). INTERFACE mixes existing behavior and future
intent; current code/tests and the accepted task define scope. Layout and visual decisions follow the
[2026-10 design contract](desktop-ui-2026-10/README.md); keep assets such as the RobotAvatar.
[styles.css](../../apps/web/src/styles.css) owns base tokens (`--blue`, `--line`, `--muted`, `--panel`),
focus rings and global primitives. Component CSS owns local layout; reuse nearby native buttons,
forms and dialogs. Do not add a theme that overlaps the contract's tokens or infer a redesign from the
historical office image.

| State / term | Actual reading owner | Meaning to preserve |
| --- | --- | --- |
| Loading / empty | [ContextRail.tsx](../../apps/web/src/components/ContextRail.tsx), [WorkTasksScreen.tsx](../../apps/web/src/components/WorkTasksScreen.tsx) | Pending UI is not completed work; empty data is distinct from failed retrieval |
| Waiting / approval | [WorkTasksScreen.tsx](../../apps/web/src/components/WorkTasksScreen.tsx), [ApprovalCard.tsx](../../apps/web/src/components/ApprovalCard.tsx) | Control reports attention; a visible approval request grants nothing |
| Failure / unknown | [WorkTasksScreen.tsx](../../apps/web/src/components/WorkTasksScreen.tsx), [work-api.ts](../../apps/web/src/work-api.ts) | Known rejection differs from an unconfirmed external result; do not blindly resubmit |
| Disconnected / stale | [WorkTasksScreen.tsx](../../apps/web/src/components/WorkTasksScreen.tsx), workspace hooks | Invalidate freshness and unsafe controls; losing observation does not cancel the task |
| Read-only / unavailable | [NativeTaskScopeView.tsx](../../apps/web/src/components/NativeTaskScopeView.tsx), control authority mode | Disabled mutation is not authorization; Server still enforces the boundary |
| Delivery / artifacts | [WorkTasksScreen.tsx](../../apps/web/src/components/WorkTasksScreen.tsx), [ApprovalCard.tsx](../../apps/web/src/components/ApprovalCard.tsx), [ArtifactCard.tsx](../../apps/web/src/components/ArtifactCard.tsx) | Persisted action, published artifact and successful download are separate facts |

These component paths are under `apps/web/src/components`; follow their imports for the particular
flow. WorkTasksScreen currently reports registered artifacts without providing download there.
Do not present that registration as successful delivery. Employee/Bot is identity, Node is execution
machine, Task is durable intent, and Run is an execution attempt; older INTERFACE wording is not a
new state model. Use the actual contract's identifiers.

Validate affected states at wide and narrow widths, keyboard navigation/focus and existing reduced
motion behavior. Report actual viewport and entry used. UI fixture tests do not establish native
Desktop packaging, a live model result or a newly supported platform.
