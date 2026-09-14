# 研究：工作空间快照与实时投影的顺序

- 状态：批准实施
- 日期：2026-09-14
- 负责人：OpenBot contributors
- 关联事项：用户批准的架构与流程审查，基准 `3a02750e8851298a1b27246fd1ac4925f319fdc1`
- 验收流程：断线恢复或修改频道成员后，即使较早的工作空间请求较晚返回，已登录工作空间仍保留最新收到的服务端投影。
- 安全边界：成员、授权、审批和路由仍以 Server 为准；仅调整当前挂载界面对已授权响应的呈现顺序，不增加乐观授权、持久化或副作用。

## 检索证据

2026-09-14 检索了 `facebook/react useEffect cleanup race`、`react/react is:open useEffect cleanup`、固定 React 版本、hook 源码、Strict Effects 测试及许可证。核对现有复用台账中的 Web 组件测试、Desktop 频道草稿与发送连续性、频道上下文信息栏、Desktop 统一工具栏与历史记录，以及 `desktop-conversation-continuity.md` 和 `desktop-navigation-continuity.md`。

- [React useEffect](https://react.dev/reference/react/useEffect) 说明在 effect 清理后忽略旧结果及开发模式的重复挂载检查；[Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects) 说明取消或忽略 fetch 结果。
- [React 19.2.8 release](https://github.com/react/react/releases/tag/v19.2.8)，准确提交 [`1dd4ecbdabf826f527fc9a58c05ea70375b7d170`](https://github.com/react/react/commit/1dd4ecbdabf826f527fc9a58c05ea70375b7d170)，与当前依赖相同；该维护版本包含 React Server Components 解码性能修复，本次客户端调整无需升级依赖。
- 固定版本 [ReactHooks.js](https://github.com/react/react/blob/v19.2.8/packages/react/src/ReactHooks.js) 提供基于 dispatcher 的 state、ref 和 effect；[StrictEffectsMode-test.js](https://github.com/react/react/blob/v19.2.8/packages/react-reconciler/src/__tests__/StrictEffectsMode-test.js) 验证清理与重新挂载。它们提供生命周期机制，不规定应用 GET 与 SSE 的数据顺序。
- [问题 24455](https://github.com/react/react/issues/24455) 讨论 fetch 竞态清理；[问题 24502](https://github.com/react/react/issues/24502) 将 StrictMode 开发态重复 effect 归为预期行为。未关闭问题检索还找到[清理顺序问题 30765](https://github.com/react/react/issues/30765)，本实现不得依赖父子清理顺序；检索结果不代表已排除 React 全部未关闭问题。
- [Fetch 标准](https://fetch.spec.whatwg.org/) 提供取消机制。但请求已经解析或不响应取消时，仍需本地 generation 检查阻止旧结果提交。

## 候选比较

| 候选 | 准确版本或提交 | 许可证 | 维护与测试 | 平台、API、安全适配 | 决定 |
| --- | --- | --- | --- | --- | --- |
| 现有 React hooks 与 Fetch 取消 | React 19.2.8，`1dd4ecbdabf826f527fc9a58c05ea70375b7d170`；2026-09-14 查阅 Fetch living standard | [MIT](https://github.com/react/react/blob/v19.2.8/LICENSE)；浏览器标准 | 已检查维护版本、公共 hook 源码和 Strict Effects 测试 | Web/Desktop 已使用；ref 管理请求生命周期，不改变服务端权限 | 通过专用工作空间 hook 复用公共 API |
| 现有 OpenBot run/node 合并函数 | 仓库基准 `3a02750e8851298a1b27246fd1ac4925f319fdc1` | 仓库许可证 | 已有时间戳、状态顺序测试 | 保留任务单调推进与节点投影语义 | 复用，不引入第二套缓存库 |

## 复用决定

- 选择现有依赖和标准，以薄适配层衔接 OpenBot；无新依赖、框架、fork 或复制状态引擎。
- 具体缺口：本地请求需要 generation 全序；实时事件和 mutation 响应需让进行中 GET 的对应实体失效。每个请求的临时 journal 在提交快照前重放这些投影，同一实体保留最新投影，并保留断线后补回的其他实体；无需因事件不断重试 GET。
- 新 GET 取消并使旧 GET 失效；effect 清理和 StrictMode 同样处理。旧成功与旧失败结果均不得覆盖现状。
- journal 只属于当前请求，按实体键保存而不重复累积事件历史；完成、替换或清理时释放。
- 成员增删、频道创建和打开私聊成功后立即投影返回的 Channel，保留原有 API/SSE 契约。
- 后续替换：hook 继续使用现有领域类型。其他缓存实现必须通过事件重放、删除、计数及清理测试后方可替换；未来服务端事件 revision 可进一步简化顺序。
- 失败行为：恢复请求失败时保留已显示数据，通过现有错误界面显示当前请求失败；旧请求不得覆盖数据或错误。

## 源码引入

- 复制或实质改编上游源码：否。使用 React 与 Fetch 公共模式，投影内容为 OpenBot 领域逻辑。
- 版权声明：现有 MIT 依赖声明保持不变，无新增源码声明要求。

## 验证计划

- 使用真实 `AuthenticatedWorkspace` 与真实 API client，HTTP/EventSource 由可控 fixture 提供；先重现逆序响应错误，再修改实现。
- 覆盖 GET 逆序完成、GET 期间的频道 SSE、加入/移除响应即时呈现且后续恢复请求失败、断线后补回其他数据、忽略旧请求失败、StrictMode 与卸载取消。检查用户可见的成员文案和控件，不只检查 hook 内部值。
- 运行定向既有导航/成员测试及 Web TypeScript 检查；主任务执行仓库 check 和真实浏览器/Desktop 验收。JSDOM 仅证明组件与传输顺序，不证明布局、真实网络重连或原生应用行为。
- 仅删除固定 SHA 引用审查确认无用的两份 public pixel-bot 资产与失效 CSS 分支。共享活跃选择器、当前 modular 头像和持久 `appearance` 兼容继续保留；主任务验证引用与生产构建产物。
- 本文与英文版本同步更新。

## 未决问题

- Channel 没有全局服务端 revision。本次保证较新的本地 GET 淘汰旧 GET，且 GET 期间收到的事件在提交后保留；不会假设不同客户端或独立连接间存在可验证的完整全序。更广保证需要服务端 revision。

## 实施验证

- 真实已登录组件测试先在基准代码重现五处失败：GET 逆序完成、进行中 GET 覆盖频道事件、加入/移除响应延迟呈现、已取消的 StrictMode 请求仍回写。
- 实现后九个组件/传输场景通过，同时覆盖真实客户端重连回调、旧失败结果、节点删除与恢复、审批/任务重放。开发中补获并覆盖一项重放回归：合并跳过任务中间分配状态后，完成任务仍必须清除节点占用。
- 定向验证：`App.workspace-state.test.tsx`、`App.navigation.test.tsx`、`ChannelMembersMenu.test.tsx`、`ChannelWorkspace.integration.test.tsx`、`run-state.test.ts` 共 25 项测试通过；Node 26.0.0 下 Web TypeScript 与改动源码 Biome 错误检查通过。原有 CSS specificity 警告不属于本次清理。
- `apps/web/src` 与 `apps/web/public` 内已无被删资产名称及失效 selector 家族的引用。两份 public 资产合计 118,728 bytes（PNG 117,797；SVG 931）。
- 主任务负责全仓检查、生产构建资产确认及真实 Web/Desktop 验证；本地组件测试不声称完成这些验收。
