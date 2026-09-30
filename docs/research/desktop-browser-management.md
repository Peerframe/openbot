# Research: Employee browser management (C6)

- Date: 2026-10-01
- Decision: reuse the reviewed original-host browser path; retention data scope remains unresolved.

Reviewed the browser computer and routed Work handover entries in OPEN_SOURCE_REUSE and
[the retained decision](work-browser-handover.md). GitHub searches used
`CopilotKit openbot agent-computer restart browser clear cookies`. Re-read the pinned MIT
agent-computer `257c1280d684089be9adb0b35cce262efc7064bf` source `index.ts` and `profiles.ts`
through the GitHub contents API. `/health` projects running state without creating a browser;
`/computers/stop` gracefully flushes the existing profile; the next screenshot starts it through
its existing creation path. `/computers/reset` deletes only the validated Bot profile and releases
upstream control. No general filesystem API is needed. Existing upstream profile/control tests and exact Playwright 1.62.1 are retained.
A new isolated native macOS probe of the pinned upstream and Chromium headless shell revision1234
passed stopped health, graceful restart, profile reset with stopped health, and a fresh restart.
No account, personal browser profile, page navigation or Linux isolation claim is involved.

Compared a thin adapter, attaching a separate CDP manager, and a local upstream fork. Select the
thin adapter; a second manager would bypass the shared human/agent gate and original identity.
Use an explicitly enabled `browser.maintenance@1` capability over the existing bounded browser
transport. The public input is a fixed operation; no URL, path, command or credential is accepted.
Retain Owner/Origin checks, short credential and socket identity fences, Server pause/revision,
intent/receipt audit and no retries. Restart/clear invalidates prior observations and leaves the
Server and Provider paused until a fresh Owner takeover and release. Clear requires a separate
exact confirmation literal; it can never be an approval exception. Unknown completion stays paused.

The upstream has no persistent download-management/retention API. Durable approved screenshots
are immutable Server Work blobs required by result verification until task completion. A retention
setting cannot silently remove active-task evidence or delete arbitrary workspace files. The user
has been asked whether retention concerns Server browser deliverables, local Desktop saved files,
or both. Continue lifecycle independently; do not claim retention enforcement until this choice
is resolved and its actual storage path is integrated. No source copied or substantially adapted.
