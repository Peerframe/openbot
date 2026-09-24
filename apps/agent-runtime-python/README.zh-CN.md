# OpenBot Python 执行单元

一个受边界约束、基于 SDK 的 Python Agent 循环：它只**提出**动作，不持有任何任务状态。它是
OpenBot Agent 行为的参考实现；身份、任务、路由、授权、审批、预算、产物、审计与持久化的唯一
权威始终在 Server 侧。

状态：仅为实现切片。无持久化引擎、无 Provider 凭据、无操作系统隔离。普通 Python 进程不是
沙箱，本包也不声称是。下面的一次性进程适配器是一份*分帧与生命周期*契约，不是安全边界：它不
约束解释器，进程仍须由 Server 监督。

## 可选 Temporal 组合入口

`openbot_agent_runtime.temporal_agent.build_temporal_agent` 在 Worker 启动前组合一个 Agent，
使用单独固定的 Pydantic AI 2.47.0 / Temporal 1.33.0 环境。各 Run 的类型化 deps 只在 Activity
内交给可信的同步或异步工厂；Workflow 准备与历史回放只获得不能执行请求的模型元数据。
工厂必须创建独立端口，并把 deps 绑定到已接纳的引擎身份；授权与持久预算仍由控制层负责。

可选参数 `deferred_tools` 接受有界的 `ToolDescriptor` 声明。SDK 返回 `DeferredToolRequests`，
不会执行这些工具。控制层必须重新校验参数、取得批准、核验精确 Action 的结果，再提供
`DeferredToolResults`。模型目录包含内联与延迟工具，执行目录仅包含内联工具；声明会深拷贝，
不受调用方后续修改影响。公开任务参考流程现通过此入口执行模型和读取步骤，写入与发布仍由控制层负责。

它不替代 `BoundedExecutor.execute`，也不负责纠正、最终输出校验或完成发布。默认 Runtime
依赖与进程协议不变。[真实双 Run 探针](../../experiments/work-journey/multirun_port_probe.py)
验证调用实际重叠、结果隔离，以及回放不执行主机工作；不等于 Worker 崩溃恢复或 S3 已完成。
在[固定的实验环境](../../experiments/work-journey/README.zh-CN.md)中执行
`python -B experiments/work-journey/multirun_port_probe.py --address <自有临时-Temporal-地址>`，
不可指向生产命名空间。

## 它做什么

一次调用通过四个端口驱动一次受边界约束的运行，端口由受信任的宿主适配器提供（可进程内调用，
也可通过后面第二节所述的进程 profile；真实实现由 Server 适配器持有）：

| 端口 | 必需 | 调用时机 | 用途 |
| --- | --- | --- | --- |
| `authority` | 是 | 每个被 await 的边界前后，以及返回结果之前 | 针对本次运行的 Server 授权守卫。端口缺失，或在不 await 的情况下作答，都会使运行失败关闭。 |
| `model` | 是 | 每个 SDK 模型步一次 | 接收受边界约束的消息、本步实际提供的描述符和步序号；返回 `pydantic_ai` 的 `ModelResponse`。真实的步授权与用量持久化由 Server 适配器在此处负责。 |
| `tool` | 是 | 每次被准许的工具调用一次 | 接收工具名、经 schema 校验的参数和 SDK 调用标识符。该标识符**仅用于关联**：它是模型调用数据（Provider 的工具调用条目，或 SDK 生成的替代值），因此永远不是授权凭据，也不是恰好一次键。运行时不做任何本地副作用。 |
| `corrections`、`progress` | 否 | 一次 / 每阶段 | 非持久化。运行时不存储任何内容，也不声称持有持久状态。 |

结果只携带受边界约束的最终文本，以及实际应用的修正标识符。它绝不携带运行状态、用量、产物、
审批结果、凭据、数据库句柄或任何 Server 写入。

## 边界

* 已评审的 Server 上限，作为上限保留：**8** 个模型步、**16** 次工具调用、每个工具结果
  **128 KiB**（与 `apps/server/src/agent-runtime.ts` 中的
  `AgentRuntimeToolPolicy.maximumResultBytes` 一致）。
* 运行时本地边界：目录大小与字节数、消息字节数、历史长度、最终输出字节数、进度事件数与修正数。
* Server 可以收紧任一上限。高于其上限的限额会在运行开始**之前**被拒绝，因此无法偷渡更宽松的
  预算。
* 每个边界都以 UTF-8 **字节**计量，且针对真正会跨越边界的载荷。超限的工具结果被拒绝，绝不截断。
* 一个绝对单调时钟截止时间覆盖**整个**运行——入口授权检查、修正读取、SDK 运行与出口授权检查——
  而不仅是模型循环。准备工作不能重置它。声明的工具输入 schema 必须自包含。
  Schema 由 `jsonschema-rs` 以 `offline=True` 编译；外部 `$ref`/`$dynamicRef` 在目录准入时
  就会被拒绝，不进入模型或工具调用。保留 Unicode ECMA 正则，并限制回溯步数与编译大小。

## 拒绝语义

