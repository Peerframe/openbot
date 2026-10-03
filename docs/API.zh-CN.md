# 本地 API

[English](API.md) · [简体中文](API.zh-CN.md)

所有接口由 OpenBot Server 提供，开发环境默认地址为 `http://localhost:3001`。除健康检查、会话状态和登录外，所有 `/api/v1` 接口都要求有效的本地 Owner Session。Server 不应直接暴露到公网；远程使用优先通过 Tailscale 与 HTTPS。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/health` | Server 存活状态 |
| `GET` | `/api/v1/auth/session` | 读取当前 Owner 会话状态 |
| `POST` | `/api/v1/auth/login` | 使用部署密码创建 Owner Session |
| `POST` | `/api/v1/auth/logout` | 撤销当前 Session 并清除 Cookie |
| `GET` | `/api/v1/bootstrap` | 轻量计数与阶段信息 |
| `GET` | `/api/v1/workspace` | 频道、Bot、Node、Run、Approval、Progress、Artifact 和计数的一次性投影 |
| `GET` | `/api/v1/workspace/events` | 订阅全局 Node、Run 与 Approval 变化（SSE） |
| `GET` | `/api/v1/channels` | 频道与 Bot roster |
| `POST` | `/api/v1/channels` | 创建频道并原子加入初始 Bot |
| `POST` | `/api/v1/channels/:channelId/bots` | 把已有 Bot 加入频道 |
| `PATCH` | `/api/v1/channels/:channelId` | 重命名群组频道（记入审计） |
| `DELETE` | `/api/v1/channels/:channelId` | 永久删除频道内容并保留墓碑 |
| `POST` | `/api/v1/channels/:channelId/read` | 把频道标为 Owner 已读 |
| `GET` | `/api/v1/channels/unread` | 各频道未读的 Bot/系统消息数（上限 99） |
| `GET` | `/api/v1/audit` | 最新审计事件，字段按白名单投影 |
| `GET` | `/api/v1/channels/:channelId/messages` | 分页读取本地频道消息（before/limit，最多100条）与 Bot 回复关系 |
| `POST` | `/api/v1/channels/:channelId/messages` | 原子保存用户消息并创建排队任务 |
| `GET` | `/api/v1/channels/:channelId/runs` | 读取频道最近 50 个任务 |
| `GET` | `/api/v1/channels/:channelId/events` | 订阅频道实时事件（SSE） |
| `POST` | `/api/v1/approvals/:approvalId/decision` | Owner 批准一次或拒绝一个待批动作 |
| `GET` | `/api/v1/artifacts/:artifactId/content` | 鉴权读取任务产物；当前仅 PNG 截图 |
| `GET` | `/api/v1/runs/:runId/frame` | 鉴权读取任务最新临时画面；不持久化 |
| `GET` | `/api/v1/bots` | Bot 名册 |
| `POST` | `/api/v1/bots` | 创建 Bot |
| `POST` | `/api/v1/bots/quick` | 原子创建默认 Bot 及其单聊 |
| `PATCH` | `/api/v1/bots/:botId` | 重命名 Bot 及其单独对话（记入审计） |
| `DELETE` | `/api/v1/bots/:botId` | 永久删除 Bot 的内容与授权并保留墓碑 |
| `GET` | `/api/v1/bots/:botId/profile` | 读取数字员工档案、进化、技能、记忆与工作记录 |
| `PATCH` | `/api/v1/bots/:botId/profile` | 按预期 revision 修改职责与简介 |
| `POST` | `/api/v1/bots/:botId/memories` | 新增一条有界 Owner 记忆 |
| `PATCH` | `/api/v1/bots/:botId/memories/:memoryId` | 按预期 revision 更新一条记忆 |
| `DELETE` | `/api/v1/bots/:botId/memories/:memoryId` | 按预期 revision 删除一条已确认记忆 |
| `POST` | `/api/v1/bots/:botId/skills` | 登记一个待 Owner 审核的候选技能元数据 |
| `POST` | `/api/v1/bots/:botId/skills/:skillId/state` | 由 Owner 验证、暂停或永久撤销技能 |
| `GET` | `/api/v1/bots/:botId/export/preview` | 预览默认脱敏员工模板及全部排除项 |
| `GET` | `/api/v1/bots/:botId/export` | 使用 `If-Match` 下载刚审核的精确员工模板实例 |
| `POST` | `/api/v1/employees/import/preview` | 在隔离区严格检查员工模板，不写入任何员工数据 |
| `POST` | `/api/v1/employees/import/activate` | 重新检查 Owner 已确认的模板并原子创建一个零权限新员工 |
| `GET` | `/api/v1/nodes` | 当前在线执行节点 |
| `GET` | `/api/v1/node-identities` | Owner 读取安全的已登记 Node 元数据；不返回令牌或凭证摘要 |
| `POST` | `/api/v1/nodes/enrollment-tokens` | Owner 为准确 Node id 创建短时单次登记令牌 |
| `POST` | `/api/v1/nodes/enroll` | Node 用单次令牌换取独立凭证；唯一无需 Owner Session 的 `/api/v1` 接口 |
| `POST` | `/api/v1/nodes/:nodeId/revoke` | Owner 吊销一台 Node 并断开其在线连接 |

在线 Node 投影包含 `platform`、`osVersion`、`architecture`、`deviceClass`、`isolation`、
`trustTier`、临时保留的旧版 `capabilities` 和权威版本化 `capabilityManifest`。协议 `0.9.0`
要求 Server 路由与 Node 接单同时匹配精确能力主版本；旧能力 id 不能替代缺失或版本不兼容的
manifest。该协议使用严格消息对象：未知字段、重复能力、错误或超长 Node 身份信息和无界审批
现场都会失败，而不会被静默忽略。非 loopback Node Server 地址必须使用 `wss:`。单次令牌默认
十分钟过期，兑换后 Server 只保存摘要；独立凭证可以按 Node 吊销，但当前仍是可复制的 bearer
secret，不等于生产级持有证明身份。能力声明本身仍不授予执行权限。

## 本地 Owner 会话

登录请求：

```json
{
  "password": "部署时设置的 OPENBOT_OWNER_PASSWORD"
}
```

成功后，loopback HTTP 开发环境设置 `openbot_session` Cookie；HTTPS 环境设置浏览器强制仅限
主机的 `__Host-openbot_session` Cookie。两者均为 `HttpOnly`、`SameSite=Strict`、`Path=/`，有效期
由 `OPENBOT_SESSION_TTL_HOURS` 控制；HTTPS Cookie 另带 `Secure`。配置中的非 loopback Origin
必须使用 HTTPS 且同时启用 `OPENBOT_SECURE_COOKIES=true`，否则 Server 会在监听端口前退出。
数据库只保存随机 Token 的 SHA-256 摘要，不保存 Token 或 Owner 密码；退出与过期会话均无法
继续访问 API。

所有非只读请求都必须携带与请求自身 origin 或 `OPENBOT_ALLOWED_ORIGINS` 中某一项精确匹配的
`Origin`。浏览器 CORS 访问仍只允许配置列表；Desktop main process 只会在用户验证并通过原生窗口
确认 Server origin 后使用同源情况。部署密码至少 15 个字符。
五分钟内第五次尝试后，同一客户端桶会阻止后续尝试五分钟；PostgreSQL 会在 Server 进程和重启之间
原子保存该状态。桶键是直接对端 IP 的域分隔摘要；只有直接对端等于
`OPENBOT_TRUSTED_PROXY_ADDRESS` 时才接受单个 `Forwarded: for=...` 跳。这是经摘要化的滥用防护，
不是可信的每设备身份，Server 仍只能部署在可信私网。当前为单 Owner 模型，不提供注册、找回密码
或多用户权限；修改部署密码后应重启 Server，并主动退出现有设备。

频道与工作区 SSE 每个订阅最多保留 128 个待发送投影。慢客户端达到上限后连接会被关闭，Web
客户端重连并重新读取数据库权威快照；Server 不会静默丢弃某个事件后继续伪装为连续流。

## Owner 密码与登录会话（C2）

- `GET /api/v1/auth/sessions` 返回 `{ sessions: [{ id, userAgent, current, createdAt, expiresAt }] }`，
  按创建时间倒序列出有效会话，最多 100 个。ID 不是登录凭据，不返回 token、摘要或 IP。
  `userAgent` 是最多 256 个码点的不可信提示，旧会话为空；登录不会创建超过上限的有效会话。
- `POST /api/v1/auth/sessions/revoke-others` 需要当前 cookie 与精确匹配的 Origin，无需正文。
  返回 `{ revoked: number }`，保留发起会话，在同一事务记录 `OWNER_SESSIONS_REVOKED` 和撤销数量。
- `POST /api/v1/auth/password` 需要 cookie、精确 Origin 和 `{ currentPassword, newPassword }`，
  拒绝多余字段，不裁剪空格。旧密码为 1–1024 个码点，新密码为 15–1024 个码点，拒绝示例密码，
  沿用 8192 字节请求上限。成功返回 `{ changed: true, reauthenticationRequired: true }`，
  清除 cookie、撤销全部会话并原子记录 `OWNER_PASSWORD_CHANGED`。
  旧密码错误或会话无效为 401，限流为 429（含 `Retry-After`），输入错误为 422；
  存储或审计失败为 503，不修改密码、撤销会话或清除 cookie。

修改后的密码以带随机盐的标准库 scrypt（N=32768、r=8、p=3）哈希保存在 PostgreSQL。
已有保存的凭据后，环境密码只作为初始配置，重启不会覆盖修改结果。
凭据版本和共享事务锁拒绝在密码修改前生成的登录校验证明。
备份数据库时同时保留 `owner_credentials`。此功能不提供密码找回或可信设备身份；
失去 Owner 登录凭据时仍需通过部署管理路径处理。

## 创建 Bot

```json
{
  "name": "Ops",
  "role": "浏览器操作与日常运营",
  "computerProfile": "docker-linux"
}
```

`computerProfile` 只能是 `none`、`docker-linux`、`macos-cua`、`lume-vm` 或 `coder`。Bot 名称在当前本地工作区唯一。

创建 Bot 时，Server 会在同一事务内写入一条不可变的 `created` 进化事件。Bot 是数字员工身份本身；系统不会建立第二套重复的 Employee 身份。

## 读取数字员工档案

`GET /api/v1/bots/:botId/profile` 返回 Owner 可见的数字员工聚合投影：

- `employee`：姓名、职责、状态、外观和固定执行配置；
- `details`：说明性简介、Server revision 和最后更新时间；
- `evolution`：有来源和证据引用的追加式进化事件；
- `skills`：版本、依赖、所需能力、验证状态与证据置信度；
- `memories`：按类型、敏感度和可迁移策略分类的记忆；
- `memoryEvents`：不包含标题和正文的记忆生命周期审计；
- `records`：该员工最近的 Run、Approval、Artifact 与结构化决策摘要；
- `statistics`：最近 50 个 Run 的结果计数与已验证技能数；
- `configuration`：执行配置和可移植员工包格式版本。

`records.decisions` 只来自 Worker Host 上报并持久化的 `RUN_PROGRESS` 事件，用于解释阶段、已观察事实和下一步动作。它不是模型原始思维链，也不允许 Provider 把隐藏提示、密钥或私有推理写入其中。

技能的 `confidence` 表示证据质量，不会授予电脑权限；真正的执行权限仍由 Server 的 Node 路由、策略、审批和后续 capability lease 独立决定。记忆的 `portability` 也只是导出候选策略，导出时仍需重新过滤和 Owner 确认。

### 修改说明性主页详情

`PATCH /api/v1/bots/:botId/profile` 只接受 Owner 已检查的完整职责、简介和 revision：

```json
{
  "role": "证据审核员",
  "description": "先审核证据并记录限制，再输出结论。",
  "expectedRevision": 1
}
```

Server 会去除两端空白，要求职责非空且最多 160 字符，简介最多 2,000 字符。旧 revision 返回
`409`；没有实际变化或夹带权限字段返回 `422`。成功事务会增加 revision，并追加只记录变更字段名、
不保存简介正文的进化事件；Workspace SSE 也只发送员工 id 与受影响分区。显示名、模型策略、工作
主机、外观、技能状态和授权明确不属于这个命令。

## Server 通用偏好（C7）

`GET /api/v1/settings/general` 向已登录 Owner 返回 `{revision,timezone,defaultModel,updatedAt}`。
`PUT /api/v1/settings/general` 要求精确允许的 Origin 和最多 2 KiB 严格 JSON：
`{expectedRevision,timezone,defaultModel}`。修订号为 1–2147483647 整数，旧修订写入返回
`409 owner_preferences_revision_conflict`。时区为有界 IANA 标识，由 Server ZoneInfo 验证，默认 `UTC`；
未知或非法时区返回 422。默认模型必须显式为 null 或既有 `{connectionId,modelId}` 选择，
拒绝密钥、地址、命令和未知字段。读取保留已失效的选择，便于 Owner 清除或替换。

单例设置与 `SETTINGS_OWNER_UPDATED` 审计在同一 Owner 事务提交。无变化不增加修订号，
审计只记变更字段名与修订，不含凭据。时区供 Owner 展示使用，由调用端格式化既有 UTC 时间；
不重新解释历史时间或既有例行任务。

新建 `model` 或 `docker-linux` Bot 且省略模型时，在身份事务内读取当前默认模型；显式选择优先。
`none` 等计算机类型不继承模型能力，既有 Bot 不变。发布 Bot、进化记录与审计前解析当前启用连接、
地址策略及凭据；默认连接缺失、禁用或不可用时失败关闭，不发布 Bot、不改用其他模型。
设置默认值不会请求供应商、发现模型、推理或产生费用。

`0046_owner_preferences` 迁移建立初值为修订 1、UTC、null 模型的单例。
本独立 PR 与 C2 都追加当前迁移历史；合并第二个迁移 PR 前，必须基于先合并的迁移重新 rebase/编号，
禁止替换已提交历史。

## Owner 管理员工记忆

当前记忆生命周期只允许登录 Owner 手动使用，模型、Provider 与工作主机都没有这些命令。标题
最多 160 字符，正文最多 8,000 字符，未知字段会被拒绝。标题和正文中的疑似凭据值、Bearer
Token 与私钥会被阻止；只能保存 `vault://operations/email` 这类不透明密码库引用。

