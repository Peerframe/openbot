# 产品 HTTP 契约测试

P1 测试覆盖显式指定的临时环境中的 Work、身份、Owner 认证、工作区/偏好、消息、Run/进度、轮询 SSE、
模型连接、转录连接选择、存储与附件、身份生命周期、反应、审批决定/设置、审计 JSON/CSV、
Employee profile/知识/技能/记忆、自动化 CRUD、Node 身份/注册 HTTP/WebSocket、Run 产物字节、插件 HTTP/MCP 声明与内容、
浏览器会话/维护及 Employee 导入导出。
它导入共享 TS 校验器并调用公共 API，不导入 Server 实现。
签名 publisher 与合成模型传输使用独立运行。混合入口转发、饱和背压和反向切换属于 P2；
Worker/Temporal 执行与原生打包保留后续阶段门槛。
本组单独通过不表示 P1 已完成，也不能证明这些执行路径可用。

按[贡献指南](../../CONTRIBUTING.zh-CN.md)准备 checkout 后执行：

```sh
npm run contracts:test
npm run contracts:http:python
npm run contracts:http:python -- --inventory
npm run contracts:http:python -- --suite control
npm run contracts:http:python -- --suite publisher
npm run contracts:http:python -- --suite models
npm run contracts:http:ts
npm run contracts:http:ts -- --suite publisher
npm run contracts:http:ts -- --suite models
```

第一条执行 Python 输入/DTO 序列化对照、Web 消费和目标输入测试。
第二条复用独占 Docker 夹具，迁移空 PostgreSQL，按产品模式启动真实 `serve.py`，登录并创建合成 Bot，
再通过私有夹具 CLI 执行十一套黑盒测试。它们创建身份、消息和 Task，验证版本冲突、分页、模型依赖保护、
原始上传/下载字节、两个附件命名空间的真实 DOCX 解析、引用保护、清理回执，以及 SSE ready/heartbeat/重连/中止。
另验证生命周期保护、反应、取消/纠正 Run、审批设置、单次/过期决定、有界审计分页/CSV、
profile/记忆 CAS、技能审阅摘要、旧式/原生提案审阅、自动化配额/成员保护、Node token 单次使用/轮换/撤销、
socket 身份/心跳、Run 产物原始字节、digest 绑定的 MCP 安装/更新、按范围授权的不可信资源/提示/app 读取、
原浏览器 Host 绑定/观察/维护、已审阅 Employee 下载字节及隔离预览/并发激活。
它们还撤销会话、修改夹具密码并退出登录。模型连接只使用合成 key，不执行成功的模型发现/测试/转录调用。
不使用已有数据、`.env`、真实模型凭据或 Temporal 安装。独占夹具预置一条 Bot 未读消息、等待审批及一条
包含安全字段/私有字段的审计事件、旧式/原生的已完成和未完成知识提案来源、过期 bootstrap token、
原生 proposed/expired/stale/unknown 动作及产物文件/元数据；
另一个独立认证的本机 MCP 夹具复用官方 SDK1.29.0 及产品的精确本机地址白名单；
只能通过有界私有控制端修改声明与内容，不执行工具，也不把控制端凭据发送给产品。
预置记录仅模拟 Worker 发布状态，HTTP 事务真实执行，没有验证 Worker/Temporal 执行。
成功或失败后清理本次资源。
需要 Docker 和已准备的锁定 Worker Python 环境。inventory 选项把默认产品 HTTP 注册表保存到现有迁移研究中。
清单同时保存已核对的 Web/Desktop/Node/原生 Host 消费者路径、源码摘要和真实注册/组装边界；源码清单不等于执行证据。
all/resources 还以 Node Fetch 调用实际 Web 客户端，经 Desktop 代理到真实临时服务，验证五类设置 PUT
及 Owner 附件上传/列表/下载/删除，检查方法和请求头漂移。安装版 Electron 和目标平台另行验收。
代理只补齐当前七类产品 PUT 精确入口和两类原始上传入口，保留凭据、Origin、字节和跳转边界。

