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
   ambiguous elements, changed evidence or human takeover prevent the click.
4. The result includes the post-click frame and a PNG artifact. The response must confirm the same
   reference and URL. An uncertain response fails without retry; inspect the browser before deciding
   whether to submit another task, because the first click may already have happened.

## Boundary and evidence

An origin opt-in is not network egress isolation. Screenshot equality cannot prove JavaScript
behavior or prevent navigation started by a button. Use only trusted test pages with known local
behavior until browser-side egress enforcement is implemented. No typing, shell, arbitrary code,
model-selected actions, automatic retry, signed single-use execution lease, global exclusive control
or native macOS/Windows/Linux desktop support is added. The upstream human-control state can veto an
action; it cannot grant Server authority. Per-Bot serialization applies within one Provider instance.

See [research](research/controlled-browser-click.md) and [Provider conformance](PROVIDER_CONFORMANCE.md)
for pinned dependencies, actual validation and the remaining platform gates.

## Python migration candidate: browser session identity

The separate Python candidate binds each browser view to its original enrolled Worker identity
and current connection. It retains that host identity across Server restart. Reconnecting the same
Worker permits a fresh view; re-enrolling a device with the same Node id does not transfer the old
browser or its login state. Legacy browser history without a verified identity binding is refused.
Profile rebinding and login-data migration are not available in this candidate.

Identity revocation or replacement is checked before input, at dispatch and before showing a result.
Unconfirmed input is never retried, and a failed return of control leaves the durable pause in place.
The client removes the old frame and unsent input after losing session authority. These checks use
real PostgreSQL and HTTP/WebSocket tests with synthetic frames; they do not establish physical
profile persistence or browser egress isolation. Human takeover remains disabled in default Python
composition until the complete Work browser effect path is integrated. See the
[identity binding review](research/browser-host-binding.md).