* 不存在宽容式兜底。authority、model 与 tool 端口都是必需的。
* 失败是粘性的：首次拒绝会封闭本次运行，之后的尝试只能再次抛出它。因此，一个吞掉取消并延迟
  返回的端口无法产出成功。
* 被拒绝的工具调用绝不会被转换为重试提示或失败观察。SDK 恰好会把 `ToolFailed` 和
  `ModelRetry` 转换为上述形式，所以运行时绝不从端口失败中抛出这两者，失败后模型也不会被再次
  询问。
* authority 在**每一个**被 await 的边界之后都会重新检查，包括进度事件；在进度发送期间发生的
  撤权会在模型端口被要求工作之前终止该步。
* 空白或仅含空格的答案被拒绝（`output_invalid`），被接受的文本会被去除首尾空白，与 Server 自身
  的最终校验一致。
* 工具调用标识符被视为**仅用于关联的数据**。它绝不会被传入 authority 端口（该端口完全不接收
  参数），因此一个格式良好或新选出的标识符不授予任何权限，也无法恢复已撤回的授权。
  `duplicate_tool_call` 拒绝只捕获同一模型响应内某个标识符的字面重复；它**不是**重放保护，相同
  名称加参数在不同标识符下会被再次准许；后续模型步骤也可复用已消费的 ID，作为新意图再次
  校验。恰好一次的副作用安全属于 Server，在授权处或副作用本身。
* 取消调用方的任务会重新抛出 `CancelledError`；它永远不会变成一个结果。
* 单元自身不向 stdout 写入任何内容：SDK 的首次运行横幅已关闭，且有一个全新解释器测试断言一次
  完成的运行只打印调用方要求的内容。

## 进程适配器（`scripts/run-worker.py`）

已评审的 profile `openbot-agent-runtime/1`（固定在 `docs/AGENT_RUNTIME_PROTOCOL.md`）是一份
**一次性**契约：一个子进程、一个请求、一个终止帧、退出。上面同一个单元既可进程内驱动，也可作为
这个进程由受信任父进程通过管道提供端口来驱动：

```sh
<package>/.venv/bin/python -I -u <package>/scripts/run-worker.py
```

* **分帧。** JSON-RPC 2.0，stdin 上每行一个对象（UTF-8，以 LF 分隔），回答写在 stdout。子进程
  只把协议帧写到 stdout；stderr 从不用于协议，且有测试断言 stdout 干净、stderr 为空。
* **父进程可发送的内容。** 恰好一个 id 为 `run` 的 `runtime.execute` 请求，载荷为
  `{protocol, tools[], deadlineMs}`，随后对每个子请求回一个应答。批量、通知、未知字段、重复或重放
  的 id、非有限 JSON 以及非法 UTF-8 都会被拒绝。
* **子进程发送的内容。** 同时至多一个在途请求，id 单调递增 `w1 … w512`：`authority.check`
  （空参数，空结果）、`model.generate`（受边界约束的消息）与 `tool.execute`（id、名称、已校验的
  参数）。应答复用请求 id，且只携带 `result` 与 `error` 之一。
* **边界值。** 每帧 512 KiB（不含换行符），每方向 8 MiB 与 1024 帧，stderr 64 KiB，JSON 嵌套深度
  ≤ 64，且仅限有限 JSON。
* **生命周期。** 任一 await 处的父进程 EOF 都会在运行发布之前取消它。成功写一个 `result` 帧并
  退出 `0`。被拒绝的运行写一个固定的 `error` 帧并退出 `1`。损坏的通道以一个固定的 JSON-RPC 错误
  关闭并退出 `2`。任何内容都不会被重放或重试。
* **它确实声称的隔离。** 子进程只把自己解析出的 `src` 目录加入 `sys.path`，不从环境或 cwd 派生任何
  路径，不打开网络、数据库或插件面，也不读取凭据。`-I` 使工作目录与 `PYTHONPATH` 不进入导入路径。

适配器固定的限额即 profile 自身的限额：`catalog_tools=64`、`history_messages=128`、
`output_bytes=32000`。最终的线上响应中不加入任何计数器、修正 id 或用量读数——它们属于 Server，
此处没有对应端口。

## 目录结构

```
src/openbot_agent_runtime/
  contracts.py   带类型的请求/结果、限额与端口协议
  errors.py      封闭的失败词表 + 建议性的 Server 错误码映射
  bounds.py      UTF-8 字节计量与单 JSON 值检查
  catalog.py     目录准入与 JSON Schema 参数校验（$ref 永不抓取）
  guard.py       authority 检查、计数器、单一绝对截止时间与失败封闭
  sdk_ports.py   仅有的两个 SDK 接触点（PortModel、PortToolset）
  executor.py    组合与受边界约束的运行
  wire.py        进程 profile 的分帧与 JSON 编解码（换行帧、严格边界）
  profile.py     wire <-> SDK 映射：请求解析、消息形状、原因词表
  worker.py      一次性会话：三个 RPC 端口、生命周期与退出码
requirements.lock          冻结的开发依赖闭包（23 项固定版本依赖）
requirements-runtime.lock  冻结的纯运行时闭包（18 项固定版本依赖，不含测试工具链）
scripts/
  bootstrap.sh            唯一联网步骤：从 requirements.lock 创建 ./.venv
  check.sh                校验 dev profile，然后运行测试
  run-worker.py           受信任的进程入口（加入自身 src 目录后服务 stdin）
  verify_environment.py   感知 profile 的环境校验器（dev | runtime | auto）
tests/           仅确定性假件：无付费 API、无凭据、无数据库
RESEARCH.md      所依赖的每个 SDK 行为对应的固定上游证据
```