对另外准备好的 TS/混合临时服务，创建权限为 0600、包含 `baseUrl`、`origin`、`cookie`、`botId`
的 JSON 文件，然后执行：

```sh
npm run run --workspace @openbot/contract-tests -- --fixture /absolute/private/fixture.json
```

`baseUrl`、`origin` 必须是完整 HTTP(S) origin；夹具提供已有 Owner 会话及 `none` profile 的 Bot。
测试会创建、纠正和取消合成 Task，要求目标没有活跃执行 Worker。私有夹具保存在仓库之外。
也可导入 `runWorkContracts`；每次调用都必须显式提供目标。
可选 `work` 对象包含 `{ taskId, intentDigest, actions: { approve, reject, expired, stale, unknown } }`，
ID 均为 canonical UUID，digest 为64位小写十六进制。独占 all/work 使用[现有 SQL 发布状态预置](../../scripts/test-contracts-python.ts)。
`runWorkContracts(target, work)` 验证成功批准/拒绝、并发重复决定仅发布一条事件、过期/代际/digest 拒绝、
一条待处理对账命令、重放/CAS 冲突和取消后查询。请求不能解决未知事实、花费 token 或准入执行。
私有 all 夹具要求该元数据；基本独立 Work 目标保留创建/读取/纠正/取消/拒绝范围。
`--suite resources` 或 `runResourceContracts(target)` 执行模型/存储/附件用例，使用仓库内
[合成 DOCX](fixtures/README.md)，要求目标已安装现有发布版文档解析器。运行中把存储自动清理恢复为默认关闭。
文档提取请求等待上限为35秒，对应产品解析器的30秒上限，其余请求仍为10秒。
全部套件的 CLI 子进程有180秒上限，单组子进程仍为120秒，失败时停止并回收。
独占驱动的 `--suite` 使用下文私有 CLI 的同一套名称，`--inventory` 要求 `all`；未知/重复参数和单组清单请求
在创建夹具前拒绝。
浏览器 JSON 响应明确允许8MiB，以容纳现有5MiB PNG 的 base64；其他 JSON 响应仍为4MiB。
审阅头有长度约束并拒绝 CR/LF，取消信号显式传递。

`--suite lifecycle` 还需要 `lifecycle` 对象，包含 `channelId`、`unreadMessageId` 和
`approvals: { approve, reject, expired }`，全部为 canonical UUID。
按[独占夹具预置代码](../../scripts/test-contracts-python.ts)准备同样的合成发布状态和有界审计事件：
一条未读 Bot 消息、等待 Run 上两个未过期和一个已过期的旧式 pending 审批，关联离线合成 Node；
一条 `SETTINGS_PRIMARY_BOT_UPDATED` 事件，带 nullable previous ID、160 个 emoji 的 `fileName`、
120 个 emoji 的 `name` 及私有哨兵。这些是测试输入，不能作为产品回退数据。
`runLifecycleContracts(target, lifecycle)` 使用相同元数据，不携带数据库凭据或 Worker 权限。
该套件修改审批设置，删除已选身份时清空主 Bot，每次使用新的临时目标。

`--suite employee` 需要 `employee` 对象，包含 canonical UUID `botId`、`sourceRunId`、
`sourceTaskId`、`sourceWorkRunId` 和 `proposals: { accept, reject, native, incomplete }`。
按[独占夹具预置代码](../../scripts/test-contracts-python.ts)创建一个独立 `none` Bot，
两个已完成旧式 Run 的提案、一个带 completion digest 的已完成原生 Task/Run 提案及一个未完成原生来源。
`runEmployeeContracts(target, employee)` 验证 Owner profile/记忆、候选技能、摘要绑定审阅及两种提案来源。
候选学习继续保留 Hermes Agent 的启发来源；夹具不执行任务完成或模型使用。

