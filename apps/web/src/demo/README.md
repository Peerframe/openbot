# Website interaction demo

[简体中文](README.zh-CN.md)

This independent static entry imports the **actual** `Sidebar`, `ChannelWorkspace`, `RobotAvatar`, message actions, reactions, task inspector and product styles. It is not a screenshot or a separately drawn product UI. A fixed synthetic collaboration illustrates a task, two delegated Bots, incremental text, and a Markdown deliverable. The visible label explicitly says that no model is connected.

From the repository root:

```sh
npm run build:demo -w @openbot/web
npm exec --workspace @openbot/web -- vite preview --config vite.demo.config.ts --port 5178
```

The output is `apps/web/dist-demo/index.html` plus its assets. Copy the **entire** directory into the site's build output at `demo/`. Relative asset paths work under `/demo/` or a nested project Pages URL. Do not copy it into the Desktop renderer or change the production HTML entry. The site build should run this command before copying, so stale demo assets cannot silently ship.

Recommended embed (replace the relative URL to match the parent page):

```html
<iframe src="./demo/index.html" title="OpenBot interactive demo — example data"
  loading="lazy" referrerpolicy="no-referrer"
  allow="clipboard-write; microphone 'none'; camera 'none'; geolocation 'none'"
  style="width:100%;height:780px;border:0"></iframe>
```

Use `?autoplay=1` only for an in-view demonstration; reduced-motion users still start manually. Playback stops when the tab becomes hidden. Play/pause/restart and the delivery shortcut remain in the iframe. The parent need not access its DOM or send commands. At widths below 700px, the demo's Channel button opens the actual sidebar as an overlay. The adapter and Content Security Policy are the isolation controls; an iframe sandbox that omits `allow-same-origin` will block module loading and clipboard, and one that omits `allow-downloads` will block the advertised download. Do not add a misleadingly broken sandbox configuration.

## Boundaries

- The demo alone replaces fetch/EventSource before dynamically importing product components. Unknown or foreign endpoints fail closed; the original transport is never called. HTML CSP has `connect-src 'none'`, no frames/workers, and no form submission. No service worker, Server, API key, credentials, telemetry or model is used.
- Browser storage is replaced with an in-memory implementation for this document before product preferences load. Reload/restart clears demo state. Text typed into the composer stays in this page; the answer is visibly identified as a fixed example, not generated output.
- Play/pause/restart, scrolling, sidebar search, Bot identity cards, reply references, copy, six Owner reactions, task linkage/details/cancellation and the fixed result download work. Broader workspace settings and creation controls explain their scope. Uploads, plugin execution and recording do not collect or send content; unsupported API writes fail closed. The demonstration is not a substitute for testing those production features.
- File links are intercepted in this entry only and converted to a fixed Markdown Blob. The fixed synthetic file has no user data. Clipboard writes happen only after the visitor clicks Copy; the parent must allow clipboard-write when embedding across origins.
- No statistics, token usage, live-provider performance or real human collaborators are fabricated. The product's connection indicator refers to the demo event adapter, as the persistent demo label makes clear.

The fixture transport tests run in the normal web test suite. See [research](../../../../docs/research/website-component-demo.md) for reuse rationale. Browser verification is recorded below; screenshots remain outside the repository.

## Verification record (2026-09-10)

The standalone production build and six transport/component tests passed. The component test imports the real API module and verifies that incremental events render in ChannelWorkspace, reactions change the real chips, copying writes the selected text, task links open the task sheet (then `RunInspector`, now `TaskSheet`), and restart clears the conversation. Browser checks in Chrome covered the default desktop viewport, 1060×640, 390×780 and 390×640: sidebar search/overlay, playback/pause, incremental Nova/Otto replies, delivery shortcut, actual reply submission, Copy's success feedback, reactions, collaboration detail links, and the downloaded Markdown contents. Browser console inspection reported no errors. Screenshots are temporary review evidence, not committed assets. This does not certify all browser engines or a live-provider run.
