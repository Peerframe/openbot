# 调研：React 19.3 版本一致性

- 状态：已接受；合并前仍须通过当前提交的 CI
- 日期：2026-09-15
- 负责人：@yxflc11
- 关联问题：#75
- 验收路径：全新安装后导入真实 React 客户端和服务端渲染器，并通过现有 Web 交互测试及 CI 平台检查。
- 安全边界：仅维护依赖；Server 授权、渲染器隔离、生产审计和现有 CI 门禁保持有效。

## 搜索证据

2026-09-15 搜索 `repo:react/react is:issue is:open 19.3.0`，检查官方 `v19.3.0` 发布、标签、源码树、渲染器版本保护、DOM/服务端集成测试与 MIT 许可。官方文档检索词为 `site:react.dev warnings version mismatch react react-dom exact same version` 和 `site:docs.github.com dependabot groups react react-dom patterns`。

查阅复用账本中的 Web 交互测试、Desktop 基础及 9 月 12 日依赖记录。PR #75 的 [失败运行 34935896797](https://github.com/Peerframe/openbot/actions/runs/34935896797) 在 Linux、macOS、Windows 均报 `react` 19.3.0 与 `react-dom` 19.2.8 不匹配。旧 npm peer 范围容许较新的 React 次版本，但上游导入保护要求运行时版本精确相同，故应修复依赖组合。

## 候选比较

| 候选 | 精确版本或提交 | 许可 | 维护与测试 | 平台/API/安全适配 | 结论 |
| --- | --- | --- | --- | --- | --- |
| React 与 React DOM | 19.3.0 / `1d34f91dfde6bba84d08b683aaba164c7194dacb` | MIT | 2026-09-09 官方稳定版；检查版本保护与 DOM/服务端渲染测试 | 延续浏览器/Electron 渲染器；匹配运行时版本，不增加能力 | 采用已发布依赖 |
| React 类型声明 | `@types/react` 19.3.0；现有 `@types/react-dom` 19.2.7 | MIT（DefinitelyTyped） | 已发布声明；项目类型检查和交互测试验证实际调用 | 仅开发期；声明的补丁/次版本不必与运行时相同 | 保留 PR 升级和兼容的 DOM 声明 |
| GitHub Dependabot groups | 2026-09-15 查阅官方 `groups`/`patterns` 契约 | GitHub 文档条款 | 官方维护的托管配置，支持精确依赖名称匹配 | 只将 React、React DOM 及对应声明纳入版本更新组 | 复用现有选项 |
| 绕过保护、渲染器分叉或更换框架 | 未选定 | 不适用 | 破坏已有不变量或引入无关迁移 | 当前不存在需要这些方案的功能缺口 | 拒绝 |

## 复用决定

优先采用官方已发布依赖。将 `react-dom` 精确固定到 19.3.0，使用仓库指定的 npm 10.9.9 更新锁文件。未来版本更新把 React、React DOM 和两项类型声明放入单一窄范围 Dependabot 组，减少拆分提案；运行时版本保护和现有 CI 继续检验实际兼容性。

OpenBot 只缺依赖选择的一致性，无须本地渲染实现。今后共同审查和升级运行时组合；真实测试失败时整体回退。保留锁文件完整性与生产审计。缺失或不兼容包须在安装、导入、构建或 CI 中失败，不能绕过保护；依赖安装和渲染不授予 Server 权限。

## 源码纳入

未复制或实质改编上游源码。仅改 Web 依赖清单、锁文件、Dependabot 配置以及双语研究/复用记录。保留 React、React DOM、scheduler 和 DefinitelyTyped 包分发的 MIT 许可。

## 验证计划

全新 npm 10.9.9 安装，检查实际运行时与声明版本；运行现有客户端/服务端渲染及交互测试、类型检查、生产审计和完整 `npm run check`。不改变现有负向和失败关闭测试，包括 Server 授权与原生安全断言。结合本地 macOS 与现有 Linux x64、macOS arm64、Windows x64 CI，不能据此扩大平台或无障碍支持声明。

## 已知问题与限制

开放问题检索返回 #37614（Next.js ViewTransition 导航）、#37560（Flight 解码）、#37556（`act` 下 Suspense 重试）、#33038（可定制 select 水合）和 #37551（挂起的 head 水合）。本修复不采用 Next.js、Flight、水合或新转场 API；仍须通过现有交互测试来发现可能的 `act` 回归。检索不能证明上游没有缺陷。只查阅上游测试源码，未本地运行全部上游测试。

精确源码、发布、npm 和官方配置链接见[英文证据记录](react-19.3-version-coherence.md#primary-sources)。

## 本地验证结果

2026-09-15，全新 npm 10.9.9 安装通过；实际依赖树仅有一组 React/React DOM 19.3.0 与 scheduler 0.28.0；生产审计报告零漏洞。macOS arm64、Node 22.23.2 下完整 `npm run check` 通过：Web 的 59 个文件、329 项测试全部通过；Desktop 的 38 个文件、359 项测试通过，保留一项原有平台跳过。Server/Node 原有环境依赖测试继续由对应托管任务验证。初次沙箱执行因原生进程身份检查与临时编译权限受限而失败，在允许这些系统操作后重跑完整检查通过。当前提交的托管 CI 仍须单独通过。