`--suite automations` 或 `runAutomationContracts(target)` 要求临时目标的自动化集合为空。
它创建未来执行的安排，按当前成员关系验证暂停/恢复及50条配额边界的并发创建，再只删除自己创建的安排。
真实到期提交和 Temporal 恢复另行验收。

`--suite nodes` 要求 `nodes: { expiredNodeId, expiredToken }`，数据库中预置一个已过期 token。
`runNodeContracts(target, nodes)` 只签发/交换本地 bootstrap 值，打开有界合成协议连接，验证身份/心跳投影，
轮换凭据、撤销/断连并测试共享注册限流；不启动 Worker executor 或 Provider。
使用空闲临时目标，限流和撤销后的状态随夹具一起清理。

`--suite artifacts` 要求 `artifacts: { valid, integrity, refusedKey, oversized, symlink? }`。
两条 `valid` 记录包含 UUID `id`、UTF-8 `name`、`mediaType`（`image/png` 或 `text/markdown`）及有界 `base64` 字节；
其余字段标识已发布的负例记录，按[独占预置代码](../../scripts/test-contracts-python.ts)准备。
`runArtifactContracts(target, artifacts)` 验证原始字节、响应头、完整性、键限额、过大文件及可选的符号链接拒绝。
原生 Work 下载在 `artifacts` 内增加 `native: { taskId, valid, integrity, sizeMismatch, missing, oversized, symlink? }`。
`taskId` 绑定预置的已完成 Work 来源。有效记录仍用相同字段，允许2–3条、255字符名称、空字节及 PNG/Markdown/`application/octet-stream`。
独占驱动准备3条，检查8MiB 存储的原始下载、RFC5987 文件名、sandbox 头、Work 快照摘要/大小/下载链接、
摘要/大小不一致、缺失文件、过大文件及 no-follow。私有 `all` 夹具必需 `native`，单独 artifacts 可保留只测旧式的范围。
驱动先带本次创建的两个链接执行完整19项产物检查，仅移除这些链接后再执行全部套件中的17项产物检查。
整个存储根目录的测量会正确拒绝任何链接；该顺序保留正常存储统计的独立成功验收。
这些是发布状态夹具，没有实际 Worker 产物发布证据。

`--suite plugins` 要求 `plugins: { endpoint, token, controllerToken }`。endpoint 必须是
[独占 MCP 夹具](../../apps/server-python/scripts/contract-plugin-fixture.py)的精确 `http://127.0.0.1:PORT/mcp` URL，
两种独立凭据均为64字符小写 hex；产品须显式把该地址加入本机白名单。
`runPluginContracts(target, plugins)` 验证真实声明发现、审阅 digest、安装默认禁用、版本/并发 CAS、
声明/授权/成员保护、不可信资源/提示/app 内容、普通资源字节上限、更新重置、删除及 MCP bearer/session 清理。
公开记录省略私有 token。默认服务没有旧式 Run 权限 guard，不能产生旧式等待审批的插件调用；该 HTTP 决策入口
目前只验证认证、非法输入和未知调用拒绝。成功的旧式决定及原生持久化工具审批/执行仍需单独验收。

`--suite browser` 要求 `browser: { frameBase64 }`，使用[独占夹具](../../scripts/test-contracts-python.ts)中有界、
自行生成的1像素 PNG。`runBrowserContracts(target, browser)` 创建并清理自己的 Docker-profile Bot，
注册已认证合成 Node，通过真实 socket 返回自行生成的帧。它检查 Owner/Origin/body 限制、原身份绑定、
默认关闭的控制门槛、PNG 字节、维护、会话关闭/断连及同 ID 新凭据无法替换原 Host。
不启动 Chromium 或浏览器 Provider。当前产品入口在客户端取消后仍保留等待，直到原命令25秒期限结束；
测试验证有界释放及零自动重试，不声称即时断连取消。可信 human-control/Work 浏览器组装仍需独立验收。

