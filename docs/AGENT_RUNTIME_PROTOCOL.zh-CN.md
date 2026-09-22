# Agent 运行时进程协议 v1

[English](AGENT_RUNTIME_PROTOCOL.md) · [简体中文](AGENT_RUNTIME_PROTOCOL.zh-CN.md)

状态：供内部适配器实现的已固定协议，尚未启用生产运行时，也不是公开 API。
完整字段与示例以[英文协议](AGENT_RUNTIME_PROTOCOL.md)为准；复用依据见[调研](research/python-runtime-transport.md)。

每次执行使用一个已安装的可信 Python 进程，由 Server 选择固定程序、参数、环境、工作目录和管道。
采用 JSON-RPC 2.0 对象与 UTF-8 换行分帧，只接受明确列出的字段；拒绝批处理、通知、未知字段、
重放 ID、非法 JSON/UTF-8。这是私有的受限用法，不宣称完整 MCP 或通用 JSON-RPC 互操作。

协议版本为 `openbot-agent-runtime/1`。每帧最多 524,288 字节（不含 LF），每方向累计 8 MiB、
1,024 帧，stderr 累计 64 KiB，JSON 嵌套最多 64 层；解码前先限制字节与未结束缓冲区。
stdout 仅承载协议，stderr 内容丢弃且超限失败。父请求 ID 为 `run`，子请求依次为 `w1` 至
`w512`，每次最多一个待响应的子请求；结果与错误字段只能存在一个。

Server 只发送一次 `runtime.execute`，参数为版本、工具描述及 1 至 300000 毫秒的期限。工具最多
64 项、总计 64 KiB。Python 调用现有真实 SDK 执行单元，使用固定控制提示
`Continue the Server-bound task.`，不持有模型凭据或原始媒体，不自行安装依赖或选择模型。

子进程只能调用三个接口：

| 接口 | 请求 | 结果 |
| --- | --- | --- |
| `authority.check` | 空对象 | 空对象 |
| `model.generate` | 有界 SDK 对话消息 | 文本、工具意图与 Server 观察到的单步用量 |
| `tool.execute` | 保留原 ID、名称及参数的工具意图 | 一个完整 JSON 值 |

对话只允许首条固定 user 控制消息，以及后续 assistant 文本/工具调用和 tool JSON 结果；至多
128 条、256 KiB。不接受额外 user、system、媒体、提供方选项或重试提示。Python 按序转换 SDK
消息，未知部分必须拒绝，不能静默丢弃。Server 把首条控制消息换成真正的任务材料，保留原始
指令与已准入媒体，每步重读追加指令，并在返回前持久化真实用量。未知用量仍记录为未知。
工具 ID 来自模型数据，只用于关联；Server 校验工具意图并在执行前消费，不能据此宣称恰好一次。
同一模型响应内的工具 ID 必须互异；后续模型步骤可在旧意图消费后复用 ID，作为新提议再次校验。
存在待执行意图时不能进入下一模型步骤；协议请求 ID 仍不得复用。

成功时，子进程只返回 `result:{text:string}`，刷新管道并以零退出。Server 核对最后一轮真实模型
回答、无待处理操作、干净 EOF 和零退出，才接受待提交结果；最终发布仍由 NativeAgentRunner
完成。不存在子进程审计、用量写入、追加指令写入、批准或完成提交接口。

应用错误使用固定消息和有界原因标识，不能发送原始异常。Server 接口失败不能被后续子进程成功
覆盖；协议错误、并发请求、额外帧、崩溃、超时与迟到结果均关闭通道并失败，不自动重试。
Python 在执行与等待期间也监控父管道 EOF，取消任务并非零退出。Server 取消会关闭管道、终止
本次 POSIX 进程组，必要时从 SIGTERM 升级为 SIGKILL；成功也必须在清理期限内确认进程退出。
普通子进程不是操作系统沙箱。本阶段用于 POSIX 集成测试，Linux 产品支持与实时流式输出仍须
另行验证，不声明 Windows 进程树支持。
