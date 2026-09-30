# ADR-0048: Opt-in Owner system notifications

- Status: Accepted
- Date: 2026-09-30

## Context

The approved settings design includes a notifications page. Nothing in OpenBot showed a system
notification: Desktop denies every renderer permission except a short microphone lease
(`apps/desktop/src/microphone-policy.ts`), so the browser Notifications API cannot work inside the
app, and the Server has no notification facility. The Owner needs to learn about pending approvals
and new Bot replies while OpenBot is in the background, without widening authority or exposing
conversation content on a locked screen.

## Decision and reasons

1. **Presentation only.** Notifications derive from facts the client already reads from the Server:
   pending approvals in the workspace snapshot and ADR-0047 unread counts. They grant, approve,
   route and persist nothing; a click only focuses the window and opens the related channel.
2. **Opt-in per device.** Two booleans (`notifyApprovals`, `notifyMessages`) join the existing
   allowlisted workspace preferences and default to off. The browser permission prompt runs only
   from the switch's user gesture. Notices fire only when the window is not attended, the first
   snapshot is a baseline (no backlog replay), at most three per update and one message notice per
   channel per minute.
3. **No private content.** Title/body contain only Bot and channel names and a count; never message
   text or approval target/summary, which can be untrusted model output and would appear on a
   locked screen or in OS history.
4. **Desktop uses Electron's main-process `Notification`** (Electron 44.3.0, as pinned in
   `apps/desktop/package.json`; [API](https://www.electronjs.org/docs/latest/api/notification),
   [tutorial](https://www.electronjs.org/docs/latest/tutorial/notifications), reviewed 2026-09-30)
   through one trusted-frame IPC channel, `openbot:show-notification`. Preload and main both
   validate exactly `{title, body}` (≤40/≤80 UTF-16 units, single line, no control characters;
   macOS truncates bodies near 256 bytes). Main checks `Notification.isSupported()`, retains each
   notification until click/close/failure or a five-minute expiry (the docs note listeners are lost
   if objects are collected), keeps at most four pending and closes them on quit. Renderer
   permissions stay denied. The Web entry uses the WHATWG
   [Notifications API](https://notifications.spec.whatwg.org/).

Alternatives: granting the renderer the `notifications` permission (widens the locked-down
permission handler for a feature main can serve with fixed inputs); Server push or Web Push
(requires a service worker, subscription storage and an outbound push service for a single-Owner
local product); a tray/dock badge only (does not reach a user in another app). No dependency is
added and no source was copied.

## Consequences and verification

Unsigned macOS development builds emit `failed` rather than showing notifications (Electron docs);
the settings page says so and offers a test notification. Windows notifications need an
AppUserModelID, which packaged installers set; Linux relies on libnotify. Delivery is best effort and
never a source of truth. Verification: Desktop notifier/preload unit tests (bounds, unsupported,
click-only focus, failure, expiry, pending cap), Web tracker/delivery tests (baseline, privacy,
throttle, browser permission and Desktop bridge paths) and settings tests. No packaged Desktop or
per-platform display evidence is claimed.
