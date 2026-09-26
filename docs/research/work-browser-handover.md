# Routed Work browser handover

Reviewed before implementation on 2026-09-26 against `9f8cb96`.

## Reuse and scope

Extend the existing Python Owner browser sessions, shared PostgreSQL pause gate, retained F
protocol, React EmployeeBrowser and Docker Provider. Reuse the independently running MIT
CopilotKit/OpenBot agent-computer at `257c1280d684089be9adb0b35cce262efc7064bf`, with Playwright
1.62.1 (Apache-2.0), and PostgreSQL 17.11. No new driver, dependency, protocol version or copied
third-party source is needed. The reviewed source, tests, licenses, release/platform fit and
known issues are recorded in [the original click review](controlled-browser-click.md),
[Python session review](python-browser-sessions.md) and [approval ordering repair](browser-approval-handover.md).

GitHub searches rechecked `repo:CopilotKit/openbot agent-computer control human screenshot playwright`
and `repo:microsoft/playwright actionability human keyboard mouse screenshot`. The maintained
[upstream source](https://github.com/CopilotKit/openbot/tree/257c1280d684089be9adb0b35cce262efc7064bf/agent-computer),
[control issue](https://github.com/CopilotKit/openbot/issues/246),
[Playwright actionability documentation](https://playwright.dev/docs/actionability) and
[PostgreSQL advisory locks](https://www.postgresql.org/docs/17/explicit-locking.html) confirm the
existing split: browser mechanics belong to the upstream process; Owner identity, Work authority
and durable pause belong to OpenBot. The upstream control latch alone is not an authorization or
network isolation boundary. The frozen cached source/tests/license were re-read; no mutable main
source replaces the pin.

The concrete gap is activation and correct routing: normal Python startup disables takeover,
and first browser open can select an arbitrary compatible Node instead of the configured route.
Add optional, strict `humanControl: true` to the existing owner-private browser configuration.
Only its exact Bot-to-Node routes may take control. Missing configuration stays disabled. A
configured route cannot replace an already bound host or inherit a re-enrolled credential.
The same profile object feeds Work and browser sessions; all admitted Work browser effects are
currently capture-only and hold the shared gate through their receipt commit.

Expose takeover availability in the view so the UI can explain observation-only mode. A failed
command clears stale frame/input and disables input until current state is observed again. It
never repeats input. Closing a view, lost connection, expired control or uncertain release retain
durable pause. Explicit confirmed release permits a fresh Work action; it does not resurrect an
old approved action invalidated by takeover.

## Acceptance boundary

Exercise real PostgreSQL, public Owner HTTP, original enrolled Node WebSocket, configured Provider
and real pinned Chromium against an owned synthetic page. Cover navigation, click, Unicode input,
keyboard, scroll, exclusive control, close/reconnect, original profile continuity, Work exclusion,
explicit return, route mismatch and changed identity. Validate the rendered retained client with
isolated Playwright; the Browser plugin/skill is not available in this session.

Existing unit/HTTP tests remain portable without Chromium; real-browser qualification must remain
separately identifiable. No personal browser profile or paid model is used. Trusted loopback pages
do not establish public egress isolation, general autonomous page interpretation or Linux isolation;
the prior fixed Linux CDP component evidence is reused without a rerun. Those gates, updated paired
restore and final packaging still precede retirement of the old business Server.

## Verification — 2026-09-26

45 PostgreSQL/HTTP/WS browser session and Work tests passed; the final six-case route/configuration
run included one additional unrouted-employee refusal (46 distinct focused tests total). Nine React interaction tests passed. Real pinned Chromium151.0.7922.34 and agent-computer,
authenticated Node, Python product routes and PostgreSQL passed navigation, pixel click, Unicode
input, Enter, scroll, exclusive Owner control, paused close/reopen, persistent local storage and
explicit return. An old approved capture remained unknown after takeover; a fresh approved capture
after return applied. This is explicit continuation, not automatic replay of an uncertain action.

The actual built Web was exercised from the employee sidebar/profile through Open browser, takeover,
navigation, input, Enter and return, at1440×1100 and390×844. The target page independently recorded
the expected text and saved state. It used a private synthetic profile; no personal account was
opened. Inspection found a narrow-screen button compressed by a long name; the action group now
resists shrinking and the title wraps. The Browser plugin was unavailable, so isolated Playwright
was used. A pre-existing meta-CSP frame-ancestors console diagnostic remains; the Python response
already supplies X-Frame-Options DENY. No new app errors or framework overlays were accepted.

The first real attempt lacked the matching Chromium revision and failed without an input effect;
the exact pinned headless browser was downloaded into owned temporary storage. Early Web fixture
attempts incorrectly waited for networkidle despite realtime connections and omitted existing
knowledge/interactions/plugins services. Correcting only the fixture allowed the real entry flow;
those failed runs are not included in accepted evidence. The API/Work lifecycle and the affected
responsive UI follow-up are distinct runs. Existing Linux CDP and paid-model evidence were not rerun.

The responsive follow-up used only the actual retained Web input/return flow and passed in15.55s;
no complete API/Work or VPS case was repeated for the CSS change. `npm run check` passed after
allowing its owned loopback MCP test (the first sandbox-only attempt failed with listen EPERM).
Repository prerequisites executed; Turbo rebuilt6 of20 packages and reused14 valid build entries.
All newly owned browser API/Node/upstream/Chromium/PG fixtures were stopped and the database removed.