## 依赖 profile（`scripts/verify_environment.py`）

已批准两套锁定环境。**开发** profile（`requirements.lock`，23 项固定版本依赖）是默认值，含测试运行器；
**运行时** profile（`requirements-runtime.lock`，18 项固定版本依赖）保留相同版本的运行依赖，移除测试
工具链，所选镜像不包含 pytest。该划分是**从已安装的发行版元数据推导**出来的，不是
猜测：`pytest` 是唯一会拉入 `iniconfig`、`packaging`、`pluggy` 与 `Pygments` 的发行版，而运行时
闭包中没有任何东西可达它们（见 [RESEARCH.md](RESEARCH.md) §10）。

```sh
./.venv/bin/python scripts/verify_environment.py                   # dev（默认）
./.venv/bin/python scripts/verify_environment.py --profile dev
./.venv/bin/python scripts/verify_environment.py --profile runtime
./.venv/bin/python scripts/verify_environment.py --profile auto
```

* `dev` 与 `runtime` 各自校验一份确切的锁：每项依赖都以完全相同的版本安装，除
  `pip`/`setuptools`/`wheel` 外没有其他发行版，且该 profile 的每项直接依赖都以相同版本出现在锁中。
* `auto` 先拿已安装发行版去整体匹配一份锁，再套用该 profile 的检查。只有**完全匹配**才算通过，
  因为部分安装的开发环境、缺失的运行依赖、版本漂移与多余包是同一类问题：这不是本包批准过的
  环境。Server 的启动预检用的就是这个模式。
* 锁文件只接受 `name==version` 格式。非版本固定行、pip 选项、重复条目（即使版本相同）
  均会报错，不会静默跳过。
* 校验器只读取发行版元数据。它从不安装、不使用网络，也不接受调用方给出的锁路径：锁是包旁边的
  固定文件，因此在任意工作目录下、以及在 `python -I` 下解析结果都一致。
* 退出码：匹配为 `0`，锁或漂移问题为 `1`，`--profile` 取值非法为 `2`。

## 运行检查

```sh
./scripts/bootstrap.sh   # 唯一联网步骤：从 requirements.lock 创建 ./.venv
./scripts/check.sh       # 校验 dev profile，然后运行测试
```

`check.sh` 从不安装任何东西：环境缺失即失败。需要 CPython >= 3.12（`asyncio.timeout`）；
所固定的 SDK 本身只要求 3.10。

## 已知限制

* 本包测试使用合成端口或父进程。另行运行的真实 Server/PostgreSQL 验收已在 macOS 通过
  222 项，见[运行时说明](../../docs/NATIVE_AGENT.zh-CN.md)。这不证明操作系统隔离、崩溃恢复
  或真实 Provider 的交付质量。
* 声明的工具输入 schema 中的 `format` 关键字只是注解，不是断言：显式设置
  `validate_formats=False`。
* `ToolDescriptor` 名称被限制为 `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`，且输入 schema 必须描述一个
  对象。
* 单元对工具副作用**不提供幂等或重放保护**，也不声称提供：它拿到的唯一逐调用标识符是模型调用
  数据。恰好一次行为必须来自 Server 的授权或副作用本身。
* 进程 profile 已实现并有子进程测试覆盖，但这些测试使用*合成*父进程。与 Server 自身进程适配器的
  端到端验收由 Server 负责，证据记录在运行时说明中。
* Linux/amd64 参考容器通过 369 项包内测试与 222 项 Server/PostgreSQL 测试，运行于 ARM Mac
  模拟环境。这不证明原生云端 CI、Windows 或生产打包已通过。现有 TypeScript 路径仍是默认值。
* 依赖配置测试使用真实锁文件、合成安装集，并复现 Server 的预检调用。
  可选 Server 镜像另行验证实际安装的运行依赖和 SDK 工具循环，见[容器验收](../../docs/SERVER_CONTAINER.zh-CN.md)。
  这些检查不证明独立系统隔离或真实模型服务的行为。
* 在开发检出中运行 `--profile runtime` **预期会失败**：它会把那 5 个测试专用发行版报为多余。这是
  检查在正常工作，不是漂移。
* 适配器不读取任何环境变量、不加载任何 Provider 客户端——有测试断言——但 `-I` 并不隐藏
  `os.environ`，所以这是本代码的性质，而非解释器开关的性质。
* 无流式输出：子进程只发出一个终止帧然后退出。渐进式输出不属于本 profile。