新增记忆：

```json
{
  "kind": "semantic",
  "title": "报告格式偏好",
  "content": "先写简短结论，再附来源表格。",
  "sensitivity": "internal",
  "portability": "owner-selectable"
}
```

`kind` 可以是 `working`、`episodic`、`semantic`、`procedural` 或 `secret-reference`；
`sensitivity` 可以是 `public`、`internal`、`confidential` 或 `restricted`。Owner 命令只能设置 `never` 或
`owner-selectable`；`included` 会被拒绝，因为 `openbot.employee/v1` 固定导出零条记忆。
`secret-reference` 必须是 `restricted` 和 `never`，正文只能是引用，不能是真实秘密。

更新必须至少改变一个字段并携带 Owner 看过的 revision：

```json
{
  "expectedRevision": 1,
  "content": "先写五行以内结论，再附来源表格。"
}
```

只有当前 revision 匹配时才更新并递增；过期编辑返回 `409`，不会覆盖别人的变化。

删除使用独立确认命令：

```json
{
  "expectedRevision": 2,
  "ownerReviewed": true
}
```

删除会物理移除记忆记录。同一事务追加的审计事件只包含员工 ID、记忆 ID、动作、revision、变化
字段、操作者与时间，不保存标题、正文、来源或内容哈希。语义/全文检索、定时保留、自主改写有效记忆、版本
恢复和选择性导出仍未实现。

## 审核员工技能元数据

`POST /api/v1/bots/:botId/skills` 只创建 `candidate`。`slug` 使用 Agent Skills 兼容的英文小写、
数字和连字符格式，最多 64 字符；`description` 必填且最多 1,024 字符。Server 会去重所需能力和
前置技能，并要求每项前置技能已经属于同一员工且为 `verified`。请求不能携带 `state` 或
`confidence` 来绕过审核。

```json
{
  "slug": "source-triangulation",
  "name": "Source triangulation",
  "description": "Compare independent primary sources before reporting a conclusion.",
  "version": "1.0.0",
  "source": "learned",
  "requiredCapabilities": ["browser.observe"],
  "dependencySkillIds": [],
  "evidence": [{ "kind": "run", "id": "run-reference" }],
  "reason": "Repeated successful Runs produced a reusable procedure."
}
```

