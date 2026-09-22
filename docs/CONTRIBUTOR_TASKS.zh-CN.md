# 贡献者任务包

当前独立主线、依赖与验收入口见 [开发主线](DEVELOPMENT_TRACKS.zh-CN.md)；一致快照及独立订阅基础已实现，见 [快照契约](WORKSPACE_SYNC.zh-CN.md)。持久全局版本与现有 Web 乐观投影迁移仍待完成。

[English](CONTRIBUTOR_TASKS.md) · [简体中文](CONTRIBUTOR_TASKS.zh-CN.md)

这些任务把路线图拆成可以独立审查的贡献。实现前请使用对应表单创建 Issue，链接固定版本的上游
调研，并把支持声明限制在测试真正证明的最低等级。

## 已交付：全新克隆的开发流程验收

状态：已实现并本地验证。[贡献者冷启动](CONTRIBUTOR_JOURNEY.zh-CN.md) 使用合成配置，运行真实 Server/Web 登录、可选 Node 登记及保留身份重启。CI 在构建前运行同一命令；尚未验证远端托管执行。

- **结果：**同一条本地/CI 路径证明全新克隆能启动 Server/Web、登录、按需登记开发 Node，
  并使用保留身份重启。
- **路径：**`CONTRIBUTING.md`、`scripts`、`.github/workflows/ci.yml`、已有认证及 Node 测试。
- **先调研：**复用当前固定 Node/npm/PostgreSQL 与生命周期测试，比较已有 CI 服务就绪检查，
  再决定是否需要新的运行入口。
- **验收：**全新私有测试目录、合成凭证、无付费模型或用户档案；失败说明缺少哪个服务；
  结束清理进程与测试数据。
- **不包含：**发布安装包、新 Provider 或只有负责人才能使用的搭建服务。

## 已交付：保留旧数据的迁移回归

