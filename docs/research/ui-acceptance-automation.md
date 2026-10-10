# Research: Automated whole-interface acceptance

- Status: Accepted (Owner decision 2026-10-07)
- Date: 2026-10-07
- Owner: OpenBot maintainers
- Acceptance journey: one command starts a disposable stack and drives the real built Web
  interface in a real browser. The stack is PostgreSQL in Docker, the Python product serving the
  built Web, and the TS entry when present. The journey:
  - logs in;
  - creates two Bots and answers the role card;
  - checks the rail tabs and renames a Bot;
  - creates a 频道, sends a message and an attachment, and cancels a run;
  - opens all settings sections;
  - restarts the public entry and checks that the page reconnects without a new login.

  It finishes with a pass or fail receipt, screenshots and a tally of every API response.
- Security boundary:
  - only disposable data and generated credentials are used; nothing is installed and no model
    is called;
  - the browser is the Owner's installed Chrome or an explicit path, so the tool downloads
    nothing;
  - the receipt redacts the generated password and DSN.

## Trigger and existing decision

- Trigger: a new development dependency.
- Existing decision:
  - Linux browser qualification reviewed Playwright 1.62.1 as a
    container image for the 员工浏览器 runtime;
  - starter DOM regressions deferred an axe/Playwright accessibility
    CI gate.

  Neither added a Node browser-automation package to the repository.
- Changed assumption: the TypeScript control-plane migration
  ([migration plan](typescript-control-plane-plan.md), P2–P5) needs a whole-interface
  acceptance at each route-group switch. The P2 acceptance on 2026-10-07 took about an hour by
  hand, and it surfaced a pre-existing missing route that the HTTP contract suites did not cover.
  The Owner asked to make the acceptance repeatable.
- Scope: choosing the browser driver and how it starts the stack. Accessibility auditing and
  hosted CI wiring are out of scope here.

## Search evidence

- Search date: 2026-10-07.
- Registry and GitHub: `playwright-core`, `@playwright/test`, `puppeteer-core`, `webdriverio` and
  `cypress` (npm metadata, release tags, licenses, dependency lists, open issue counts).
- Existing OpenBot checks:
  - `scripts/python-acceptance-fixture.ts` (owned Docker PostgreSQL, environment allowlist);
  - `scripts/dev-processes.ts` (owned child processes);
  - `deploy/server/product-migrate.ts`;
  - the Python `OPENBOT_CONTROL_WEB_ROOT` static mount.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Fit | Decision |
| --- | --- | --- | --- | --- | --- |
| playwright-core | 1.63.0 (2026-09-04), tag `v1.63.0` / `1b025d7e20a026371cd5f98ba0cdce48892737c8`, npm integrity `sha512-rYCsBF/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC/bxgspzkjSfU+MweEMmPM8KJebG6nnyxo5mCg==` | Apache-2.0 | Microsoft; frequent releases; about 180 open issues | No dependencies and no install scripts (13.4 MB unpacked); downloads no browser; drives installed Chrome through `channel` or `executablePath`; can also launch Electron for a later Desktop acceptance | **Selected** |
| @playwright/test | 1.63.0 | Apache-2.0 | Same project | Adds its own test runner and config; the repository already runs `node --test` and Vitest | Not needed |
| puppeteer-core | 25.12.0 | Apache-2.0 | Google; about 280 open issues | Six runtime dependencies; no Electron launch API | Rejected |
| webdriverio | 10.0.0 | MIT | Smaller project (about 9.8k stars) | WebDriver/BiDi service layer is more than a local journey needs | Rejected |
| cypress | 16.1.1 | MIT | Large project | Its own runner, an app binary download, and an in-browser model that does not fit multi-process orchestration | Rejected |

## Reuse decision

- Selected option: released dependency, `playwright-core` 1.63.0, exact root devDependency.
- Why first viable: it has no dependency closure, needs no browser download, and is the only
  candidate that can also drive the Electron Desktop later.
- Exact OpenBot-specific gap:
  - the journey itself, written in OpenBot's own language and selectors;
  - an orchestration that reuses the existing owned PostgreSQL fixture and process owner;
  - a receipt that classifies every API response. Known, documented gaps are allowlisted by
    exact route with a reason, and anything else fails.
- Upgrade or exit plan: the driver is used in two files. Replacing it means rewriting the journey
  steps; the stack orchestration and the receipt do not depend on it.
- Failure behaviour: no browser found, Docker unavailable or a missing build each stop the run with
  a clear message before any product process starts. An unexpected response status, a console
  error or a failed step fails the run, and the receipt keeps the evidence. All owned processes and
  the container are removed on exit and on SIGINT/SIGTERM.

## Source incorporation

- Source copied or substantially adapted: no.
- Notices: `playwright-core` is a development-only tool and is not shipped in any product artifact.

## Verification plan

- Automated tests: argument parsing and response classification (`node --test`).
- Negative tests:
  - an unknown status or route fails the run;
  - an allowlisted route outside its exact pattern fails;
  - a missing browser stops the run before anything starts.
- Real run: the full journey against the Python product on main (local macOS, installed Chrome).
- Documentation: this record (en/zh) and a CONTRIBUTING entry.
- Support level: a local acceptance tool for maintainers and agents. It is not a CI gate yet.

## Unresolved questions

- Wiring it into hosted CI needs a pinned browser source for Linux runners. That is a separate
  change.


## P4 execution composition (2026-10-09)

The existing `--entry ts` journey now selects P4 with an owned PostgreSQL-backed mTLS Temporal
fixture before starting its paired Python/TS processes. Reuse the Work fixture lifecycle and pins;
no new browser, service installation or provider account. The unchanged12 interface steps run only
after `/health` identifies a running `typescript-v1` execution owner. Receipts include `workGroup`.
The real P4 run passed12/12 with112 API responses, zero unexpected responses/page errors/workspace
503s, including entry restart and reconnect. This is disposable interface acceptance, not installed
app drain, isolated command execution or paid inference. See the [P4 record](typescript-control-plane-p4.md).