`POST /api/v1/bots/:botId/skills/:skillId/state` 接受 `verified`、`suspended` 或 `revoked`。
每次变更必须包含非空原因和字面值 `ownerReviewed: true`；鉴权 Session 证明请求者就是当前单
Owner。验证还需要 1–100 的 `confidence`，并再次确认全部依赖仍为已验证。撤销是终止状态，
不能恢复；并发审核以 `409` 失败，不会后写覆盖先写。员工主页会先展示保存的说明、来源、版本、
所需主机能力名称、依赖与证据引用，再只显示当前状态允许的变更；永久撤销使用单独确认表单。

```json
{
  "state": "verified",
  "confidence": 88,
  "reason": "The Owner reviewed the procedure and evidence.",
  "ownerReviewed": true,
  "evidence": [{ "kind": "manual", "id": "owner-review-1" }]
}
```

每次成功变更都会在同一事务内追加 `skill_discovered`、`skill_verified`、`skill_suspended` 或
`skill_revoked` 进化事件。这个接口只管理档案元数据：不会安装或执行 `SKILL.md`，也不会修改
Node、Provider、路由、审批策略或主机授权。完整技能目录将在后续隔离导入时采用开放的
[Agent Skills](https://github.com/agentskills/agentskills) 规范和官方 `skills-ref` 校验器。

## 已审核插件目录（C8）

`GET /api/v1/plugins/catalog` 验证 Owner 后返回有界版本化目录：
`{format:"openbot.reviewed-plugin-catalog/v1",revision,entries}`。拒绝查询参数，不远程发现或安装。
条目包含 slug `id`、有界名称/说明、`distribution`（`self-hosted-template|self-hosted`）、准确版本、
许可证、包含 40 位 `sourceCommit` 的 HTTPS `sourceUrl`、1–16 个附 SHA-256 的源文件，及
`review:{status:"reviewed",reviewedAt,reviewedBy,record,scope}`。protocol/domain 导出 schema 与类型。

只发布明确审核记录。源最多 64 KiB、32 条；重复 JSON 键/条目/路径、待审核或拒绝记录、
未知凭据或 endpoint 字段、不安全地址、非法摘要使整个源返回 `503 plugin_catalog_unavailable`。
内置目录收录已实际审核的 OpenBot 笔记本开发模板，附 main 准确提交及源码哈希。
该模板需要另行部署与配置地址，并沿用实时清单审核和显式授权；目录条目本身不授予权限或代表安装。

运维可设置 `OPENBOT_PLUGIN_CATALOG_PATH`，指向同格式、绝对规范路径的 Owner 私有普通文件，
通过既有有界 owned-file 读取。渲染层、Worker、模型及导入插件内容均不能选择源。
损坏目录不冒充成功的空目录。未宣称任何远程第三方服务已完成审核：本环境公共文档 MCP 的
实际审核被现有非公网 DNS 边界拒绝。

## 导出安全员工模板

`GET /api/v1/bots/:botId/export/preview` 与下载共用同一条规范包准备路径。每次预览会生成新的
`packageId`、`generatedAt` 和 `downloadReviewToken`。该令牌是目标下载表示的强实体标签不透明值，
也就是最终格式化 JSON 精确字节的 SHA-256；配置签名时也包含 DSSE 信封。它不是凭证，也不能
授予权限。返回值的 `employee`
投影会精确列出模板选中的名称、职责、可选说明性简介和外观；有序的 `skills` 投影会逐项列出
每个已验证技能的 slug、名称、Agent Skills 说明、版本、请求能力和依赖 slug。`employeeName`
仅作为 `employee.name` 的 v1 弃用兼容别名继续保留。预览同时返回校验和、明确排除项和阻止原因。
v1 默认模板不包含任何记忆，也不包含来源员工 ID、所有权、Run、
进化历史、决策、产物、审批、Node 身份、主机绑定、凭证、Session 或能力授权。

`GET /api/v1/bots/:botId/export` 只在预览没有阻止项时返回模板。默认媒体类型为
`application/vnd.openbot.employee+json`；配置 Owner 发布者密钥库后，返回
`application/vnd.openbot.employee.dsse+json` DSSE 信封。Server 会检查导出自由文本中的疑似凭证、Bearer Token、
私钥标记和用户本地路径；命中后返回 `422`，不会生成下载。包内 SHA-256 对规范化 `payload`
提供意外修改检测；无签名模板的 `signature.status` 是 `unsigned`，不能证明发布者身份。导入功能
始终先隔离校验，未来创建新的本地员工 ID 时，所有导入技能仍必须保持禁用，直到 Owner 完成
本地策略审核。

每个导出的已验证技能还必须把全部技能依赖放在同一个已验证集合中。如果某项依赖仍是候选、
已暂停、已撤销或已经不存在，预览会返回 `excluded-skill-dependency` 并阻止下载，不会静默删掉
依赖后伪装成完整技能。

下载必须把审核过的 `packageId` 和 `generatedAt` 放回查询参数，并在 `If-Match` 中返回预览的
`downloadReviewToken` 作为一个带引号的强实体标签放进 `If-Match`：

```http
GET /api/v1/bots/{botId}/export?packageId={uuid}&generatedAt={编码后的-ISO-8601}
If-Match: "{downloadReviewToken}"
```

Server 使用当前权威档案和发布者状态、以及同一个包身份重新构建候选文件，只有完整序列化字节
仍一致才会返回。缺少审核条件返回 `428 Precondition Required`；格式错误或弱标签返回 `422`；
内容或发布密钥已变化则返回 `412 Precondition Failed`，要求重新预览。Client 会刷新预览，但绝不
自动重试下载。预览、错误和下载响应都使用 `Cache-Control: no-store`。
Web Client 在创建浏览器下载前，还会要求响应 `ETag` 一致，并用原生 Web Crypto 对收到的 `Blob`
重新计算 SHA-256；任何不一致都不会产生文件。

建议下载文件名使用有界的小写 ASCII slug 和固定 JSON 后缀。员工名中的路径、控制、引号和扩展名
输入会被移除；`CON`、`NUL`、`COM1`、`LPT1` 等 Windows 设备名会被消歧。这样同一个确定性回退名
可在 Windows、macOS 与 Linux 使用，同时员工包内部仍保留完整显示名。

代码内已经有 DSSE/Ed25519 签名与验证原语，并使用固定版本的 `@sigstore/core` 生成标准预认证
编码。它签署 `application/vnd.openbot.employee.v1+json` 的精确字节，且只信任 Server 显式配置、
真正通过验签的公钥；信封 `keyid` 只用于查找，不能授予信任。实验性的文件密钥库用加密 PKCS#8
保存活动私钥，离线 CLI 负责初始化、显式信任、轮换和撤销。密钥库一旦显式配置但无法安全加载，
Server 会拒绝启动而不是退回无签名模式。使用方法见[员工包签名手册](EMPLOYEE_SIGNING.zh-CN.md)。

`POST /api/v1/employees/import/preview` 接受整个 v1 员工模板或 DSSE 信封 JSON，最大 2 MiB。
无签名模板使用严格 schema；签名信封必须先由活动、已退役或外部显式信任的公钥验证，之后才
解析同一份已认证字节。未知格式、未信任或已撤销签名都会返回 `422`。通过验证后，Server 检查 SHA-256、
技能 slug 与依赖、技能实际能力和顶层能力声明是否一致、疑似敏感文本，以及当前在线工作主机
能否满足执行配置和全部能力。

成功响应只是一份 `quarantine.active: true` 的只读投影。没有阻止项时
`quarantine.canActivate` 为 `true`；`createsNewIdentity` 固定为 `true`，
`importedSkillState` 固定为 `disabled-pending-review`，`hostAuthority` 固定为 `none`。该接口
不写入 Bot、技能、记忆、Node 绑定或权限。`integrity.digest` 是严格解析后员工包的规范摘要，
客户端必须在激活时原样提交。`employee` 投影会返回已检查的名称、职责、可选简介与外观；客户端
应在确认前展示简介和 `requestedCapabilities`，并明确它们只是未受信任的输入，不是已经授予的权限。
每个 `skills` 项都会保留 Agent Skills 要求的说明、版本、请求能力和依赖 slug，方便 Owner 检查
将要创建的禁用候选技能；v1 不携带任何可执行技能文件。

`POST /api/v1/employees/import/activate` 接受如下 JSON：

```json
{
  "package": {},
  "expectedPackageId": "uuid-from-preview",
  "expectedDigest": "sha256-from-preview",
  "ownerReviewed": true,
  "allowUnsigned": false,
  "idempotencyKey": "new-request-uuid",
  "employeeName": "Optional local name"
}
```

Server 会对 `package` 重复执行同一套严格解析、签名验证、校验和、敏感文本和当前主机兼容性
检查。规范摘要包含已验真的发布者密钥 ID，因此即使换成另一个同样受信任的发布者，也必须重新
审核；纯 JSON 空白差异不构成不同身份。包 ID 或摘要与预览不一致时返回 `409`；任一检查阻止时返回 `422`。未签名包只有在
`allowUnsigned: true` 时才能激活。成功后，单个 PostgreSQL 事务会生成新的员工 ID，复制职责、
外观和推荐执行配置，把所有技能作为 `candidate`、置信度 `0` 导入，追加 `imported` 进化事件，
并写入不可变收据。不会导入记忆、历史、凭证、Session、Node 绑定、能力授权或其他权限。

同一个幂等键和同一请求可以安全重试并返回原收据；同一键对应不同请求或同一 `packageId` 再次
激活会返回 `409`。若要在同一 Server 再复制一次，来源端必须导出带新 `packageId` 的新模板。

## 重命名、删除、已读状态与审计

这些 Owner 接口由 [ADR-0047](decisions/0047-identity-lifecycle-and-read-state.md) 定义。重命名请求体为
`{ "name": string }`，沿用创建时的限制（去除首尾空白后 Bot 1–64、频道 1–80 个 UTF-16 单元），未知字段
会被丢弃。与现存对象重名返回 `409 name_already_exists`；单独对话跟随其 Bot，返回
`409 direct_channel_identity_follows_bot`。

删除会移除内容，但保留行作为墓碑，使任务、Work、审批和审计仍能解析。删除频道会移除没有被持久 Work
引用的消息（被引用的消息保留行并替换为固定占位内容）、回应、成员、自动任务和已读状态。删除 Bot 还会移除
它的单独对话、频道成员身份、自动任务、记忆、技能、知识提议、进化记录和插件授权。只要有进行中的任务就返回
`409 active_work_blocks_delete`，Server 不会替删除操作取消任务。Bot 删除响应包含 `pluginGrantsRemoved`；
为 `false` 表示墓碑提交后未能更新加密的授权文件，残留授权对已无法运行的 Bot 不起作用。两种删除响应都包含
`attachmentsRemoved`；为 `false` 表示频道附件文件未能删除，仍留在磁盘上，但任何现行接口都无法读取。墓碑在所有现行
入口返回 `404`，名称可以重新使用。

`GET /api/v1/channels/unread` 返回 `{ "unread": { channelId: count } }`，只包含 Owner 最后一次
`POST .../read` 之后有 Bot 或系统消息的频道。`GET /api/v1/audit?limit=1..100&before=<nextBefore>` 返回
`{ events, nextBefore? }`；`nextBefore` 是不透明的键集游标（精确时间加事件 id，同一事务写入的事件不会被跳过）；每条事件包含类型、时间、各 id、当前或已删除的名称，以及白名单内的标量字段，
从不包含消息正文。

## 审计分类与 CSV（C3）

`GET /api/v1/audit` 新增可选 `category`：`authentication`、`settings`、`hosts`、`approvals`、
`channels`、`bots`、`runs`、`plugins`、`other`。省略时返回全部类别，每条事件包含服务端分类。
分类在 SQL 中先于精确时间/ID 游标分页执行。未知或重复查询参数、未知类别和错误上限为 422；
JSON 每页仍为 1–100 条。

`GET /api/v1/audit/export` 接受同样的类别和游标，`limit=1..1000`，默认 1000。
下载带 BOM 的 UTF-8 CSV（`openbot-audit.csv`），完整引用单元格并使用 CRLF。
列为事件 ID、时间、类别、类型、频道/Bot ID 与名称、Run ID 和白名单详情。
可能触发公式的单元格以单引号转义。沿用 Owner 鉴权和 no-store，不导出提示词、密钥、
工具参数或网络摘要，每页最多 4 MiB。未结束时返回可跨域读取的 `X-OpenBot-Next-Before`；
将其作为下页 `before`，解析并拼接数据行即可导出更长历史，拼接时不重复标题和 BOM。
这是分页历史导出，不是单一事务的全库归档。

登录成功、密码错误和退出登录分别写入 `AUTH_LOGIN_SUCCEEDED`、`AUTH_LOGIN_FAILED`、`AUTH_LOGOUT`，
不记录秘密；已限流请求不重复生成无界事件。登录审计与 C2 的凭据 revision 校验和会话写入
属于同一事务，并保留有长度上限的 user-agent 提示。审计存储失败返回 503，不发出 cookie，
也不提交会话或限流变更。旧模型设置最终发布在授权事务内记录
`SETTINGS_MODEL_UPDATED`，审计失败恢复旧文件；保留已有模型连接事件。
主机注册、撤销、实际连接与断开记录 `WORKER_HOST_*`；私有网络摘要留在身份账本。
连接事件持久化失败不提供主机可用性；物理断开时仍完成清理，审计失败记录固定错误。

## 创建频道

```json
{
  "name": "运营中心",
  "description": "处理日常运营任务并保留完整上下文",
  "botIds": ["00000000-0000-4000-8000-000000000001"]
}
```

频道与初始 roster 在同一数据库事务中写入；任一 Bot 不存在时整次创建失败。创建 Bot、创建频道和加入频道都会写入结构化事件，供后续 realtime、audit 和办公室状态投影使用。

## 发送频道任务

```json
{
  "content": "打开测试页，填写表单但不要提交",
  "botId": "可选；必须是该频道成员的 Bot ID"
}
```

消息正文会先去除首尾空白，长度限制为 1–8000 个字符。一次请求会在同一数据库事务中创建 `human` 消息、状态为 `queued` 的 Run、`MESSAGE_CREATED` 和 `RUN_CREATED` 事件。Run 通过唯一的 `sourceMessageId` 关联来源消息，避免同一输入被投影为多个任务。

若传入 `botId`，Server 只接受频道 roster 内的 Bot；未传入时确定性地优先选择名称或职责为 Chief/总管/协调/调度的成员，否则选择 roster 中稳定排序的首位成员。空频道和越权指定均返回 `422`。模型与 Client 不能绕过这条成员边界。

成功响应包含 `{ message, run }`。Server 随后向频道 SSE 订阅者依次发布 `message.created` 与 `run.created`；Web 分别按消息 ID 和 Run ID 合并快照与实时事件，因此刷新、重连和并发写入不会产生重复投影。

Run 会把接单 Bot 当时的 `computerProfile` 固化为 `executionProfile`，不会在运行中由 Client、模型或 Node 改写。若存在兼容且未满载的在线 Node，Server 会通过版本化 WebSocket 协议发出 offer；Node 接受、Server 在短事务中条件认领成功并发送 confirm 后，Run 进入 `assigned`。Node 再请求启动，Server 条件更新为 `running` 后才发 `run.start`；进度写入结构化事件并实时投影到频道，最新画面只进入受限内存缓存，成功结果和 Artifact 元数据在同一数据库事务中落库，随后 Server 发 `run.settled` 释放节点容量。

尚未执行的 `assigned` Run 在节点断线或 Server 恢复时回到 `queued`；已经 `running` 的 Run 则明确失败，不会在外部副作用未知时自动重跑。当前 Docker provider 只接受任务正文中的一个明确 HTTP(S) URL，只执行 `/navigate` 与 `/screenshot`，不点击、不填写、不提交。截图正文保存在 Server 文件存储，数据库只保存引用、SHA-256、大小和元数据。

`run.failed` 只携带白名单代码与通用说明。当前代码为 `provider_unavailable`、
`provider_execution_failed`、`artifact_persistence_failed`、`execution_interrupted`、
`node_disconnected`、`approval_policy_denied` 和 `dispatch_failed`。Server 会独立按代码映射
说明，并在写入 Run 或事件前丢弃 Node 提供的失败文本；Provider 异常、stack、token 与本地路径
都不属于公开错误契约。被捕获的后台调度失败会另写一条有界 `DISPATCH_FAILED` 审计，只包含
Run、已权威分配的 Node、阶段和公开代码；若该二次写入本身失败，只记录一次日志，不递归审计。

## Owner 额外审批设置（C4）

`GET /api/v1/settings/approvals` 返回 `{revision,productRead,publicWeb,exceptions,
protectedExceptionCategories}`。`PUT` 要求 Owner Cookie、精确 Origin 和 ≤16KiB 严格 JSON：
`{expectedRevision,productRead,publicWeb,exceptions}`。内置产品读取/公网读取两类 Work 操作支持
`inherit`（适配器最低要求）与 `required`（增加确认）。版本冲突409
`approval_policy_revision_changed`；策略缺失/损坏503。同值不增加版本，变更与
`SETTINGS_APPROVAL_UPDATED` 审计原子提交，仅记录模式/数量/版本，不复制私有目标。
protocol/domain 提供严格类型与 schema。

最多64个精确例外：`{botId,category:"product_read"|"public_web",target:{kind,value}}`。
频道/附件为规范 UUID，网页为无查询、片段、凭据、通配符和字面 IP 的规范 HTTPS URL。
保存时验证存活 Bot 与未删除本地目标；执行时继续检查任务/原来源/身份和公网 DNS、重定向、
字节上限。搜索、域名范围、前缀与文件路径不能例外。

**删除、安装、改权限永远不能例外。** 返回的受保护类别还包括命令、浏览器、插件与未知操作。
例外只取消 Owner 增加的确认，不能降低适配器强制审批或改变权限；直接 Owner 操作保留现有门禁。
提案、准入和读取/网页执行前复查策略；撤销/收紧后未批准的旧自动 Action 返回409
`approval_policy_changed`，需新提案；放宽不会改已有待审决定。已有精确批准与历史回执核对保持
有效。已发出的网页请求可能在策略提交后结束，不声称可取消远程效果，也不允许重发。
详见 [ADR-0049](decisions/0049-owner-approval-policy.zh-CN.md)。独立 C2/C7/C4 迁移在先合并项后
必须重新基于 main 编号，不能覆盖已提交历史。

## 订阅频道事件

`GET /api/v1/channels/:channelId/events` 返回 `text/event-stream`，当前事件如下：

| SSE event | data | 作用 |
| --- | --- | --- |
| `channel.ready` | `{ type, channelId, occurredAt }` | 确认订阅已建立 |
| `message.created` | `{ type, channelId, message }` | 投影一条已持久化的频道消息 |
| `run.created` | `{ type, channelId, run }` | 投影一条已持久化的排队任务 |
| `run.updated` | `{ type, channelId, run, artifacts? }` | 投影分配、运行、完成、失败和新产物 |
| `run.progress` | `{ type, channelId, progress }` | 投影已持久化的执行阶段和说明 |
| `run.frame` | `{ type, channelId, frame }` | 投影最新临时画面的版本、尺寸和时间；不含图片正文 |
| `heartbeat` | ISO 时间字符串 | 检测代理或 Server 形成的半开连接 |

Server 每 15 秒发送一次心跳。Web 超过 35 秒未收到任何帧会主动关闭连接，并以 2 秒间隔重连。每次收到 `channel.ready` 后，Web 都会重新读取最近历史，并按实体 ID 与 `updatedAt` 合并消息和 Run，以补齐断线期间写入的数据且不让旧 REST 快照覆盖较新的 SSE 状态。SSE 只承担 Server 到浏览器的下行投影；创建消息等命令继续使用 REST。

`GET /api/v1/workspace/events` 使用独立的全局 SSE。首帧 `workspace.ready` 包含当前在线 Node 权威快照，之后发送 `node.upserted`、`node.removed`、`run.updated`、`approval.updated` 与 `employee.profile.changed`。员工事件只包含 `botId`、非空白名单 `sections` 和 `occurredAt`，不携带记忆正文、技能证据或权限；正在查看这名员工的 Web 会重新读取鉴权档案聚合，而不会把 SSE 当成档案真相。重连收到 `workspace.ready` 后也会刷新当前员工，以补齐断线期间的变化。频道事件仍负责单频道消息、进度与画面，Workspace 事件负责跨频道总览。

审批决定正文为 `{ "decision": "approve" }` 或 `{ "decision": "reject" }`。Server 只接受 `pending` 状态且未过期的审批；每个审批只能决定一次，重复请求返回 `409`。批准会把 Run 恢复为 `running` 并把决定送回发起请求的 Node，拒绝或过期会把 Run 标记为 `blocked` 并取消 Node 执行。当前握手尚未签发独立、可验证的一次性 capability lease，因此只允许可信私网测试 provider 使用。

当前 realtime hub 是单 Server 进程内广播。需要运行多个 Server 副本时，必须先换成 PostgreSQL `LISTEN/NOTIFY`、Redis Streams 或 NATS 等共享事件总线，不能依赖进程内 fan-out。

Artifact 与临时画面内容接口使用同一个 Owner Session，响应为 `private, no-store` 并带 `X-Content-Type-Options: nosniff`。Web 不接收或暴露实际 `storage_key`；没有登录的浏览器不能读取截图。临时画面限制为 PNG 和 2 MiB，Server 最多保留 16 个 Run 的最新帧，每帧默认 2 分钟后过期；SSE 只发送元数据，图片由浏览器按 revision 单独读取。

## 员工浏览器生命周期（C6 候选）

`POST /api/v1/bots/{botId}/browser/maintenance` 要求 Owner cookie、严格允许的 Origin 和最多 1 KiB
严格 JSON：`{operation:"status"|"restart"|"clear",confirmation?:"clear-browser-data"}`。
只有 `clear` 必须附确认字段，其余操作拒绝该字段；拒绝未知字段、路径、URL 或命令。
返回 `{botId,nodeId,running:boolean,paused:boolean,profileBytes:number|null}`（详见下文 C23）。

Server 要求已绑定原浏览器身份或运维明确配置的 Bot→Node 路由，禁止选择替代主机。
原 Worker 必须声明 Docker Provider 的 `browser.maintenance@1` 与 `browser.session@1`。
在既有会话配置之外，明确设置 `OPENBOT_DOCKER_BROWSER_MAINTENANCE=true`；默认关闭。
状态读取上游 health，不启动浏览器；重启正常停止原浏览器，再通过既有截图路径启动，不返回截图；
清理仅删除该 Bot 的上游浏览器独立档案，并保持浏览器停止。

重启/清理在派发前持久化意图并使旧查看会话与 Work 观察失效；确认成功或结果不确定都保持
Server 暂停与 Provider 锁，Agent 恢复必须由 Owner 重新接管并明确交回。
派发与完成均复查 Origin、Owner 有效期、路由、凭据和当前精确 socket 身份。
事件只记操作、阶段与身份；不返回档案路径、cookie、页面内容或网络详情，不重试不确定操作。
此直接 Owner 清理操作永远不能成为审批例外。

保留设置仍待确定 Server 交付物或 Desktop 本地文件的数据范围；本候选不提供缺少实际执行路径的设置。


本次集成按 Owner 决定暂缓下载/截图保留设置；这些生命周期接口不启用保留策略或自动删除。

## 错误约定

- `401`：未登录、会话已过期或登录密码错误；
- `403`：非只读请求既不匹配请求自身 origin，也不匹配配置的精确 Origin；
- `429`：登录失败次数过多，调用方应遵循 `Retry-After`；
- `409`：频道或 Bot 名称冲突，审批已决定或已过期；
- `422`：输入字段或 roster 无效；
- `404`：频道或 Bot 不存在；
- `500`：未预期的 Server 错误，响应不会泄漏数据库细节。

每个响应都带 Server 生成的 `X-Request-Id`，CORS 响应也会向浏览器暴露它。未预期的 `500`
还返回 `code: "internal_error"` 与该 request id，但不返回异常原文。Server 和 Node 的运行日志为
结构化 JSON，遵循 `OPENBOT_LOG_LEVEL`，且只接受白名单 request/Run/Node 关联字段。HTTP 日志只记
不含 query 的路由路径，不记录 header、Cookie、正文、凭证、任意异常对象或 stack。

## Desktop 平台设置与更新（C5）

沙箱 `openbotDesktop` 桥接新增 `getPlatformState()`、`setPlatformPreferences(preferences)`、
`setUnreadBadge(count)`、`getUpdateState()`、`checkForUpdates()`、`downloadUpdate()` 和
`installUpdate()`。仅 Desktop 原生可用，Web 无对应 HTTP 权限。protocol/domain 导出类型。

设置为严格 DTO：`launchAtLogin`、`runInBackground`、`showDockBadge`、`automaticUpdates` 为布尔值，
`globalShortcut` 为空表示禁用，否则为有长度上限、含 Command/Control 修饰键的快捷键。
默认只有角标开启。主进程在自身 userData 私有文件中原子保存版本化设置；未知字段、不安全文件和
非法快捷键失败关闭。快捷键冲突保留原快捷键，保存失败恢复启动、托盘、快捷键与角标状态。

状态返回 `status`、`preferences`、平台 `capabilities` 和可选固定 `code`。
开机启动仅支持已打包的 macOS/Windows；Linux 开机启动、Windows 程序坞角标不可用。
后台运行依赖托盘，关闭最后窗口时隐藏窗口并保留本地服务；托盘提供显示与退出。
全局快捷键唤回同一窗口。角标接受 0–99999 安全整数，最多显示 99，关闭该设置或退出时清空。
设置写入、下载与安装要求隔离 preload 中的真实用户操作、聚焦窗口和可信顶层 frame。
IPC 不接受渲染层传入的命令、程序路径或更新地址。

更新状态为 `unavailable|idle|checking|available|downloading|downloaded|installing|failed`，
附可选有界版本、进度及固定错误代码。自动模式每六小时检查并下载已验证更新，安装始终要求
原生确认及本地 Server 正常停止。禁止降级与退出时自动安装。

更新复用 electron-updater 6.8.9，仅在签名 macOS/Windows 安装包中启用。
包内 `resources/app-update.yml` 必须是普通文件，内容为最多 4 KiB 的严格 JSON（YAML 子集）：
`openbotFormat="openbot.signed-updates/v1"`、`provider="github"`、`owner="Peerframe"`、
`repo="openbot"`、`channel="alpha"|"latest"`，以及 macOS 的 `macTeamIdentifier`（10 位大写字母/数字）
或 Windows 的 `publisherName`（1–8 个签名者名称）。拒绝未知字段、自定义源或缺失签名者；
创建 updater 前验证当前应用的 Developer ID/Authenticode 签名和签名者，保留 updater 原有下载校验及
原生签名验证。开发版、未签名或缺配置时返回不可用，Linux 更新不支持。
现有未签名发布缺少更新元数据，生产下载安装验收仍依赖签名发布产物与元数据；本契约不表示已完成发布或安装。


本次集成按 Owner 决定暂缓生产签名自动更新。未签名包继续返回不可用；原生偏好功能可独立使用。

## 任务经验审阅

记忆新增/更新可携带 `modelUseEnabled` 布尔值，存储后的记录会返回它。新增与迁移旧记录默认
关闭，独立于迁移策略；仅公开或内部、非密钥引用允许启用，更新仍需预期修订。

- `GET /api/v1/bots/:botId/knowledge-proposals`：仅 Owner 可读的待审列表，最多 50 条，返回
  Server 生成的候选 ID、来源 Run ID、类型、标题、正文和时间。
- `POST /api/v1/bots/:botId/knowledge-proposals/:proposalId/review`：严格解析且请求体最多 16 KiB。
  批准为 `{decision:"accept", ownerReviewed:true, title, content, modelUseEnabled:boolean}`；
  拒绝为 `{decision:"reject", ownerReviewed:true}`。标题最多 160 字符，正文最多 2,000 字符
  及 8,000 UTF-8 字节，拒绝凭据值/私钥。跨员工或未知 ID 返回 404，已审阅返回 409。
  批准、新记忆、来源和审计同一事务提交；审阅后删除候选正文。返回 proposalId、decision、
  memoryId/null。

模型只能在有界原生循环中准备候选，不能调用 Owner 接口；成功任务与候选一起提交。
参见[原生 Agent](NATIVE_AGENT.zh-CN.md)。

## 频道最近动态（C1）

`GET /api/v1/channels` 与 `GET /api/v1/workspace` 的每个频道包含 `lastActivityAt`，
以及可选的 `latestMessage: { id, authorType, preview, createdAt }`。
仅已登录 Owner 能读取这些字段；频道修改响应不包含它们。`preview` 是纯文本，
在 SQL 中截取最多 160 个 Unicode 码点（640 UTF-8 字节），不包含附件、凭据、
元数据或其他消息字段。客户端必须按文本渲染，不能当作 HTML。
空频道省略 `latestMessage`，以创建时间作为最近活动时间。
列表按最近活动倒序，时间相同时按频道 ID 的 C 排序规则升序；最新消息时间相同则按消息 ID 的 C 排序规则倒序。
删除的频道不返回。沿用会话复查、行数和响应字节上限。

## 快速创建 Bot（C12）

`POST /api/v1/bots/quick` 仅 Owner 可用，要求可信 Origin。请求只能包含完整 `appearance`，
字段为 `head`、`body`、`mobility`、`accessory`、`accent`，取值沿用 BotAppearance 契约。
未知字段、null 或不完整外观返回 422。成功返回 201 `{bot, channel}`，使用已有 Bot/Channel
结构，单聊满足 `directBotId=bot.id`、`botIds=[bot.id]`。

服务端在活跃 Bot 中原子分配最小空闲名称：`新建 Bot`、`新建 Bot 2`……，已删除名称可复用。
角色固定为 `通用助手`、状态 `idle`、电脑配置 `none`。C7 默认模型在当前连接可用时复制到
`bot.model`；未配置则省略。模型选择仅是配置元数据，创建不启动电脑、任务或模型调用。
失效或停用的默认模型会拒绝整个创建。Bot、进化事件、单聊、成员关系及三条审计一起提交。
每次成功请求都会新建 Bot；网络结果不明确时，客户端不得自动重试。

检查序号 1–10001，最多重试三次与普通创建或重命名的冲突。名称耗尽或持续冲突返回
409 `quick_bot_name_exhausted` / `quick_bot_name_contention`。保留已有会话、Origin、请求体
限制和脱敏的存储及模型错误。

## Bot 外观颜色（C10）

`BotAppearance.accent` 只接受 `green`、`yellow`、`red`、`blue`、`violet`、`teal`、
`pink`、`slate`。普通创建、快速创建、身份/档案投影和 Employee v1/v2 模板使用同一组
取值。已有外观字段及旧模板仍然有效；未知颜色、大小写变体、任意 CSS 字符串、数字和
null 均拒绝。模板导入在新身份下保留外观，审核隔离与摘要校验保持不变。
此契约提供颜色数据，头像绘制及界面选择器由第 15 步设计实现。

## Run 进度检查点（C13）

`GET /api/v1/runs/:runId/progress` 由 Owner 会话读取活跃频道中的 run，返回
`packages/domain` 的 `RunProgressDetails`。`totalSteps` 是该 run 持久化
真实步骤的准确总数：当前产品 run 读取已有 Work 动作；未映射的历史 run 读取
`RUN_PROGRESS` 公开检查点。**不是未来计划总步数，也不是模型用量**。
`currentStepNumber` 是最近已记录的序号；零条时为 null。工作区新增
`runProgress[runId]` 汇总，不受工作区最近 200 条事件窗口的截断影响。

不传 `steps` 时，12 条以内全部返回；超过 12 条返回最早 3 条和最近 6 条。
`?steps=4,5,6` 按序号取至多 12 个不重复的正整数（1–9999999），结果升序；
不存在的序号不返回条目。重复、未知参数和无效序号返回 422。按 `created_at`、
C 排序规则下的 id 排序，先对该 run 的全部检查点编号，再筛选；汇总与步骤使用
同一个可重复读快照。run 不存在或频道已删除返回 404。

`stageName` 和 `description` 只使用服务电脑固定的有界阶段字典；未知阶段为 null。
本接口不读取模型原文、工具结果或原始思维链。审批等待明确显示 approval 阶段；
终态没有当前阶段。Work 动作返回真实接纳、核验结束时间；`completedSteps` 只计已核验的 applied
动作。审批前没有开始时间，未核验动作没有结束时间；不读取请求、参数或回执正文。
run 的开始、结束时间只来自真实生命周期审计事件。历史检查点的
`startedAt` 是记录时间；已有事件不能证明动作何时结束，故 `endedAt` 为 null。
动态运行没有未来计划，故 `plannedTotalSteps` 为 null；历史检查点不能证明完成，
故历史 run 的 `completedSteps` 为 null。不要把检查点总数当作
计划进度，也不要把每个检查点当作成功完成的动作。缺失的时间和失败码返回明确
的 null，不以创建或更新时间替代。

## 模型服务对话框接口（C17）

三项接口沿用 Owner 会话、准确 Origin 和有界 JSON 检查。公开连接信息不包含密钥。
规范迁移 `0049_model_connection_defaults` 追加可空默认模型，不改写旧连接、密文或 Bot 选择。

- `POST /api/v1/model-connections/verify`：请求 `{presetId, baseUrl, apiKey}`，成功返回
  200 `{models: string[]}`。尚未保存的密钥只在本次请求内使用；沿用准确端点白名单和支持
  模型列表读取的预设，只发一次有界 GET，不发对话或推理。不创建连接、文件、密文或审计
  事件，不记录密钥或返回上游错误正文。发送和返回前重新核对 Owner；断开、超时会关闭请求。
  不支持列表读取、密钥无效、重定向或上游格式错误返回固定 422 类别。最多 256 个模型 ID、
  2 MiB，不跟随重定向、不重试。
- `PATCH /api/v1/model-connections/:id`：`{expectedRevision, defaultModel: "model-id"}`
  设置连接默认模型；`defaultModel: null` 清除；不传则保留。原有名称、密钥、启用状态修改
  兼容。实际变更递增 revision；旧 revision 或整数版本耗尽返回 409；无变化保留版本。
  创建连接也可带 defaultModel。这只是元数据，不自动改已有 Bot 或 Owner 全局默认选择。
  审计仅记录变更字段名和版本。
- `DELETE /api/v1/model-connections/:id`：必须带 JSON `{expectedRevision}`，成功返回
  200 `{deleted: true, connectionId}`。请求缺失或无效返回 422，旧版本 409，不存在 404；
  环境提供的 legacy 连接仍只读（422）。活跃 Bot、未结束 run 的选择快照或 Owner 默认
  仍引用它时，返回 409 `{error: "model_connection_in_use", bots: [{id,name}],
  runIds: [...], ownerDefault: boolean}`。依赖读取、校验或数量上限失败都拒绝删除，不能
  用不完整列表批准删除。连接行锁把新选择与删除串行化；删除闲置连接及
  `MODEL_CONNECTION_DELETED` 审计一起提交，历史与回执保留。

界面先 verify，再由 Owner 明确调用已有创建接口保存；验证不会保存或授予执行权。
验收只使用假 provider，不调用会产生推理费用的 `/test` 接口。

### C19：频道附件引用次数

`GET /api/v1/channels/:channelId/attachments` 的每项（包括回收站文件）增加
`referenceCount: { "messages": 3, "tasks": 2 }`，分别是准确的消息数和任务数，均为非负整数。
只有 Owner 会话可以读取，先检查频道仍有效，返回前再次检查会话未撤销。
不返回引用消息／任务的 ID、标题、正文、提示词或回执。附件详情、内容、修改响应及
Owner 原生任务附件保持原有格式。

引用按同频道保留消息或频道任务冻结指令里的 `[OpenBot attachment: <UUID>]` 标记计算，
不区分大小写，同一记录重复标记只算一次。每个分派或委派频道 Run 是独立任务；
映射成 Work 的 Run 只算一次。已结束任务仍计数；单独出现 UUID 不算引用。
Owner 原生 Task 的文件命名空间独立，不加入频道计数。引用数不代表模型已读取，也不授权清理。

现有附件列表最多 1,024 项，每个计数最多 10,000；超出返回
503 `attachment_reference_limit`，不返回截断数或部分列表。
计数来自同一次 SQL 快照，沿用 3 秒语句／6 秒 Owner 事务限制；超时或存储失败拒绝返回。
私有文件锁覆盖元数据和计数投影，事务末尾仍检查 Owner 权限。不新增存储、写操作或模型调用。

### C18：读取更早的消息页

`GET /api/v1/channels/:channelId/messages?limit=100&before=<不透明游标>` 沿用现有 Owner 会话权限。
`limit` 默认100，必须是1–100的十进制整数；`before` 可省略。未知或重复参数、空／格式错误／超长游标、
其他频道的游标返回422。不存在或已删除的频道在授权检查后返回404。

响应为 `{ "messages": [...], "hasMore": true, "nextCursor": "..." }`。没有游标时返回最新一页；
每页的 `messages` 都是旧消息在前，按数据库时间、id（C 排序规则）升序排列。把 nextCursor 作为 before 获取严格更早的一页，并将该页
放到当前消息前面。没有更早消息时 hasMore 为 false，省略 nextCursor；空页为
`{ "messages": [], "hasMore": false }`。现有默认窗口仍是100条。

游标记录返回页最早一条消息的位置，保留数据库时间精度和 id；游标绑定频道，客户端应原样传递，不能依赖其内部格式。
即使这条消息被删除，游标仍可用。游标不授予权限，也不包含消息正文。每次请求读取当前事实，跨页请求
不保证历史冻结；每页保留会话二次检查、选中正文／响应大小限制和 no-store，不产生消息写入或模型调用。

### C20：浏览器与附件承诺的边界

浏览器窗口实时画面不由查看／审计路径持久保存；明确的任务截图可能另存为产出。
浏览器登录 profile 在原工作电脑持久保存，清除浏览数据会移除登录状态。
关闭已接管的窗口会让 Bot 保持暂停，须明确接管／交还才恢复；纯查看关闭不会暂停。
回收站文件拒绝新引用与后续 Bot 读取，Owner 历史下载保留，已发送给模型的内容不能撤回。
下文 C21 提供永久清理及默认关闭的 30 天自动清理，不存在固定七天清理器。
删除整个频道走独立的、频道墓碑授权的文件清理路径。
明确转写要求当前启用的 OpenAI 配置及官方地址，原文件和转写结果保存在服务电脑。
详见[逐条核实](reviews/C20-product-claims.zh-CN.md)。

### C21：频道回收站永久删除与实测存储空间

以下接口都要求有效 Owner 会话。写操作沿用 Origin、请求体限制和返回前会话复核；
无权限返回 401，Origin 不符返回 403。不调用模型。Owner 原生任务附件不在这些频道删除命令的范围内。

- `DELETE /api/v1/channels/:channelId/attachments/:id/purge`，空请求体或 `{}` →
  `{id, purged: true, freedBytes}`。只允许删除有效频道中已经进入回收站的附件；正常文件返回
  409 `attachment_not_in_trash`。删除事务中检查 C19 引用数，暂存文件后再次检查。
  已有引用或删除过程中提交的新引用都返回 409
  `{error: "attachment_referenced", referenceCount: {messages, tasks}}`。
  无法确认引用或超限时整次拒绝（503）。最终 SQL 表锁覆盖复核至提交，防止消息或任务写入钻过间隙。
  正常引用准入共用私有文件锁，提交后不能引用已经永久删除的附件。
  数据库守卫也拒绝消息／Run 引用删除凭证，包括等锁释放后才执行的 SQL 写入，不能产生悬空引用。
- SQL 删除凭证和逐文件审计提交后，物理删除原件、文件元数据及派生文本。同一文件系统中的可恢复
  暂存操作在每次获取文件锁时恢复。提交回复丢失必须查询 SQL；查询不可用时保留待恢复状态，
  不能盲目恢复已提交删除的文件或报告成功。重复永久删除已完成的文件返回保存的结果。
  每个删除文件审计文件名（最多 160 个码点）、原件大小、频道、操作人（`owner` 或 `server`）、
  原因、附件 ID 和释放字节数，不记录内容。
- 在原有效频道读取已永久删除文件的元数据或内容返回 410
  `{error: "attachment_purged", purged: true}`。不存在或频道不符返回 404；未授权仍返回 401。
  保留最小删除凭证，列表不再包含该附件。已删除频道仍返回原有 404，原有整频道清理策略保持有效。
- `POST /api/v1/channels/:channelId/attachments/cleanup`，
  `{requestKey: "<UUID>"}` → `{removed, retained, retainedCount, retainedHasMore, freedBytes}`。
  `removed` 是删除文件数；保留项为 `{id, name, referenceCount: {messages, tasks}}`。
  按 ID 排序，最多返回 100 项；`retainedCount` 给出完整数量，`retainedHasMore` 表示是否截断。
  沿用 1,024 个文件和每类引用数最多 10,000 的限制，超限时拒绝，不能用部分计数授权删除。
  不返回引用它的消息或任务内容、ID。传输重试必须使用**同一频道和 requestKey**：保存的响应完全一致，
  不重复审计，也不删除此后才进入回收站的文件。新的清空操作应生成新的 UUID。
  缺字段、多字段或格式错误返回 422 `invalid_cleanup_request`。

`GET /api/v1/storage` → `{totalBytes, measuredAt, categories, trash, topChannels, topChannelsLimit: 20}`。
不接受查询参数。分类互不重叠，返回实测逻辑字节数 `sizeBytes`，适用时给出 `fileCount`：
`channelFiles`（正常频道附件）、`trash`、`ownerTaskFiles`、`taskOutputs`（保留 Run 产出与已配置
原生 Work 内容寻址文件）、`other`（受管目录其他文件，包括最小删除凭证）、`database`
（配置的 PostgreSQL 数据库实际 `pg_database_size`）。附件大小包含原件、元数据和派生文本；
附件类别按附件计数，产出及其他类别按存储文件计数。

未配置原生 Work 产出目录时，`taskOutputs` 为 `null`，能统计到的保留产出放在 `retainedRunOutputs`；
已配置时 `retainedRunOutputs` 为 `null`。`workingComputerBrowserData` 始终为 `null`，无法在此统计
远端工作电脑的浏览器数据。`totalBytes` 是已测类别之和，不估算未知目录、操作系统实际分配、备份、
WAL 或物理磁盘剩余空间。内容寻址产出统计实际存储的去重文件，不按逻辑任务引用重复计算。
`freedBytes` 为删除的附件文件字节数减去最小删除标记大小，不含 SQL 凭证与审计增长，也不是物理磁盘分配量。

`trash` 为 `{fileCount, sizeBytes, referencedFileCount, referencedSizeBytes}`；后两项分别表示仍有消息或任务引用的文件个数，以及它们的实测原件、元数据和派生文本字节数。
`topChannels` 最多 20 个 `{id, name, deleted, sizeBytes, fileCount}`，包含正常及回收站附件，
按大小降序、ID 升序。遍历拒绝符号链接、硬链接、非当前用户所有、超过 10,000 项或深度超过 8 的目录，
目录损坏、不可用或引用不明也拒绝，不返回部分或估算成功。不会泄露路径或文件内容。
SQL 与文件锁沿用有界超时。

- `GET /api/v1/settings/storage` → `{revision, trashAutoPurgeDays, updatedAt, lastAutoPurgeAt}`。
- `PUT /api/v1/settings/storage`，`{expectedRevision, trashAutoPurgeDays: null | 30}` → 同样格式。
  默认 `null`（关闭）；其他取值或多字段返回 422，旧版本返回 409 `storage_settings_revision_conflict`。
  变更增加版本并审计，相同值不增加版本、不重复审计。设置变更清除每日执行凭证并唤醒维护任务。
  `lastAutoPurgeAt` 表示最近一次到期尝试的领取时间，不证明实际删除了文件。

Server 维护任务在启动时、设置变更时及每小时检查；启用后跨 Server 进程每天最多领取一轮。
只删除有效频道内、在数据库领取时间已进入回收站至少 30 天、且 C19 确认零引用的文件。
未满天数、正常文件、Owner 任务文件和被引用文件都保留。目录、引用或锁检查失败时，该轮所有删除回滚。
每轮先追加 `SETTINGS_TRASH_AUTO_PURGE_RUN` 的 started 审计，再追加相同操作 ID 的终态审计
（`completed`、`failed`、`cancelled` 或 `policy_changed`）；只有 started 表示执行中断或完成情况未知。
逐文件审计与删除一同提交，零删除的成功轮次也审计；关闭或尚未到期的检查不产生清理审计。
该策略取代“固定七天清理”的承诺：只有 Owner 明确选择 30 天才启用自动永久删除。
删除整个频道仍是独立的生命周期操作。

### C22：全局清空回收站

`POST /api/v1/storage/trash/cleanup`，`{requestKey: "<UUID>"}` →
`{removed, retained, retainedCount, retainedHasMore, freedBytes, channelCount}`。
沿用有效 Owner 会话、允许的 Origin、返回前权限复核及 C21 删除规则。不接受查询参数，
请求体最多 4 KiB，只接受 `requestKey`。

一次事务处理所有有效频道的回收站附件，复用 C21 暂存与恢复、初始及加锁后的最终引用检查、
防止迟到引用的 SQL 守卫和逐文件审计，原因为 `empty_trash_all`。正常文件、已删除频道和
Owner 原生任务文件不在范围内。引用不明时整次拒绝。沿用目录最多 1,024 个附件、每类引用
最多 10,000 条、保留列表最多 100 项的限制；保留项格式和 ID 排序同 C21。
`channelCount` 是有候选回收站文件的有效频道数，包括所有文件都被保留的频道；无候选时为零。

持久凭证**只按 requestKey 记**，不依赖频道生命周期。同一 UUID 重试原样返回已保存结果，
不删除后来进入回收站的文件，也不重复审计；新的清空操作须使用新 UUID。
`GET /api/v1/storage` 的 `trash.referencedSizeBytes` 统计被引用回收站文件的实测逻辑字节，
包含原件、元数据及派生文本，与 `trash.sizeBytes` 共用实测文件树。两者之差表示测量时的
未引用回收站字节，不保证并发变化及最小删除标记保留后的最终 `freedBytes`。

### C23：浏览器资料字节数

`POST /api/v1/bots/{botId}/browser/maintenance`，`{operation: "status"}`，现在返回
`{botId, nodeId, running, paused, profileBytes: number | null}`。
`browser.maintenance@1` 的 Worker 结果携带同一字段。数字是原工作电脑上该 Bot 的资料文件
逻辑字节数，必须是非负安全整数。旧 Worker 缺字段时归一为 `null`；接口不支持、测量拒绝、
格式异常或传输失败也返回 `null`，不能估算为零。Owner／Host 绑定、能力要求及取消行为保持不变。
重启、清除操作的结果包含 `profileBytes: null`，需随后查询状态才能测量。

Docker Provider 携带选定的 `Bot-Id` 调用已认证的 `GET /computers/profile-usage`。
[上游贡献](https://github.com/CopilotKit/OpenBot/pull/730)只读取这个 Bot 的资料，不启动 Chromium，
不返回路径或内容。Linux 遍历跳过符号链接，拒绝链接根目录、硬链接、特殊文件及跨设备目录；
限制为 10,000 项、16 层、2 秒工作期限（在文件系统操作前后检查），同一进程同时最多一次测量。
拒绝测量或根目录不可用时返回 `null`；确认该 Bot 目录不存在时返回零。
这是实时逻辑字节观察，不是原子快照或磁盘分配量。

Owner 于 2026-10-03 批准的窄分支固定为 `29a83c1932fb67398dd7a36fa80c473e0230a637`，仓库
[yxflc11/openbot-agent-computer-upstream](https://github.com/yxflc11/openbot-agent-computer-upstream)；只在原生产版本上移植大小接口。
镜像与真实 Provider 已验证，#730 继续开放；上游合并并验证后切回上游。
远端资料大小不加入服务电脑的 `/storage.totalBytes`，
`categories.workingComputerBrowserData` 仍为 `null`。

### C24：附件引用列表

`GET /api/v1/channels/:channelId/attachments/:id/references?limit=20` 要求有效 Owner 会话和有效频道。
响应为：

```json
{
  "messages": [{"id": "<消息 ID>", "createdAt": "<ISO 时间>", "author": {"kind": "bot", "botId": "<Bot ID>"}, "preview": "简短文本"}],
  "tasks": [{"runId": "<Run ID>", "title": "任务标题", "status": "completed", "createdAt": "<ISO 时间>"}],
  "messageCount": 1,
  "taskCount": 1,
  "hasMore": false
}
```

`author.kind` 为 `owner`、`bot` 或 `system`；只有 Bot 作者可在保留了身份时带 `botId`。
系统消息保留其真实类型。预览去除规范附件标记，裁掉首尾空格，最多 120 个 Unicode 码点；
任务标题最多 160 个码点。不返回完整消息正文或任务指令。

`limit` 默认 20，必须是 1–100 的 ASCII 十进制整数，**分别限制两个列表**。
空值、格式错误、重复或未知查询参数返回 422 `invalid_attachment_reference_query`。
各列表按数据库时间降序，再按 ID（C 排序规则）降序。匹配规则、记录身份、频道范围与
每类最多 10,000 的计数界限完全同 C19。两个列表和计数来自同一次 SQL 快照；
任一计数大于返回列表长度时 `hasMore` 为 true。超限返回 503，不返回部分内容。
该接口不提供游标或 offset。

回收站文件仍可查询；已永久删除文件返回 410，不存在、频道不符或频道已删除返回 404。
缺失或撤销 Owner 权限返回 401，返回前仍复核会话。沿用私有文件锁与有界 Owner 事务。
不调用模型，不产生写操作。
