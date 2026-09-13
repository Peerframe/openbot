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
    build 在需要时都会使用该 meta。真实部署应按请求替换占位符。
  - 固定版本：Vite **8.2.2** / commit `de1111ab0be00879b404e7ed3b2a80e264edddc1`（MIT）
  - 保持 `@vitejs/plugin-react` **6.1.1**；无版本升级
- 已核对：账本中 Vite 8.2.2 条目、`apps/web/index.html` CSP、plugin-app-sandbox（本次范围外）

## 候选比较

| 候选 | 精确版本 / commit | 许可证 | 维护与适配 | 决定 |
| --- | --- | --- | --- | --- |
| Vite `html.cspNonce` + 仅 serve 改写 CSP meta | 8.2.2 / `de1111ab0be00879b404e7ed3b2a80e264edddc1` | MIT | 官方 API，可盖章标签与 meta | **选用**（本地 serve） |
| 在 style-src 加 `'unsafe-inline'` | n/a | n/a | 削弱 XSS 防护；违反“不放宽生产 CSP” | 拒绝 |
| 各模式删除 CSP meta | n/a | n/a | 削弱生产/Desktop | 拒绝 |
| 每请求随机 nonce 的中间件 | 本地 | MIT | 对贡献者 `vite` serve 过重；dev 固定 nonce 可文档化接受 | 延后 |

## 复用决定

- 选择：复用已固定依赖的官方 API + 薄本地 serve 适配
- 上游：Vite 8.2.2 `html.cspNonce` 与 CSP 指南行为
- 为何首选：官方、已锁定；无需 `'unsafe-inline'` 即可匹配注入资源
- OpenBot 差集：serve 时须在 meta CSP 的 `script-src` / `style-src` 写入相同 `'nonce-…'`；Vite 不会替我们改该 `content`
- 升级/退出：继续钉在 8.2.2；若 serve 注入行为变化，可删除本地 transform 或改到真实 HTML 服务的按请求替换
- 失败行为：若 transform 未生效，严格 CSP 下样式仍被拦（fail closed）；build/Desktop 不注册该插件

## 源码引入

- 是否复制或实质改编：否
- 文件：`apps/web/src/dev-csp-nonce.ts`、`apps/web/vite.config.ts`
- 声明：沿用 Vite MIT 包许可证；无需新增 THIRD_PARTY 文本

## 验证计划

- 自动化：transform 单测（style-src/script-src 含 nonce；无 unsafe-inline；生产 `index.html` CSP 不变）
- 可选冒烟：短暂启动 `vite`，确认 HTML 含 CSP nonce 与 `csp-nonce` meta
- 负向：build/Desktop 不得启用 `html.cspNonce` 或改写插件
- 支持等级：本地 web `vite` serve 为 Integrated；生产 CSP 行为不变

## 未决问题

- 本切片无。
