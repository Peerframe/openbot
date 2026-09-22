# 研究：工作区活跃任务数的权威校准

- 状态：实现前已接受
- 日期：2026-09-22
- 维护者：OpenBot maintainers
- 对应主线：C3
- 验收流程：最近 50 条之外的任务更新或完成后，官方共享工作区 hook 从 Server 重新校准全局活跃数，保留即时实体更新，不产生无限刷新。
- 安全边界：已鉴权 GET 保持权威；没有新接口、写入、凭据、原生 bridge 或界面统计声明。读取失败保留数据，通过既有错误状态报告。

## 检索证据

已读复用清单中的有序工作区状态、C1 一致性快照、Web 交互测试与 React 版本一致性条目，以及 `workspace-state-refactor.md`、`workspace-snapshot-stream.md`、`react-19.3-version-coherence.md`。本地核查基线 `86223c6` 的共享 hook/API、频道读取回调、C1 GET reader 和工作区测试。

2026-09-22 的 GitHub 查询包括 `facebook/react 19.3.0`、`repo:TanStack/query invalidateQueries cancelRefetch`；核查上游 Query 讨论 [7180](https://github.com/TanStack/query/discussions/7180)，其中维护者解释了在请求进行中直接跳过新失效信号可能丢失后续更新。主要文档为 [React Effect 清理和数据读取](https://react.dev/reference/react/useEffect)、[Fetch 取消](https://fetch.spec.whatwg.org/#abort-fetch)、[QueryClient 失效/重读 API](https://tanstack.com/query/latest/docs/reference/QueryClient)。

本次重新核对声明、lockfile 和实际安装，React/React DOM 均为 **19.3.0**，不是原 hook 研究中的 19.2.8；后续 runtime coherence 研究仍适用。通过 GitHub API 检查固定提交的 `ReactHooks.js`、`StrictEffectsMode-test.js`，复用已有 MIT/发布审查。

另比较维护中的 [TanStack Query `release-2026-09-22-1338`](https://github.com/TanStack/query/releases/tag/release-2026-09-22-1338)，提交 `8884f1a4d9ee53cb3cdba26ca28f870500ede3f7`：检查 `queryClient.ts`、`queryClient.test.tsx` 的失效/取消覆盖和 MIT 许可。没有复制源码或新增依赖。

## 候选比较

| 候选 | 固定版本或提交 | 许可 | 维护、测试和边界适配 | 决定 |
| --- | --- | --- | --- | --- |
| React hooks 与浏览器 Fetch/计时器 | React/React DOM 19.3.0，`1d34f91dfde6bba84d08b683aaba164c7194dacb`；2026-09-22 查阅的 Fetch 标准 | MIT；WHATWG 条款 | 当前锁定版本；核查生命周期源码、Strict Effects 测试，适用现有浏览器/Electron renderer | 复用标准和现有依赖 |
| 有序工作区 hook 与一致性 GET | OpenBot `86223c6` | MIT | 既有测试覆盖旧响应、实体 journal、操作返回及重连；保留授权、domain 与 Desktop 代理路由 | 扩展窄范围调度入口 |
| TanStack Query | 上述发布 / `8884f1a4d9ee53cb3cdba26ca28f870500ede3f7` | MIT | 维护中的发布与取消测试；讨论 7180 指出在途失效风险；默认取消或跳过策略仍需业务合并约定 | 本次不迁移整个工作区缓存 |

## 复用决定

确切缺口是全局计数：50 条近期任务无法判断缺席任务是否已包含在 Server 总数中，本地事件加减会重复计算活跃任务或漏减已完成任务。仅调整 `counts.activeRuns` 的来源，实体、主机占用、审批和近期列表继续即时投影。

复用 generation、AbortController、请求内实体 journal 和 `GET /api/v1/workspace`。任务投影只使计数待校准，不改总数。一个 dirty 标记和一个计时器合并事件，事件触发的请求间隔至少一秒，至多一个当前请求及一个后续待读标记。成功读取期间收到新事件，结束后补一次新读取；实体 journal 重放不改总数，也不触发新读取。

显式刷新/重连保留取消替换语义并吸收排队失效。即使旧请求忽略取消，generation 仍拒绝其晚到结果。失败报告既有错误并停止自动后续读取；下一个事件、显式刷新或重连可重试。没有轮询；清理阶段清除计时器、取消并作废请求，包括 StrictMode。

不新增事件缓存。同一突发中的重复事件共享一个 dirty 标记；已结束读取之后再次收到外部重复事件，可以请求另一次有界补读，但不会更改计数。这样不会因永久记住事件版本而阻止读取失败后的恢复。

当前 ContextRail 的指标明确对应近期已加载记录，不渲染全局计数；保持其 UI 不变。通过渲染测试组件读取正式 hook 的公开快照，并保留真实已登录工作区测试验证实体/连接行为。C2 隔离适配器并不覆盖本 hook，不能替代这些测试。

将来明确全量快照与即时操作返回的关系后，可用 snapshot stream 替代 GET 调度。本次不增加持久版本、跨流总序、快照流迁移或 Desktop 生命周期范围。

## 源码使用

没有复制或大幅改编上游源码。直接复用 OpenBot hook/helper 与公开 React/Fetch API；现有 MIT 依赖声明不变。

## 验证计划

- 先在基线复现页面外任务更新/完成，再覆盖重复突发、GET 已包含事件、慢读取期间失效、一次后续读取、频率/并发上限、失败保留且无循环、显式刷新替换和卸载取消。
- 保留真实 `App.workspace-state.test.tsx` 重连、journal、审批/主机占用与 StrictMode 回归，以及附近频道/导航/任务状态测试。
- 执行 Web 类型检查、改动文件 Biome、文档/研究检查和本分支 `npm run check`；确定性检查无需模型、私人账户或真实 Server。
- 同步 `WORKSPACE_SYNC.md` 与中文说明。不新增布局或原生平台支持声明。

## 尚未覆盖

完整 snapshot stream 接入、Desktop 连接槽位和没有旧事件通知的变更仍为后续工作。全局计数在 GET 完成前可能落后于实体更新，但始终是最后一次权威观察，不是估算值。

## 验收证据

- 基线运行的 10 个新 hook 场景有 8 个失败。页面外活跃任务一次投影将权威数从 7 改为 8；相同事件重复 200 次变为 207；页面外完成事件没有安排补读。这是实测状态错误，近期记录界面并未声称展示该全局值。
- 修复后六文件 36 项定向测试通过：10 个真实 hook 渲染测试、1 个真实 `AuthenticatedWorkspace` 双流重复事件测试，以及原有 25 个排序/导航/频道/任务状态回归。失败保留测试使用比近期 50 条更新的记录，以符合原有列表可见性契约。
- Web 类型检查、改动文件 Biome 和 `git diff --check` 通过。本分支完整 `npm run check` 通过：Web 63 文件/368 测试，Desktop 38 文件/359 通过与1个既有跳过，Server 547 通过与75个既有环境条件跳过；其余工作区检查/构建通过或命中相同 Turbo 缓存。这些跳过不证明真实数据库或原生 OS 合规。
- 全量日志留在仓库外 `/private/tmp/openbot-client-counts-check.log`。中英文契约及研究通过文档检查。既有 Vite 配置扩展名/chunk-size 和 JSDOM `<search>` 警告不属于本改动。
- 本次未修改或声称新增验证 UI 布局、原生 IPC 或真实 Server/模型流程。完整快照流迁移与无事件通知的恢复仍为后续工作。
