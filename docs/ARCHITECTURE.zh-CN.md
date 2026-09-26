# OpenBot 系统架构

当前源码以 Python 为业务 Server、Temporal 为持久执行协调者。macOS arm64 桌面可托管本地 Python 服务；Windows 与 Intel Mac 使用远程服务，既有本地安装与数据保留。旧 TS Server 仅保留冻结的测试参照，不进入产品。

[English](ARCHITECTURE.md) · [仓库地图](REPOSITORY_MAP.zh-CN.md)

OpenBot 是一个 TypeScript monorepo，由唯一权威 Server、可替换的执行 Node 和共享 Desktop/Web 客户端组成。本文件描述当前源码，不把目录、接口声明或构建产物当作平台已具备执行能力的证据。

## 运行边界

| 部件 | 当前职责 | 不获得的权限 |
| --- | --- | --- |
| `apps/server-python` | Owner 会话、Bot 与频道身份、成员、路由、任务、审批、审计、原生 Agent 和插件授权 | 模型与外部资料不能覆盖 Server 策略 |
| `apps/web` | 频道、草稿、任务监督、设置、扩展展示 | 不直接访问数据库、模型凭据或决定授权 |
| `apps/desktop` | 打包客户端、受限类型化桥接、连接策略、本地 Server 安装与生命周期 | 渲染页面不能任意调用主进程 |
| `apps/node` | 出站连接、注册、可执行能力声明、任务生命周期和 Provider 调度 | 能力声明不是任务或副作用授权 |
| `providers/*` | 对特定执行后端的薄适配 | 不拥有 Bot 身份、成员、审批或任务最终状态 |
| `packages/domain`、`packages/protocol`、`packages/db` | 产品类型、运行时协议校验、数据模型和有序迁移 | TypeScript 类型不能替代运行时授权检查 |

## 数据和状态

PostgreSQL 保存 Bot、频道成员、消息、Run、委派关系、审批、审计、记忆与技能。一条频道消息最多指定六个准确接收者，每人生成一个 Run；`(source_message_id, bot_id)` 唯一约束防止同 Bot 重复任务，并保留同一条人类原消息。提交前在同一事务校验全部接收者。

任务转换使用条件更新与事务；原生领取和协作还使用显式 advisory/行锁。移除成员会先取消受影响的活动任务树、过期待批请求，再移除成员关系。直接对话的 Bot 固定不变。表情回应仅代表单 Owner 自己的选择，不虚构多人参与。

大型二进制文件在数据库外受控存储，通过 Server 元数据与鉴权接口访问。频道附件、任务产出和临时画面具有各自限制。消息中出现附件 ID 不等于获得访问权。

## 原生 Agent 与异步协作

用户启用模型后，执行配置为 `none` 的 Bot 由 Server 使用已安装的 AI SDK `ToolLoopAgent` 执行。每个工具绑定已领取任务的 Bot 和频道。档案、记忆、技能、频道文字、网页、插件描述和同事结果都是不可信任务资料，不能授予权限。

最多六个根任务并行，同 Bot 同频道的根任务依次执行。`start_task` 返回非阻塞委派回执；`wait_for_task` 等待当前任务创建的准确子任务；`delegate_task` 合并创建与等待。接收者使用自己的身份与授权。两层委派、四个后代、每 Run 步骤/工具预算和整棵树期限限制整体工作。父任务最终提交前会汇总尚未读取的同事结果。

Owner 显式追加指令只关联一个排队或运行中的原生 Run，在下一模型步骤进入上下文，不能改变已经完成的效果或暗中修改其他任务。完成事务会发现已接受但未处理的指令，要求在原预算内继续推理。

兼容模型的真实公开文本增量通过 `run.output` 暂存展示，正式回复、产出元数据与终态一起提交。草稿不是审计事实，不展示内部推理；MiniMax 继续走受控非流式路径。Server 重启把中断任务标为失败，不自动重放结果不明的外部效果。详见[原生 Agent](NATIVE_AGENT.zh-CN.md)与[异步协作](ASYNC_COLLABORATION.zh-CN.md)。

## Node、Provider 与审批

使用 Worker 的任务沿用 Server/Node 分派协议。Node 出站连接，报告实际可执行能力和容量，只接收 Server 任务。offer/accept/confirm、开始、进度、画面、结果和结算都有校验契约；Server 处理断线，并可在撤销持久化后发送取消。

Docker 集成是对已审阅上游电脑接口的薄适配，不复制其控制面。其他 Provider 的声明不代表执行支持。支持范围需查[Provider 符合性](PROVIDER_CONFORMANCE.zh-CN.md)、[跨平台边界](CROSS_PLATFORM.zh-CN.md)和对应 Worker Host 文档。

需审批的副作用先经过 Server 策略、记录和批准再派发。移除成员或终止任务会使后续授权失效；迟到结果不能覆盖 Server 的终态。

## 插件与外部协议

MCP 承载已审阅工具、资源和 Owner 选择的提示词。安装绑定已审阅的 manifest，每个 Bot 有独立 grant；确认模式需要针对准确参数的新决定。插件网页运行在受限展示边界，不获得通用 Desktop/Server 权限。详见[插件协议和作者指南](PLUGINS.zh-CN.md)。

内部 Node 协议和频道 REST/SSE 与 MCP 是不同边界；当前没有实现 AG-UI 或 Matrix 联邦。标准适用于哪些能力，以[开源复用记录](OPEN_SOURCE_REUSE.zh-CN.md)中的精确版本、许可证和采纳决定为准。员工学习方向保留 Hermes Agent 的启发归属。

## 客户端、同步与安装

Desktop 打包 React 客户端，通过受限类型化 Electron 桥接访问原生能力；Web 通过 Server 的鉴权 REST/SSE。频道事件包括消息、任务、进度、临时输出和交互；工作区事件处理更广的变化。重连重新读取权威快照，不宣称所有临时事件有可持久回放的游标。

本地 Server 打包、目录权限和生命周期依赖平台。本次增加 Windows x64 适配并保留现有 macOS 行为；构建通过与安装后的生命周期证据不同。Linux 和其他架构以各自文档为准。详见[Windows Desktop](WINDOWS_DESKTOP.zh-CN.md)与[Desktop 安装](DESKTOP_INSTALLATION.zh-CN.md)。办公室可视化仍是暂缓的可选插件。

## 工程入口

`npm run check` 运行文档/策略、迁移、lint、严格类型、测试和构建。专用 PostgreSQL CI 步骤使用独立临时数据库验证事务。模拟模型、真实数据库、实际渲染和平台执行是不同层次的证据。

从[仓库地图](REPOSITORY_MAP.zh-CN.md)和[贡献指南](../CONTRIBUTING.zh-CN.md)开始。
