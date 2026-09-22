# Shared-client fault fixtures

[简体中文](CLIENT_FIXTURES.zh-CN.md)

Use the actual shared Web/Desktop `ChannelWorkspace`, `ContextRail` / `ApprovalCard`, `RunInspector`, `Sidebar` and artifact components with public synthetic data. This is a contributor development entry, with no Server, private `.env`, account, database or paid model required. The scenario controls drive a local in-memory transport; they do not perform real external actions.

## Start from a fresh checkout

Use the Node/npm versions declared in the root `package.json`. From the repository root:

```sh
npm ci --ignore-scripts
npx turbo run build --filter=@openbot/web^...
npm run dev:fixtures --workspace @openbot/web
```

Open **http://127.0.0.1:5182/client-fixtures.html**. The default is `approval`; a reproducible entry can select another scenario, for example `client-fixtures.html?scenario=reconnect`. The selector and **重置场景** reset the complete synthetic run. An unknown scenario is rejected.

This command builds and previews the isolated entry. After editing shared components, run `npm run build:fixtures --workspace @openbot/web` in another terminal, then reload the page. There is no HMR: the built preview keeps `connect-src 'none'` without Vite's development WebSocket client. The default port is fixed to avoid silently opening another development service. Override it explicitly with `-- --port 5183` if necessary.

## Exercise the official components

| Scenario | Action | Expected result |
| --- | --- | --- |
| `approval` | Approve with **提交这张表单** in the actual approval card, or choose **拒绝** | The card disappears. Approve finishes with a final message; reject leaves the run cancelled. Reset to try the other decision. |
| `tool-fault` | **触发工具故障**, then **任务详情** | The actual inspector explains the failure and shows the synthetic timeout progress record. |
| `cancellation` | The official **停止任务** control, then **注入迟到输出** | The run remains cancelled; the injected late text never appears. |
| `partial-output` | **下一段（含重复和旧事件）**, then **完成回复** | Duplicate/older output does not undo the longer text. Completion replaces the partial output with the final message. |
| `artifacts` | Click the report in the final message | The actual artifact link downloads a fixed, public synthetic Markdown report using a local Blob. |
| `reconnect` | **断开事件流** → **离线期间完成** → **恢复连接** | The actual channel connection badge enters retrying. The final message stays absent while offline, then appears after the existing 2-second retry and API reread. |

At narrow widths use **频道**, **审批与状态** and **侧栏** to reach the same components. The fixture only simulates approvals and cancellation writes; composer submissions, resubmission, account/settings/model/plugin operations are unavailable. Their requests never fall through to a real Server.

## Validate and build

```sh
npm run typecheck --workspace @openbot/web
npm exec --workspace @openbot/web -- vitest run src/client-fixtures src/demo --maxWorkers=2
npm run build:fixtures --workspace @openbot/web
npm exec --workspace @openbot/web -- vite preview --config vite.fixtures.config.ts
```

The preview uses the same explicit URL on port 5182. The separate build is in `apps/web/dist-client-fixtures/` and is ignored by Git. Regular Web and Desktop builds keep their original entry and exclude these fixtures. New component tests also run in the normal Web suite and root `npm run check`.

The adapter extends the existing isolated website demo after its origin, method and body validation. The fixture document installs it before importing the official UI and uses memory-only storage. Unknown endpoints are denied; the document CSP forbids network connections, frames and workers, and camera/microphone/geolocation are disabled. The preview server binds only to loopback and has no API proxy. Keep fixture imports out of production `main.tsx`, `App` and auth/bridge code.

## Evidence and limits

The fixture verifies client state and interaction against known synthetic projections, including events missed during disconnect. It does not test live Server authorization, real tools/models, Electron IPC/packaging, native permissions or actual internet failure. The ContextRail receives synthetic workspace state; the channel's connection badge and reconnect/refetch path use the actual API subscriber. Approval expiry labels use the local display clock; all scenario advancement is explicit.

See [research and validation](research/shared-client-fixtures.md) for dependency pins, isolation decisions and recorded browser/test evidence. No new package is required.