`--suite portability` 或 `runPortabilityContracts(target)` 只需基本临时目标。
它创建来源 Bot、私有记忆和自行编写并审阅的 MIT `SKILL.md`；验证元数据/v2 原始下载字节、强 `If-Match`、
checksum/审阅绑定、隐私排除、严格 JSON、隔离预览及包/激活拒绝；再验证并发幂等激活只产生一份新身份/回执，
技能为 candidate、模型使用关闭。上传使用 `application/json`；Employee 专用 MIME 用于下载，导入请求拒绝该 MIME。
缺少 publisher 信任验证拒绝，签名导入导出成功仍需要可选真实 keyring。只删除本次身份；预览不创建身份、记忆或 Host 权限。

`--suite publisher` 是另行配置的签名变体，与未签名 `all` 组装分开执行。
独占运行器用现有离线 CLI 初始化临时加密 keyring，通过既有两项 `OPENBOT_CONTROL_PUBLISHER_*` 配置启动真实
`serve.py`，成功或失败均删除整个私有临时目录；不加载 `.env`，不输出私钥/口令。
其他临时目标只向夹具增加 `publisher: { keyid, publicKey }`：`keyid` 为 `ed25519:` SPKI-SHA256 指纹，
`publicKey` 为有界公开 PEM。`runPublisherContracts(target, publisher)` 独立核验已审阅 v1/v2 原始字节与 Ed25519
签名、可信隔离预览、篡改/裸签名文档/自带非可信公钥拒绝、不具有授权效力的签名提示，以及审阅绑定的并发激活。
只产生一份签名回执，技能保持 candidate/未启用，不导入记忆或 Host 授权。夹具拒绝私钥、口令和 keyring 路径；
未签名套件仍必须验收缺少信任时的拒绝。

`--suite models` 或 `runModelContracts(target)` 只使用基本私有夹具，要求另行组装合成模型传输。
独占驱动启动 [`contract-model-fixture.py`](../../apps/server-python/scripts/contract-model-fixture.py)，
通过既有可信构造工厂注入真实 `serve.py`；产品配置、请求头或路由不能选择此行为。
Owner HTTP、连接加密持久化、SDK 序列化和当前版本检查仍真实执行。
覆盖 OpenAI Chat/Anthropic 发现与探测成功、过滤/去重/256项上限、未保存验证、无效凭据、跳转、无效 JSON、
过大声明响应及服务不可用；私密诊断和凭据不能进入公开错误。
独占回执要求恰好10次发现、4次显式无工具探测，越权派发/重试/回退均为零，只记录次数。
不连接真实提供商或加载 `.env`。这证明 API/SDK 传输契约，不代表真实模型/Task 执行。
CI 分别要求未签名 all、签名 publisher 和 models 三次独立临时运行。

使用 `--suite control` 或 `--suite all` 时，在同一私有夹具中加入临时 Owner 的 `password`。
两种模式都会执行认证和密码变更，使夹具的会话与旧密码失效；每次运行都准备新的空闲临时目标。
`runControlContracts(target, password)` 可用于 TS/混合目标；`--suite all` 还需要 `work`、`lifecycle`、`employee`、`nodes`、`artifacts`、`plugins` 和 `browser`，
依次执行 Work、resources、lifecycle、Employee、automations、browser、portability、nodes、artifacts、plugins、control。
浏览器注册先于 Node 套件的刻意 bootstrap 限流。
拒绝重定向，不记录秘密；响应字节及 SSE 有大小和时限约束，所有流均显式关闭。
SSE 验证消息变更、慢速读取合并后刷新权威状态、频道墓碑及工作区/频道密码撤权；通知不带内容或 replay ID。
饱和传输压力尚未验证。客户端另拒绝 UTF-8 截断、不完整帧和实际 UTF-8 超过4MiB；合成分帧测试不冒充产品压力证据。
