# One reviewed browser click

OpenBot can execute one explicitly named button click through the existing Docker/browser Provider,
with Server approval and before/after screenshots. This experimental flow is disabled by default and
limited to trusted test origins. It does not implement native desktop input or a general browsing agent.

## Setup and task

Enroll a Worker using [Node enrollment](NODE_ENROLLMENT.md), and configure the separately running
[agent-computer pinned at 257c1280](https://github.com/CopilotKit/openbot/tree/257c1280d684089be9adb0b35cce262efc7064bf/agent-computer).
Keep its endpoint private, its token secret, and its browser profile separate from personal accounts.
Use one Worker per computer service. Set these additional Worker values for a local fixture:

```dotenv
OPENBOT_DOCKER_COMPUTER_URL=http://127.0.0.1:4198
OPENBOT_DOCKER_ALLOW_PRIVATE_HOSTS=true
OPENBOT_DOCKER_INPUT_ORIGINS=http://127.0.0.1:4197
```

Also supply `OPENBOT_DOCKER_COMPUTER_TOKEN` through the existing secret configuration. Restart the
Worker after changing configuration. Select an Employee with the `docker-linux` execution profile.
For example, a task-owned page at port 4197 can expose a button named `Show preview` that only changes
its local display. Send:

```text
Open http://127.0.0.1:4197/ and click button "Show preview"
```

Chinese syntax: `打开 http://127.0.0.1:4197/ 并点击按钮“Show preview”`.
The task must contain exactly one URL and one quoted, exact button name. Origin entries are exact
origins without paths or trailing slashes, comma-separated, at most ten; only HTTPS and HTTP
`127.0.0.1` are accepted. Use the private-host override only for an isolated local test.
Without the origin opt-in, the Worker does not advertise `browser.input@1`.

## Review and result

1. The Worker navigates, publishes the current frame, and observes one uniquely named enabled button.
2. The Server checks the task URL/name, execution identity and privileged `browser.click` policy.
   Open the pending task details to inspect its execution frame. Review the URL and button,
   then approve or reject within two minutes.
3. On approval, the Worker checks browser control and an unchanged screenshot/URL, then sends the
   original element reference and snapshot generation exactly once. Rejection, expiry, cancellation,
   ambiguous elements, changed evidence or human takeover prevent a click that has not been dispatched.
4. The result includes the post-click frame and a PNG artifact. The response must confirm the same
   reference and URL. An uncertain response fails without retry; inspect the browser before deciding
   whether to submit another task, because the first click may already have happened.

## Stop a Worker task

The task details offer **Stop task** for queued, assigned, running and waiting-for-approval Worker
Runs. The existing Owner-only `POST /api/v1/runs/:runId/cancel` accepts exactly `{}` with a trusted
mutation Origin. Success returns `{ run }` only after its cancellation audit and any pending
approval invalidation commit. Repeating a cancelled request returns the same terminal Run without
another cancellation event. A missing Run returns 404; completed, failed or blocked Runs return 409
and keep their result/artifacts. Native task cancellation retains its existing descendant behavior.

A pending approval becomes `expired` with a fixed audit reason; an already approved decision stays
approved as historical fact. Old approval decisions return 409 and cannot restart the Run. When a
Node disconnects, or the Server recovers interrupted work at startup, running and waiting Runs fail
and pending approvals expire together. This single-Server recovery does not retry or resume work.

Cancellation revokes acceptance of later progress, completion and artifacts, then requests Node
abort. Provider cleanup continues to occupy local Node capacity; its completion wakes queued work.
If an external action was already sent, it may already have happened or still finish. The audit
records `externalOutcome: unknown` for running/waiting cancellation. A cancel response proves the
Server decision, not remote rollback or a cancellation acknowledgement. Inspect the external system
before creating another task. No Worker retry button or automatic redispatch is added.

## Boundary and evidence

An origin opt-in is not network egress isolation. Screenshot equality cannot prove JavaScript
behavior or prevent navigation started by a button. Use only trusted test pages with known local
behavior until browser-side egress enforcement is implemented. No typing, shell, arbitrary code,
model-selected actions, automatic retry, signed single-use execution lease, global exclusive control
or native macOS/Windows/Linux desktop support is added. The upstream human-control state can veto an
action; it cannot grant Server authority. Per-Bot serialization applies within one Provider instance.

See [research](research/controlled-browser-click.md) and [Provider conformance](PROVIDER_CONFORMANCE.md)
for pinned dependencies, actual validation and the remaining platform gates.
