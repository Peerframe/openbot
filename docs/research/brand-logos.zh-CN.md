# 模型服务商和插件使用真实图标

[English](brand-logos.md) · 简体中文

- 状态：已实现（第 38 步）
- 日期：2026-10-05
- 负责人：@yxflc11
- 相关需求：所有者 2026-10-05 要求「Gmail 和模型这些图标用上真实的图标」
- 验收路径：「设置 › 模型服务」、模型对话框、插件面板、@ 列表和侧栏「插件」按钮，已知服务显示真实图标；
  不认识的服务仍显示首字母。
- 安全边界：只影响显示。图标只标明模型连接或插件对应的服务，不授予任何权限，不改变路由，由客户端里的固定表
  选择。运行时不下载任何图标，全部打包，从 `self` 或 `data:` 加载（沿用现有 CSP）。

## 触发原因与已有决定

- 触发：新增依赖。
- 已有决定：`ModelConnectionsDialog.tsx` 用字母方块，理由是「OpenBot 不附带第三方标志」。设计稿 README 已经
  写明设置画板上九个服务商图标用 `@lobehub/icons-static-svg`。现在所有者要求换成真实图标。
- 范围：`packages/domain/src/model-providers.ts` 里的 11 个服务商预设，以及按名称或地址识别的 10 个常见插件
  服务。其他插件保留首字母。

## 检索依据

- 检索日期：2026-10-05。
- 检索词：在 npm 和 GitHub 搜索 "AI provider logo svg"、"brand logos svg CC0"、"simple-icons"、
  "lobe-icons"、"svg-logos"；逐个核对许可、发布日期和包内内容。
- 已核对：`OPEN_SOURCE_REUSE.md` 没有图标条目；设计稿 README 指定服务商图标用 LobeHub。

## 方案比较

| 方案 | 版本 | 许可 | 维护情况 | 适配 | 结论 |
| --- | --- | --- | --- | --- | --- |
| LobeHub 图标（`@lobehub/icons-static-svg`） | 1.95.1，gitHead `49a2130d` | MIT | 2026-09-21 发布；AI 服务商图标的通用来源 | 11 个预设都有彩色和单色版；静态 SVG，只引入用到的 | **服务商采用** |
| SVG Logos（`@iconify-icons/logos`） | 2.0.2（上游 `gilbarbara/logos` `37a6b807`） | CC0-1.0 | 2026-09-28 发布 | Gmail、Drive、日历、Slack、Notion、Discord、Figma 的现行彩色标志；每个图标一个模块，只打包用到的十个 | **插件采用** |
| Simple Icons（`simple-icons`） | 16.34.0 | CC0-1.0 | 2026-10-04 发布 | 只有单色；应品牌方要求删掉了 Slack | 不采用：Gmail、Drive 会失去原本的颜色 |
| 自己画或复制 SVG | — | — | — | 不准确，维护负担大 | 不采用 |

## 复用决定

- 采用：两个已发布的依赖，在 `apps/web/package.json` 里固定确切版本。
- OpenBot 自己的部分：一个小映射表（`components/BrandMark.tsx`），把服务商预设 id、插件名称或地址对应到图标；
  单色图标用 CSS 蒙版按文字颜色绘制，深色模式下仍然可见。
- 升级或替换：只需改这一个文件的引入；删掉某个映射就回到首字母方块。
- 失败时：不认识的服务或缺失的图标显示首字母，和以前一样。

## 源码引入

- 复制或大幅改编源码：否。图标在构建时从包中引入。
- 许可声明：`licenses/runtime/lobehub-icons-static-svg/LICENSE`（MIT；npm 包里没有，按包的 gitHead 取自仓库），
  以及 `licenses/runtime/iconify-icons-logos/`（包内声明和 CC0 全文），校验值记在 `sources.json`。
- 商标仍归各自所有者；图标只用来标明所连接的服务。

## 验证

- 自动测试：插件面板、模型服务、@ 列表、侧栏的现有组件测试不变通过（可见名称没变）；类型检查覆盖引入。
- 手动：设计预览中截取「设置 › 模型服务」、模型对话框、「设置 › 插件」（浅色和深色）、@ 列表和侧栏。
- 支持级别：已接入（网页和桌面共用同一构建）。

## 未决问题

- 无。
