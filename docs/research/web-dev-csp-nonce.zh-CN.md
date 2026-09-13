# 调研：Web Vite serve 的 CSP nonce（样式）

- 状态：实现前已接受
- 日期：2026-09-13
- 负责人：@yxflc11
- 验收路径：在 `apps/web` 执行 `npm run dev` 时，页面 CSP 通过匹配的 nonce 允许 Vite 注入的
  样式/脚本，`document.styleSheets` 有内容且 UI CSS 生效；生产 `vite build` 与 Desktop
  renderer 仍使用现有严格 meta CSP。
- 安全边界：仅 **dev serve**（`command === 'serve'` 且非 `mode === 'desktop'`）。生产与 Desktop
  的 meta CSP 不引入 `'unsafe-inline'`，也不随产物分发固定 nonce。不改动 plugin iframe sandbox CSP。

## 搜索证据

- 搜索日期：2026-09-13（Asia/Shanghai）
- 查询：`vite html.cspNonce`、`repo:vitejs/vite cspNonce`、Vite CSP 指南
- 一手文档：
  - [Vite `html.cspNonce`](https://vite.dev/config/shared-options.html#html-cspnonce)（类型 `string`）
  - [Vite CSP 功能说明](https://vite.dev/guide/features.html#content-security-policy-csp)：设置后会给
    script/style/link 加 nonce，并注入 `<meta property="csp-nonce" nonce="PLACEHOLDER">`；dev 与
    build 在需要时都会使用该 meta。包括开发环境在内，每次 HTML 响应均需替换占位符。
  - 固定版本：Vite **8.2.2** / commit `de1111ab0be00879b404e7ed3b2a80e264edddc1`（MIT）
  - 保持 `@vitejs/plugin-react` **6.1.1**；无版本升级
- 已核对：账本中 Vite 8.2.2 条目、`apps/web/index.html` CSP、plugin-app-sandbox（本次范围外）

## 候选比较

| 候选 | 精确版本 / commit | 许可证 | 维护与适配 | 决定 |
| --- | --- | --- | --- | --- |
| Vite `html.cspNonce` + 仅 serve 改写 CSP meta | 8.2.2 / `de1111ab0be00879b404e7ed3b2a80e264edddc1` | MIT | 官方 API，可盖章标签与 meta | **选用**（本地 serve） |
| 在 style-src 加 `'unsafe-inline'` | n/a | n/a | 削弱 XSS 防护；违反“不放宽生产 CSP” | 拒绝 |
| 各模式删除 CSP meta | n/a | n/a | 削弱生产/Desktop | 拒绝 |
| 公开固定开发 nonce | 本地 | MIT | 注入脚本可预测；dev 监听全部网络接口并代理真实 Server | 拒绝；撤销初版固定值结论 |
| Vite 占位符 + 最终 `server.transformIndexHtml` 适配 | 同一固定 Vite | MIT | 等待完整上游 HTML 流水线后填入加密随机 nonce，不拦截响应、不加依赖 | 选用 |

## 复用决定

- 选择：复用已固定依赖的官方 API + 薄本地 serve 适配
- 上游：Vite 8.2.2 `html.cspNonce` 与 CSP 指南行为
- 为何首选：官方、已锁定；无需 `'unsafe-inline'` 即可匹配注入资源
- OpenBot 差集：每次响应需使用新 nonce，serve 时须在 meta CSP 的 `script-src` / `style-src` 写入相同 `'nonce-…'`；Vite 不会替我们改该 `content`
- 升级/退出：升级 Vite 时保留真实服务器的 hook 顺序回归测试；上游提供响应 nonce 回调后可删除适配
- 失败行为：CSP meta 缺失、重复或位于 head 之外时，文档转换直接失败；build/Desktop 不注册插件。
  本次覆盖当前标准 Vite 开发流水线；实验性 `bundledDev` 会绕过该上游方法，不宣称支持。

## 固定版本集成核对（修订实现前）

初版由 Grok 编写的 PR #62（`d097c67d426b2dde4a53cf730fdf738a8ff7cd69`）复用了
`html.cspNonce`；本次保留该贡献，替换可预测的字面值。固定 nonce 不能作为开发环境的安全边界。

已核对 [Vite HTML 中间件](https://github.com/vitejs/vite/blob/de1111ab0be00879b404e7ed3b2a80e264edddc1/packages/vite/src/node/server/middlewares/indexHtml.ts)、
[HTML nonce hooks](https://github.com/vitejs/vite/blob/de1111ab0be00879b404e7ed3b2a80e264edddc1/packages/vite/src/node/plugins/html.ts)
与 [dev client CSS 更新](https://github.com/vitejs/vite/blob/de1111ab0be00879b404e7ed3b2a80e264edddc1/packages/vite/src/client/client.ts)。
Vite 会在用户 `order: 'post'` hook 之后补标签 nonce，因此只用 post hook 替换会留下占位符。
现有 HTML 中间件在计算响应头与正文前等待公开的 `server.transformIndexHtml` 方法。
薄 `configureServer` 适配等待该方法完成，每份文档用 Node `crypto.randomBytes(24)` 生成新 nonce，
改写已有应用策略，再填充上游占位符。不会修改共享 Vite 配置，也不改变 CSS/React 转换、HMR
传输、代理路由和 sandbox 中间件。开发 CSP meta 移到 Vite 头部脚本之前，让 React preamble
也受策略约束；生产/Desktop 不注册适配。未复制上游源码。

## 源码引入

- 是否复制或实质改编：否
- 文件：`apps/web/src/dev-csp-nonce.ts`、`apps/web/vite.config.ts`
- 声明：沿用 Vite MIT 包许可证；无需新增 THIRD_PARTY 文本

## 验证证据（2026-09-13）

- `npm exec --workspace @openbot/web -- vitest run src/dev-csp-nonce.test.ts --maxWorkers=1`：
  13 项测试通过。真实 Vite 8.2.2 HTTP 服务覆盖 `/`、SPA 路由、`/?query=1` 和
  `/index.html?query=1` 的八个并发响应；每份响应使用不同的 192 位 nonce，同份 CSP、
  Vite nonce meta、React preamble、模块脚本以及 late hook 注入的 style/link 均匹配。
  共享配置仍为占位符，ETag 重验返回新 nonce 和正文。策略缺失、重复、错位以及 head 缺失
  均失败关闭。真实 sandbox 路由与 `pluginProxyDocument()` 逐字节一致。生产/Desktop 配置不含适配。
- `npm run typecheck --workspace @openbot/web`、`npm run build --workspace @openbot/web` 和
  `npm run build:desktop --workspace @openbot/web` 通过。检查两个实际输出目录各八个文件：
  入口 CSP 等于严格源码策略，所有输出均不含开发占位符或旧固定 nonce，生成的 sandbox 文件一致。
- 当前无 Browser 插件，使用已有的 Playwright 1.62.1 与无头 Chromium **149.0.7827.55**，
  未安装或增加依赖。隔离 fixture 使用真实 web Vite 配置、源码 `index.html`、合成 React
  计数器和本地 CSS。没有 Owner 数据、凭据、Server 请求或原生桌面操作。临时 fixture 已移除；
  可复现脚本、日志与截图保存在仓库外。
- 在 `http://127.0.0.1:57494`、1280 × 900 下，初始 computed background 为
  `rgb(20, 90, 140)`、padding 为 `24px`，一张样式表使用响应 nonce。点击后显示 `Count 1`。
  修改 CSS 通过 HMR 将背景变为 `rgb(180, 60, 30)`；修改 React 部件后标题更新、计数仍为 1。
  恢复两个文件后初始外观恢复，全程文档身份与 nonce 不变，证明未整页重载。390 × 844 下
  恢复后的 fixture 无横向溢出。已检查初始、更新与移动截图。
- 没有页面异常、框架错误浮层或 `securitypolicyviolation` 事件。Chromium 仍报告已有的
  `frame-ancestors` 在 meta CSP 中被忽略的提示；本次不宣称该指令提供框架保护，也不改它。
  Vite 仍显示已有的配置 import 扩展名迁移提示，均未屏蔽。

- 同一无头 Chromium 在 1280 × 900、`http://127.0.0.1:57750` 加载真实入口
  `apps/web/src/main.tsx`。测试中间件对两次 auth-session 读取返回 `{ authenticated: false }`，
  并在 Vite 代理之前阻断其余 API/health 请求；没有请求到达真实 Server。真实登录页加载 18 张
  样式表且 nonce 全部匹配。`.login-card` computed width 为 `420px`、padding 为
  `38px 40px 34px`、圆角为 `14px`、背景为白色，与产品样式表相符。已检查截图：无空白、
  错误浮层、横向溢出、页面异常或 CSP 违规，仅有原 `frame-ancestors` meta 提示。
  此检查未修改产品源码。
- 完整 `npm run check` 通过：Web 58 个测试文件、300 项测试通过，包含 13 项 CSP 回归。
  其余 workspace 测试和构建通过或复用匹配的 Turbo 缓存。现有平台/数据库相关跳过保留，
  308 条现有 lint 警告与 4 条提示未改动。记录证据后再次运行文档和研究检查。

## 验证边界

本次证明所测 Chromium 的标准 Vite 开发 nonce/CSS/React HMR 路径，以及真实生产/Desktop
产物核对；不代表完整 Owner 流程、跨浏览器一致性、原生 Desktop GUI 或实验性 bundled dev 验收。
