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
profile migration or browser egress isolation. Human takeover is an explicit per-route opt-in in
Python composition; it is disabled by default. See the
[identity binding review](research/browser-host-binding.md).


## Python candidate: approved Work screenshot

The Python product candidate can create a channel Task that captures the current screen of its
original browser. The Owner approves each capture in the existing Task Action view. The Task
publishes the exact PNG only after result review and completion. Models receive file metadata,
not screenshot contents; this profile cannot interpret a page or perform browser input.

This is an explicit deployment opt-in, disabled by default. Use the pinned Worker environment,
canonical database migrations through `0043_work_browser_profiles`, private object/artifact roots
and the existing Temporal product configuration. Configure the Node with its private computer URL
and token plus `OPENBOT_DOCKER_BROWSER_SESSIONS=true`. This declares session transport capability;
it grants no Work authority. Follow the existing host/network restrictions above.

Set `OPENBOT_CONTROL_BROWSER_CONFIG_PATH` to an absolute, non-symlink, owner-private JSON file
(mode `0600`). The file selects 1–32 exact Bot ids and their enrolled original Node ids:

```json
{
  "version": 1,
  "humanControl": true,
  "routes": {
    "00000000-0000-4000-8000-000000000001": "your-enrolled-node-id"
  }
}
```

Replace both example identities with your configured identities. The Bot must use `docker-linux`
and have a configured model connection. Open that Bot's browser view as Owner once before creating
the channel Task; this establishes its original host binding. Then request, for example:
“Capture the current browser as a PNG file without interpreting the page.” Browser routes select
capture-only Tasks instead of command Tasks for those Bots; existing Tasks are never converted.
Native Tasks and other Bots retain their existing capabilities. The optional `humanControl` boolean
defaults to `false`; set it to `true` to enable Owner takeover for only these routes. An unavailable
configured Node cannot be replaced by another available Node. Restart Control after configuration
changes; a changed route cannot silently replace an existing original host binding.

From the Employee profile, choose **Open browser**, then **Take control**. Navigate, click the
rendered page, enter text, use keys or scroll; finish with **Return to employee**. Closing the view,
disconnecting or allowing its lease to expire leaves the browser paused. A newly opened view may
need the former Node lease to expire (at most 30 seconds) before taking control. Only a confirmed
return permits fresh Work captures; an older approved action invalidated by takeover is not revived.
Observation-only deployments show **View only**. An uncertain operation clears stale input/frame
and is never resent automatically.

Each proposal freezes the current connection and human-control revision. A reconnect, identity
replacement, cancelled Task, revoked scope, expired claim or human takeover/release prevents that
proposal from dispatching. At most four attempts are allowed per Task, across corrections. A lost
acknowledgement reads the original stored observation; missing evidence stays unresolved and does
not trigger a replacement screenshot. Already received PNGs retain their original contents.

The PNG header/dimensions, size and digest are verified; models and result review see metadata only.
Do not treat capture success as proof of page meaning or an external action. Owner input has been
tested through the actual Python/Node/Chromium path against owned synthetic pages, including the
retained Web at desktop and phone sizes. Local storage persisted after closing/reopening the view.
This does not qualify public egress, autonomous page interpretation, host profile relocation or
general isolated browser deployment. Use trusted test pages with known behavior as described above.
See the [implementation and validation record](research/work-browser-capture.md).
See the [handover qualification](research/work-browser-handover.md) for the input/control boundary.


## Python candidate: approved page reading and input

A separate page scope extends newly created Tasks on explicitly trusted test origins. Apply
canonical migrations through `0044_work_browser_page_scopes`. Keep the capture configuration above
and add a `pageOrigins` map using the same Bot id:

```json
"pageOrigins": {
  "00000000-0000-4000-8000-000000000001": ["https://your-owned-test.example"]
}
```

On that original Node, also set `OPENBOT_DOCKER_BROWSER_TASKS=true` and
`OPENBOT_DOCKER_INPUT_ORIGINS=https://your-owned-test.example`, alongside the existing session opt-in.
Use one to ten exact HTTPS origins (no trailing slash, path or credentials); an owned local fixture
may use an exact `http://127.0.0.1:<port>` origin. These values are private deployment configuration,
not model instructions. Existing capture-only Tasks never gain page capabilities, and changed
configuration does not widen a Task's frozen scope. Restart Control and Node after configuration.

New Tasks offer `read_browser`, `navigate_browser`, `click_browser`, `type_browser`,
`press_browser_key` and `scroll_browser`. Each operation, including a read, requires its own Owner
approval in the existing Action view. At most sixteen page attempts are allowed per Task. Input
must reference a previous applied observation from this Task, with the original Node connection,
control revision, URL, screenshot digest and element snapshot. A changed page or actual Owner
correction invalidates the input. Filling replaces a field's value; empty text clears it.
An uncertain attempt is never resent. Human takeover retains the same exclusive pause/return rules.

The model receives bounded, untrusted page text and element data (16,000 characters, 200 elements,
64 KiB JSON maximum). It does not receive screenshot pixels. A successful response records an
observed attempt; it does not independently verify a payment, message delivery or other external
transaction. Reports are reviewed before publication. The real local product test covers separate
approvals, Unicode fill, one click, page reading, report download, an actual Worker stop/restart and
replay without repeated effects; its model responses are synthetic.

Additional real cases kill/restart the full Control or Node process and revoke/re-enroll the same
Node id. Old approved clicks never dispatch after the connection changes. Human pause survives,
old viewers expire and explicit reacquisition/return preserves the live browser state. A new
credential cannot inherit the old browser binding. Cancellation removes authority while retaining
unknown evidence for reconciliation; all three histories replay without new effects. See the
[scoped results](../experiments/work-journey/evidence/product-browser-interruption.json).

This candidate requires pages you control with known behavior. Allowed origins and screenshot
checks do not enforce network isolation against redirects, scripts or subresources. General
untrusted browsing, isolated Linux browser deployment and browser/Host profile replacement remain
separate retirement gates. See the [page action record](research/work-browser-page-actions.md) and
[reproducible product probe](../experiments/work-journey/README.md#approved-browser-product-probe).
