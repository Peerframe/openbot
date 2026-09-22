# 研究：确定性的共享客户端故障夹具

- 状态：已接受
- 日期：2026-09-22
- 维护者：OpenBot maintainers
- 对应主线：C2
- 验收流程：贡献者从全新检出打开独立本地入口，不依赖 Server、私人环境或付费模型，即可在官方 Web/Desktop 共用组件中验证等待审批、工具故障、取消、部分输出、产物和重连。
- 安全边界：只替换夹具文档内的 Fetch/EventSource，且在导入正式 UI 前完成；未知请求拒绝，CSP 禁止连接。没有生产 Owner 会话或执行权限。

## 检索证据

检索日期为 2026-09-22。查询包括 `site:github.com/mswjs/msw release v2.15.0 browser service worker tests` 和 `repo:vitejs/vite hmr false ws false`。核查了 [Vite 8.3.0 发布](https://github.com/vitejs/vite/releases/tag/v8.3.0)、`playground/multiple-entrypoints`、HTML middleware、MIT 许可，以及 [MSW 2.15.0 发布](https://github.com/mswjs/msw/releases/tag/v2.15.0)、测试脚本和问题跟踪。复用 Vite 一致性研究的 open issue 检查，不升级依赖。

主要文档包括 [Vite HTML/多入口构建](https://vite.dev/guide/build)、[React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)、[WHATWG EventSource](https://html.spec.whatwg.org/multipage/server-sent-events.html) 和 [Vite server.ws](https://vite.dev/config/server-options#server-ws)。本地已读复用清单、`website-component-demo.md`、`workspace-snapshot-stream.md`、`vite-8.3-lock-coherence.md`、`react-19.3-version-coherence.md`、`web-dev-csp-nonce.md`，以及真实组件/API 重连和现有演示测试。

## 候选比较

| 候选 | 固定版本或提交 | 许可 | 维护、测试与边界适配 | 决定 |
| --- | --- | --- | --- | --- |
| WHATWG Fetch/EventTarget/EventSource | 2026-09-22 查阅的现行标准 | WHATWG 文档条款 | 原生浏览器接口，与当前命名事件/error 回调一致，无持久 Worker | 复用标准边界 |
| OpenBot 独立组件演示 | `2cc32d0` | MIT | 既有 adapter/组件测试和渲染验证；拒绝未知、外域请求，隔离存储 | 通过受控 fixture hook 扩展 |
| React / React DOM | 19.3.0 / `1d34f91dfde6bba84d08b683aaba164c7194dacb` | MIT | 保留一致性和 renderer 测试研究；稳定的 external-store snapshot | 复用已有依赖 |
| Vite | 8.3.0 / `434e8e9495436a60789f2b588a04a6a24a3d1661` | MIT | 已发布版本，多入口 playground、现有 CSP 研究 | 复用独立 HTML 构建 |
| MSW | 2.15.0 | MIT | browser/node/unit 测试与活跃 issue；适合更广 API，但此处会新增持久 origin Worker 状态 | 不加依赖，复用现有适配器 |

## 复用决定

首选浏览器标准、已有发布依赖和窄范围适配。现有演示只能展示成功协作，缺少可选故障、正式审批卡、连接错误和断线漏事件补读；仅补足这些确定性状态及手动推进。

生产 `App`、认证、Desktop bridge 和 Server API 不变；独立 `client-fixtures.html` 输出到专用目录，普通 Web/Desktop 构建不包含它，生产入口没有启用夹具的查询参数。适配器在原 origin/method/body 校验后扩展，直接使用官方 ChannelWorkspace、Sidebar、ContextRail/ApprovalCard、RunInspector 与产物组件及样式。

重连使用真实 error 事件、现有 2 秒重试计时器和频道读路径。手动推进不依赖模型时序，仅审批有效期标签使用相对显示时钟。未知场景、外域、未支持写入、账户/模型/插件接口全部拒绝，不回退原 fetch。下载只包含固定公开合成文本；当前文档存储仅在内存。

研究过程中使用逐响应 nonce 验证了 Vite 开发服务的六场景，但发现 `hmr:false` 仍会尝试 WebSocket；核查固定版本安装源码 `clientInjections`、`server/ws`、浏览器 client、类型和官方文档后，即使设置 `ws:false` 并完整重启，观察到的构建仍注入主动连接的 client，CSP 正确阻断。最终采用已有的 Vite build + preview 接口作为开发命令；修改后重建并刷新，没有 HMR、不需要开发 nonce 适配器、不放宽 CSP、不修改上游。

退出方式是删除独立入口，不触及生产；契约变化时同步夹具和真实组件测试。没有复制或大幅改编上游源码，没有新增第三方声明要求。

## 验证与限制

- 适配器验证重置、审批仅消费一次、取消后迟到输出、产物门控、离线读取与拒绝真实网络回退。
- 真实 React 组件验证正式审批/取消、部分文本、失败详情、产物和漏消息后的自动补读。
- 普通 Web/Desktop 构建检查夹具 HTML 与标记缺席；回归原网站演示。
- 使用已存在的 Playwright 和系统 Chrome 全新隔离 profile，没有安装依赖。浏览器实测最终构建预览开发入口的六个场景、1440px 桌面及 390px 窄屏、控制台、网络请求与固定 Blob 下载。截图和临时验证脚本放仓库外。
- 中英文使用说明见 [CLIENT_FIXTURES.zh-CN.md](../CLIENT_FIXTURES.zh-CN.md)。

这不是原生 Electron GUI/IPC/打包、真实 Server 授权、外部工具副作用或模型质量验收。生产 Desktop 的只读快照代理不在 C2 范围。ContextRail 使用合成工作区状态；实际频道连接标记和重连补读来自正式 API 订阅器。详细命令与验收结果同步记录于[英文研究](shared-client-fixtures.md)。

## 验收证据（2026-09-22）

- `npm ci --ignore-scripts` 与 `npx turbo run build --filter=@openbot/web^...` 通过，无私人配置，无依赖或锁文件变化。
- 定向 Vitest 共 4 文件、18 测试通过（12 个新夹具测试＋6 个原演示回归）。重连用例检查离线时最终消息缺席，并由真实 2 秒重试补读出现。
- Web 类型检查、独立夹具、普通 Web 和 Desktop renderer 构建通过；正常 HTML/JS/CSS 输出没有夹具入口或标记。保留既有普通构建的 chunk-size 与 import-extension 警告。
- 最终精确命令 `npm run dev:fixtures --workspace @openbot/web -- --port 5183` 构建并预览成功；默认 5182 预览也通过。隔离 Chrome 在 1440×960 下完整执行六场景，再于 390×844 下拒绝审批；无控制台错误、页面异常、真实 `/api/` 请求或横向溢出。
- 浏览器核实正式审批、故障详情、取消后迟到文本不出现、重复/旧部分输出不倒退、下载 `OpenBot-发布介绍.md` 的固定 Blob 文本，以及断线最终消息只在恢复后由原重试/补读出现。已检查桌面审批、故障详情、离线和窄屏审批截图；修复了夹具 wrapper 与官方 grid 行冲突及 favicon 404。
- 使用已存在 Playwright＋系统 Chrome 的临时新 profile；没有读取用户会话。脚本及截图留在仓库外 `/private/tmp/openbot-client-fixtures-dev-qa.cjs`、`/private/tmp/openbot-fixtures-dev-*.png`。未验证原生 Electron/IPC 或真实 Server/模型。
- 改动文件 Biome、`git diff --check`、文档检查（350 Markdown）与研究检查（17 测试）通过。根据主线交接安排，完整 `npm run check` 由主 Agent 在四条主线汇合后统一执行。