状态：已在本地实现并接入 database CI job。`npm run test:upgrade` 验证固定到 `0018_automations` 的 15 张表历史样本；尚未验证远端托管 CI 执行。见[数据库指南](DATABASE.zh-CN.md#保留旧数据的升级回归)。

- **结果：**贡献者可以验证既定旧迁移升级后，已有外观、员工模板、导入凭证与自动任务记录
  完整保留。
- **路径：**`packages/db`、`scripts/verify-database.mjs`、现有 CI database job 和
  [手写迁移指南](DATABASE.zh-CN.md)。
- **先调研：**复用[流程调研](research/developer-workflow-refactor.zh-CN.md)中已审查的
  Drizzle/Postgres.js 与 PostgreSQL 事务语义。
- **验收：**测试样本保留在仓库；明确测试集、环境变量和专用库映射；验证并发/重复迁移、
  旧行一致、约束保留，以及保留已应用迁移的代码回退；指定测试缺少环境时明确失败。
- **不包含：**改写历史迁移，或宣称完成跨机器全量恢复。

## 后续研究：一致的工作区快照契约

状态：一致快照、权威计数和正式 Web/Desktop 订阅已实现；持久全局顺序契约尚未实现。详见 [快照契约](WORKSPACE_SYNC.zh-CN.md) 与 `npm run test:workspace`。序号只属于各自连接，操作顺序屏障保留即时投影。

- **结果：**明确快照版本与计数语义，使其他客户端不必重新猜测 Web 的事件合并规则。
- **路径：**Server 工作区查询/事件、`packages/domain`、`packages/protocol` 和
  `apps/web/src/use-workspace-state.ts`；见[工作区调研](research/workspace-state-refactor.zh-CN.md)。
- **先调研：**比较维护中的带版本快照/事件 API 和 PostgreSQL 快照隔离；修改接口前写 ADR。
- **验收：**确定性复现分别读取计数、近期列表以外的活动 Run、重复事件和重连；实现前说明
  兼容行为。当前 Web 已显示 Server 权威的 `counts.activeRuns` 字段。
- **不包含：**新增全局客户端缓存框架，或把 Server 权限移到浏览器。

## 入门：创建 Bot 对话框模态生命周期回归

- **目标：**证明现有「创建 Bot」原生模态符合无障碍基线中对 Owner 创建对话框的声明。
- **已有行为：**`CreateBotDialog` 通过 `useModalDialog` 打开，使用 `aria-labelledby` 标注对话框，
  图标关闭按钮名为 `关闭`，创建失败以 `role="alert"` 提示，关闭后恢复 opener 焦点。
- **回归/文档缺口：**没有 `CreateBotDialog.test.tsx`；目前只有
  `AttachmentsManager.test.tsx` 覆盖 Escape / opener 焦点恢复。`docs/ACCESSIBILITY.zh-CN.md`
  手工检查清单仍未写明创建 Bot。
- **入口文件：**`apps/web/src/components/CreateBotDialog.tsx`、
  `apps/web/src/components/useModalDialog.ts`、`apps/web/src/test/render-component.tsx`、
  `docs/ACCESSIBILITY.md`（若改检查清单则同步 `.zh-CN.md`）。
- **前置条件：**根目录 `package.json` 的 Node 引擎；`npm ci`；不需要 PostgreSQL、付费模型或
  Desktop。
- **命令：**
  ```bash
  npm exec --workspace @openbot/web -- vitest run src/components/CreateBotDialog.test.tsx
  npm --workspace @openbot/web run typecheck
  npm run docs:check
  ```
- **验收反例：**Escape / `cancel` 后对话框仍挂载；关闭后焦点未回到 opener；图标关闭缺少
  `aria-label`；`onCreate` 失败未以 `role="alert"` 呈现。
- **不包含：**axe/Playwright CI 门禁；创建频道或导入/导出对话框；WCAG 合规声明。
- **依赖：**仅现有 Web Vitest/jsdom。调研：
  [contributor-starter-slices](research/contributor-starter-slices.zh-CN.md)。

## 入门：员工主页 Tab 键盘 DOM 回归

- **目标：**证明主页水平 Tab 在 `docs/ACCESSIBILITY.zh-CN.md` 已记录的按键下，**焦点与选中态
  一起移动**。
- **已有行为：**`EmployeeProfileView` 提供一个 `tablist`、七个 tab，以及带环绕的
  `profileTabForNavigationKey`（ArrowLeft/ArrowRight/Home/End）。
- **回归/文档缺口：**`EmployeeProfileView.test.tsx` 只覆盖静态 markup 与纯导航函数，没有在
  聚焦的 tab 上派发 keydown 并同时断言 `aria-selected` 与 `document.activeElement`。
- **入口文件：**`apps/web/src/components/EmployeeProfileView.tsx`、
  `apps/web/src/components/EmployeeProfileView.test.tsx`、
  `apps/web/src/test/render-component.tsx`、`docs/ACCESSIBILITY.md`。
- **前置条件：**`npm ci`；仅 jsdom Vitest。
- **命令：**
  ```bash
  npm exec --workspace @openbot/web -- vitest run src/components/EmployeeProfileView.test.tsx
  npm --workspace @openbot/web run typecheck
  ```
- **验收反例：**ArrowRight 改变了 `aria-selected` 但焦点/tabIndex 仍留在旧 tab；Home/End 在两端
  不环绕；ArrowDown 激活了某个 tab（必须保持无操作）。
- **不包含：**屏幕阅读器矩阵；强制色/重排证据；新的主页 Tab 或编辑器。
- **依赖：**无。调研：[contributor-starter-slices](research/contributor-starter-slices.zh-CN.md)。

## 入门：RunInspector Escape 与焦点恢复回归

- **目标：**锁住 `RunInspector` 自定义浮层已经实现的 Escape 关闭与 opener 焦点恢复。
- **已有行为：**挂载时聚焦带标签的关闭按钮，监听 Escape 调用 `onClose`，卸载时恢复先前焦点
  （`role="dialog"`、`aria-modal="true"`）。
- **回归/文档缺口：**`RunInspector.integration.test.tsx` 只测协作子 Run 接线；Escape/焦点未测。
  `docs/ACCESSIBILITY.zh-CN.md` 仍把该浮层列为需完整原生 dialog 审查的已知缺口（迁移仍属中级）。
- **入口文件：**`apps/web/src/components/RunInspector.tsx`、
  `apps/web/src/components/RunInspector.integration.test.tsx`（或同级聚焦测试）、
  `docs/ACCESSIBILITY.md`。
- **前置条件：**`npm ci`；jsdom 回归不需要 Server 进程。
- **命令：**
  ```bash
  npm exec --workspace @openbot/web -- vitest run src/components/RunInspector.integration.test.tsx
  npm --workspace @openbot/web run typecheck
  ```
- **验收反例：**Escape 未调用 `onClose`；卸载后焦点落在无关节点；关闭按钮没有可访问名称。
- **不包含：**迁到原生 `<dialog>`；Tab 焦点陷阱重设计；axe CI；WCAG 合规声明。
- **依赖：**无。调研：[contributor-starter-slices](research/contributor-starter-slices.zh-CN.md)。

## 入门：Node 管理对话框模态生命周期回归

- **目标：**证明 Node 管理 Owner 对话框与其他创建/管理对话框使用同一套原生模态生命周期。
- **已有行为：**`NodeManagerDialog` 通过 `useModalDialog` 挂载 `<dialog>`，并在
  `NodeIdentityList` 中展示吊销确认文案。
- **回归/文档缺口：**`NodeManagerDialog.test.tsx` 只测身份列表静态 markup 与展示状态辅助函数；
  从未打开对话框、触发 `cancel` 或断言 opener 焦点恢复。
- **入口文件：**`apps/web/src/components/NodeManagerDialog.tsx`、
  `apps/web/src/components/NodeManagerDialog.test.tsx`、
  `apps/web/src/components/useModalDialog.ts`、`apps/web/src/test/render-component.tsx`。
- **前置条件：**`npm ci`；沿用现有测试中的合成 Node 身份 fixture。
- **命令：**
  ```bash
  npm exec --workspace @openbot/web -- vitest run src/components/NodeManagerDialog.test.tsx
  npm --workspace @openbot/web run typecheck
  ```
- **验收反例：**从未调用 `showModal`；Escape 后对话框仍在树中；关闭后焦点未回到 opener；挂载
  回归中丢失现有吊销确认文案断言。
- **不包含：**持有证明 Node 身份；登记令牌 UX；Windows/macOS Keychain 改动。
- **依赖：**无。调研：[contributor-starter-slices](research/contributor-starter-slices.zh-CN.md)。

## 中级：无障碍回归检查器

- **结果：**构建后的 Web 应用可在 CI 中重复检查键盘、名称/角色/状态和高置信 WCAG 回归。
- **路径：**`apps/web`、`.github/workflows`、`docs/ACCESSIBILITY.md`。
- **先调研：**比较 `axe-core`、Playwright 无障碍工具和维护中的 Vitest 集成，固定版本与许可证。
  优先完成上方入门对话框/Tab 回归，再选择仓库级 runner。
- **验收：**确定性本地命令、CI Artifact、无实时网络、记录误报，并用一个故意违规 fixture 证明
  门禁会失败。
- **不包含：**只凭自动化就宣称屏幕阅读器或 WCAG 合规；取代上方聚焦入门回归。

## 中级：翻译一致性检查

- **结果：**英文原文与维护中的语言文件不会静默丢失安全警告、命令或配置名。
- **路径：**`scripts/check-docs.mjs`、`README*.md`、`docs/*.md`。
- **先调研：**增加本地规则前先比较文档 lint 与本地化一致性工具；复用现有本地链接检查，不得削弱
  `docs:check`。
- **验收：**fixture 缺少警告/链接时必定失败，输出具体文件与缺少契约，不调用机器翻译。
- **不包含：**判断译文文采或自动改写翻译。

## 已交付基础：Provider 一致性 runner

- **已交付：**`@openbot/provider-conformance-runner` 执行有界且确定性的场景生命周期，丢弃原始
  异常值，始终尝试 cleanup，应用明确的预期失败基线，并以私有权限创建新的 JSON 证据文件且
  拒绝覆盖。
- **路径：**`packages/provider-conformance-runner`、`packages/provider-sdk`、Provider 集成测试和
  `.github/workflows`。
- **调研基线：**固定版本的 MCP Conformance、OCI runtime-tools、Sonobuoy 与 Vitest；见
  [runner 调研记录](research/provider-conformance-runner.md)。
- **后续贡献：**为具体 Provider 编写密闭测试集，把报告 Artifact 接入托管矩阵，并在受控的
  Windows、macOS、Linux 真实设备上运行明确的测试集。
- **必须保持：**Artifact 不含原始秘密；预期失败仍然不一致且必须过期；真实设备元数据必填；
  runner 不能自行认证平台。
- **仍不包含：**托管认证服务或由本仓库部署真实设备 CI 集群。

## 中级：Agent Skills 隔离检查 Worker

- **结果：**隔离 Worker 使用官方 `skills-ref` 检查有大小上限的技能目录，不安装、不执行。
- **路径：**新检查 Provider/Worker，不能放在 Server 进程内。
- **先调研：**Agent Skills 验证器、OpenClaw 隔离指导、归档解压库和沙箱方案。
- **验收：**路径穿越、符号链接、解压膨胀、未知文件、非法元数据和验证器失败全部 fail closed；
  Server 只收到有界报告。
- **不包含：**激活、主机授权、自主执行技能或网络访问。

## 已完成基线：签名员工包设计

- **已交付：**ADR-0014 与 ADR-0024 定义签名信封、加密本地密钥库、显式信任、轮换、撤销和
  `openbot.employee/v1` 离线验证。
- **路径：**`docs/decisions`、`apps/server/src/employee-package.ts`、`packages/domain`。
- **先调研：**Sigstore、in-toto、DSSE、TUF 和现有 Agent 包签名方案。
- **待共建：**系统钥匙串/KMS 适配、发布密钥过期、TUF 连续信任和公开身份/透明度，且不得改变
  DSSE 员工包契约。
- **仍不包含：**激活或所有权转移。

## 已完成基线：审核后激活员工

- **已交付：**只有准确预览摘要、Owner 明确命令、候选禁用技能和不可变幂等收据，才能把隔离
  预览变成新的本地员工。
- **路径：**`apps/server`、`packages/db`、`apps/web`。
- **调研基线：**Backstage 预览/审核/创建、Kubernetes dry-run 和 OpenClaw 第三方技能默认不可信；
  参见 ADR-0025。
- **后续贡献：**包家族更新、注册表分发、选择性记忆复制、更完整的收据检查和认证所有权转移。
- **必须保持：**新员工 ID、技能默认禁用、没有记忆或主机绑定、完全相同重试幂等，内容变化或
  重复激活 fail closed。

## 已完成基线：Owner 管理员工记忆

- **已交付：**仅 Owner 可用的有界新增/编辑/删除、乐观 revision、凭据值阻止、正文物理删除、
  无内容生命周期审计和可访问员工主页编辑器；每个 v1 员工包仍固定包含零条记忆。
- **路径：**`apps/server`、`apps/web`、`packages/protocol`、`packages/db` 与 ADR-0026。
- **调研基线：**Hermes、Letta、Mem0 与 LangMem；见
  `docs/research/owner-managed-employee-memory.md`。
- **待共建：**检索、保留、自主提案审核、提示注入防护、版本恢复、脱敏和选择性导出。
- **必须保持：**Server 是唯一权威；模型与工作主机不能写 Owner 记录；秘密只能保存引用；
  审计永远不能保留标题、正文或正文哈希。

## 已完成基线：Owner 管理员工主页详情

- **已交付：**经过认证的职责/简介编辑、严格字段上限、PostgreSQL compare-and-swap revision、
  无正文进化/SSE 元数据、多设备旧草稿审核，以及经过安全扫描的员工模板简介迁移。
- **路径：**`apps/server/src/postgres-store.ts`、`apps/web/src/components/EmployeeProfileView.tsx`、
  `packages/protocol`、`packages/db` 和[调研记录](research/owner-employee-profile-details.md)。
- **调研基线：**Hermes profile 编辑/UI metadata CAS 与 Kubernetes `resourceVersion`。
- **待共建：**分别审查并实现显示名、模型/Provider、工作主机、例行任务和组合外观编辑器。
- **必须保持：**主页文字不能授予权限；旧写入返回冲突；审计/实时事件不携带简介正文；导入包
  仍生成新的本地身份。

## 高级：每 Node 独立注册

- **结果：**把当前可单独吊销的 bearer credential 升级为可轮换、具有持有证明的工作主机身份。
- **路径：**`apps/server`、`apps/node`、`packages/protocol` 和部署文档。
- **先调研：**SPIFFE/SPIRE、mTLS 引导、短期证书轮换与设备注册威胁模型。
- **验收：**保留单次登记与吊销；增加不可导出密钥支持、挑战应答、轮换、防重放测试、Server
  审计，并且 Node 不开放公网端口。
- **不包含：**员工身份或操作系统账户创建。

## 平台：Windows、macOS 或 Linux 原生 Provider

- **结果：**一个窄原生 Provider 通过真实目标平台证据从 Declared 提升到 Integrated。
- **路径：**`providers/<name>`、`packages/provider-sdk`、`docs/CROSS_PLATFORM.md`。
- **先调研：**先填 Provider Issue 表单，比较成熟操作系统自动化项目，再写适配器。
- **验收：**精确能力主版本、隔离负向测试、真实设备报告、本地权限诊断、审批边界、有界产物与
  fail-closed 取消。
- **不包含：**宣称其他平台、任意管理员权限或绕过 Server 路由/审批。
