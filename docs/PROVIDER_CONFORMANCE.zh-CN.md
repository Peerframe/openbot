# Provider 一致性测试

[English](PROVIDER_CONFORMANCE.md) · [简体中文](PROVIDER_CONFORMANCE.zh-CN.md)

OpenBot 必须先有可执行证据，才会宣称某个平台或 Provider 已受支持。当前设计采用
[MCP Conformance `74edef34`](https://github.com/modelcontextprotocol/conformance/tree/74edef34d674f563537be8c6587cebaa58e830ca)
的稳定检查 ID 和明确预期失败基线、
[Kubernetes Conformance `6fc6e660`](https://github.com/cncf/k8s-conformance/tree/6fc6e66092075b7443c9259629b607c15b7876b9)
的目标元数据与可复现证据，以及
[OCI runtime specification `6999a89a`](https://github.com/opencontainers/runtime-spec/tree/6999a89a76a0329f440d5740497bedb9dd431297)
的系统/架构范围。检查和 JSON schema 只针对 OpenBot；仓库没有复制上游实现代码。

## 当前已经检查什么

协议 `0.9.0` 同时携带临时保留的旧能力别名和作为权威依据的版本化 manifest。每个 Run offer
都包含精确的能力主版本要求；Server 路由和工作主机会各自再检查一次。

- 旧能力名匹配，不能替代缺失的版本化能力。
- `browser.observe@2` 不能静默满足要求 `browser.observe@1` 的任务。
- 平台专属 profile 不能在其他系统执行。
- 已满载工作主机不能继续接单。
- 只有声明、没有 `execute` 的 Provider 不会上报为可执行能力。
- Provider id、平台或能力归属自相矛盾时，Node 会在启动前失败。
- `buildProviderConformanceReport` 会生成严格、有界的 JSON 产物，绑定 Provider、协议、测试集、
  平台、架构、系统版本和证据等级。
- `@openbot/provider-conformance-runner` 会按稳定顺序执行场景，并提供 setup/run 时限、取消信号、
  有界 cleanup、允许列表结果和由预期失败基线决定的进程状态。
- 必需前置条件缺失必须记为失败，不能藏成 skipped；登记过的预期失败仍是失败，也不能获得支持
  标签。

当前场景矩阵覆盖 Linux x64 浏览器、Linux arm64 编码、Windows x64 浏览器、macOS arm64
浏览器、macOS arm64 Cua 声明、平台不匹配、manifest 缺失、能力主版本不兼容和容量耗尽。
这些是模拟契约测试，不代表所有原生 Provider 已经实现。

## 一致性阶段

| 阶段 | 含义 | 必须提供的证据 |
| --- | --- | --- |
| Declaration | 静态元数据合法且内部一致 | `inspectProviderDeclaration` 通过 |
| Routed | Server 与 Node 只接受声明的平台和精确能力主版本 | 共享协议与路由场景通过 |
| Integrated | Provider 在有界隔离任务中正确上报进度、画面、审批和产物 | Provider 集成测试通过 |
| Real device | 相同场景在明确系统版本和架构上运行 | 带可复现外部证据的 `real-device` 报告 |
| Supported | 维护者批准固定 Provider 版本并公开已知限制 | 经审查的真实设备矩阵与安全证据 |
| Certified | 固定版本通过完整矩阵、签名安装包和升级/回滚测试，且没有未批准失败 | 独立发布审查和随版本附带的报告 |

`experimental`、`supported` 和 `certified` 是发布支持标签。只通过声明或模拟路由测试，不能
获得这些标签。

## 当前真实状态

| Provider | Declaration | Routed | Integrated | 当前声明 |
| --- | --- | --- | --- | --- |
| Docker/browser 适配器 | 通过 | Windows/macOS/Linux 模拟路由通过 | 打开 URL + PNG，及可信测试站点的可选审核单按钮点击 | Pre-alpha 开发切片 |
| Cua | 通过 | macOS 声明场景通过 | 本仓库尚未实现 | 无 |
| Lume | 通过 | 已定义要求 | 本仓库尚未实现 | 无 |
| Coder | 通过 | Linux arm64 模拟路由通过 | 本仓库尚未实现 | 无 |

## 机器可读报告

`@openbot/protocol` 定义 `openbot.provider-conformance/v1`，`@openbot/provider-sdk` 提供构建器和
确定性序列化器，`@openbot/provider-conformance-runner` 负责编排场景并以独占方式创建证据文件。
报告故意没有 `supported` 或 `certified` 字段：机器负责保存证据，发布标签仍需维护者审查。

```ts
const report = buildProviderConformanceReport({
  provider,
  providerVersion: "0.1.0",
  stage: "integration",
  suiteVersion: "1.0.0",
  target: {
    platform: "linux",
    architecture: "x64",
    osVersion: "6.8.0",
    evidenceLevel: "hermetic",
  },
  checks: scenarioChecks,
});
```

每项检查都有稳定 ID、严重级别、状态、时间、有界引用和有界证据。报告不接收原始日志，避免
凭证或私人内容进入公开产物。严格 schema 会重新核对统计、基线结果和一致性结论，手工修改
JSON 不能把失败伪装为通过。

`real-device` 目标还必须写明 `workerHostVersion`、`hardwareModel` 和不透明的
`hardwareEvidenceId`。该 ID 只引用受控资产或证据记录，不能使用序列号、UDID、凭证或其他原始
设备标识。

预期失败必须带跟踪 Issue 和过期时间。未过期且与失败匹配时，CI 基线可以保持 current，但检查
仍为失败，`summary.conformant` 仍为 `false`。新增失败、条目过期、检查消失或原失败已经修复，
都会让基线变旧并要求人工处理。

## 运行场景模块

场景模块导出一个有类型的 `suite`。场景结果只能包含允许的状态和稳定代码；任意 Provider 输出和
抛出的值都不会复制进公开报告。

```ts
export const suite = {
  name: "openbot-provider",
  version: "1.0.0",
  stage: "integration",
  provider,
  providerVersion: "0.1.0",
  target: {
    platform: "linux",
    architecture: "x64",
    osVersion: "6.8.0",
    evidenceLevel: "hermetic",
  },
  scenarios: [navigateAndCapture],
} satisfies ProviderConformanceSuite;
```

先构建 runner，再指定一个全新的报告路径；命令拒绝覆盖已有证据。

```bash
npm run build --workspace @openbot/provider-conformance-runner
node packages/provider-conformance-runner/dist/cli.js \
  --module ./path/to/provider-suite.mjs \
  --output ./provider-conformance-report.json
```

退出码 `0` 只表示预期失败基线仍然有效，不代表所有必需检查都通过；`1` 表示存在意外或过期
失败，`2` 表示 runner 或证据写入失败。是否真正一致还要单独检查 `summary.conformant`。

Provider 和场景模块都是可执行的不可信代码。必须在专用、可丢弃的进程与系统账号中运行，账号
不能带 Owner 浏览器资料或无关凭证。时限会发送取消信号并限制 runner 继续等待，但该包不是
原生代码沙箱。

## 运行仓库测试

```bash
npm run test --workspace @openbot/protocol
npm run test --workspace @openbot/provider-sdk
npm run test --workspace @openbot/provider-conformance-runner
npm run test --workspace @openbot/node
npm run test --workspace @openbot/server
```

完整仓库门禁仍然是：

```bash
npm run check
```

## 新增 Provider

1. 先检索维护中的现有实现，并在[开源复用审查](OPEN_SOURCE_REUSE.zh-CN.md)登记固定版本和许可。
2. 只写窄范围 `ComputerProvider`，不能把上游的身份、策略或路由引入 OpenBot。
3. 只声明适配器真正能执行的平台；未完成的包不提供 `execute`，保持 declaration-only。
4. 为平台、必要架构、精确能力主版本、容量、重连和 fail-closed 行为增加正反场景。
5. 先补隔离集成测试，再提供真实设备证据，最后才能申请支持标签。
6. 导出有类型的 `ProviderConformanceSuite`，在 Server 进程外运行，用
   `providerConformanceReportSchema` 校验结果，并把确定性 JSON 作为 CI 证据发布。
7. 记录可选组件许可、特权依赖和预期失败。预期失败只能是可见债务，不能伪装成功。

schema、构建器、独立 runner 和 Docker/browser 专属场景已经实现。其他 Provider 仍需自己的
模块。真实 Windows、macOS、Linux 设备报告经过观察与审核前，不存在真实设备支持声明。

## 审核浏览器点击的证据

[受控浏览器流程](CONTROLLED_BROWSER.zh-CN.md) 已在 macOS arm64 上，通过真实 Server/PostgreSQL、
已登记 Worker、固定版本 agent-computer 及其 Chromium 验证本地夹具。
拒绝时页面不变；批准时指定按钮点击一次并返回 PNG。重复导航覆盖带帧前缀的元素引用。
Web 界面通过 1280x900 和 390x844 验收；测试上游的监听地址补丁已在[研究记录](research/controlled-browser-click.md)披露。
这是实验集成证据，不等于原生桌面输入或 Windows/Linux 浏览器认证。浏览器出口限制和通用不可信站点操作仍未实现。


## Docker 浏览器集成 suite（B1a）

在 Linux 或 macOS 主机、执行过 `npm ci --ignore-scripts` 的 checkout 中，准备 Node 和运行中的 Docker：

```bash
npm run test:provider:docker -- --output /tmp/openbot-docker-conformance.json
```

每次选择**新的**输出路径，报告写入器拒绝覆盖。驱动构建生产组件，运行 12 个 fixture 回归，
创建固定版本 PostgreSQL 容器，再通过已有 runner 执行 [Docker suite](../providers/docker/conformance/suite.mjs)。
不需要私人 `.env`、模型凭据、既有数据库或浏览器资料；Docker 可能需要下载固定镜像。
驱动需要 POSIX 子进程信号，尚未验证 Windows 驱动执行。容器使用随机 loopback 端口和临时存储，只有名称和随机标签都证实属于本次才会删除。
完成后关闭 Server、Node、电脑连接并删除临时凭据和产物。缺少前置条件或清理失败都必须失败，
不能跳过。进程中断仍受子进程总期限约束，并清理驱动自己的数据库和临时目录。
CI 在现有数据库 job 执行相同必需命令，并保留可用的脱敏 JSON 报告。既有必需检查保持不变。

suite 在一个隔离测试进程中组合**生产** Server 应用、PostgreSQL store、dispatcher、Node
client 和 Docker Provider。Owner 登录、enrollment 使用真实 HTTP；路由、进度、帧和批准消息
经过认证 WebSocket。电脑 HTTP 服务按已审查上游接口合成，无真实浏览器。
报告记录本机 OS/架构且只能是 `evidenceLevel: hermetic`，不能用于原生输入或三平台浏览器
认证。上文既有 Chromium 实证是另一项测试。

14 个场景全部 required，不配置预期失败基线：

| 稳定 id | 必须验证的行为 |
| --- | --- |
| `browser.approve-once` | 冻结含帧前缀的精确 ref、snapshot id、名称、URL 和截图摘要；未认证批准失败；Owner 批准仅点击一次并保存审计/PNG、更新帧；重复决定失败 |
| `browser.reject` | Owner 拒绝后零 commit、无结果产物 |
| `browser.expire` | 过期决定零 commit；fixture 仅提前本数据库批准截止时间，再走真实决定接口 |
| `browser.node-stop` | 实际 Node stop 中止待批准 Provider；Server 立即终结等待任务并使待定审批过期，无需另一次 Owner 决定 |
| `browser.disconnect` | Owner 撤销凭据断开 Node 并终结等待任务，之后批准返回 409 |
| `browser.owner-cancel` | Owner 取消持久化且幂等，待定审批过期，零点击/产物；已完成任务拒绝取消 |
| `browser.cancel-after-dispatch` | 真实 HTTP 点击已记录但响应挂起时取消；保留批准决定与一次点击，审计外部结果未知，不发布完成或产物 |
| `browser.cancel-cleanup-capacity` | 取消后的 Provider 清理仍占用单容量 Node；清理完成释放容量后，排队任务自动开始 |
| `browser.changed-evidence` | 观察后截图变化阻止已批准点击 |
| `browser.human-control` | 批准前人工接管阻止点击 |
| `browser.transport-timeout` | 生产 15 秒 HTTP 期限结束无响应的 control 检查，点击不发生 |
| `browser.lost-receipt` | 电脑记录一次精确点击后销毁响应连接；Run 失败，无自动重试或成功产物 |
| `browser.bot-approval-exclusion` | 待批准期间，同 Bot 第二个 Run 不能导航；释放后可以执行 |
| `browser.bot-cleanup-exclusion` | 在 fetch 边界延迟真实 HTTP reader 取消；清理完成前维持同 Bot 互斥，之后可以执行 |

报告只包含稳定结果，不含凭据、原始错误、任务文本或图片。日志标明 setup/run/cleanup 阶段。
此 suite 的退出码 `0` 要求所有必需检查通过，非零必须阻断其门禁；完整 `npm run check`
仍单独执行并保持不变。固定来源和研究见 [B1a 研究](research/docker-browser-conformance.zh-CN.md)。

### Worker 取消与恢复边界

同一驱动先在自建 PostgreSQL 17.11 中运行 `worker-cancellation.integration.test.ts`，再执行
Server/Node/Provider suite。事务回归覆盖取消与批准、分配、完成、申请审批的竞态、幂等取消、
审计写失败回滚、断线/启动恢复使待定审批失效，以及频道成员移除时的锁兼容性。
普通 `npm run check` 默认跳过此数据库套件，只有 `OPENBOT_WORKER_TEST_DATABASE_URL` 指向明确
可丢弃的 loopback `openbot_worker_test_*` 数据库时运行。驱动只传入自建的
`openbot_dev_smoke` 数据库，禁止提供留存数据的数据库。

Owner Worker 取消和 Node stop 分别验证。前者撤销 Server 的任务权威并发送协作式 `run.cancel`，
同一事务内使待定审批过期。断线或重启中断的 running/waiting 任务直接失败，不重新派发；
已完成任务及其产物保留。已经派发的点击仍可能发生；取消响应成功和 Node abort 都不能证明
远端回滚或收到取消确认。参见 [停止电脑任务](CONTROLLED_BROWSER.zh-CN.md#停止电脑任务)
与 [B1b 研究](research/worker-run-cancellation.md)。

这些仍是合成电脑证据，不证明 capability lease、跨进程电脑资源锁、浏览器出口隔离，
或通用不可信站点操作安全。
