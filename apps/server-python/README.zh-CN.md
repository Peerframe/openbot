# Python 控制层与产品候选

[English](README.md) · [简体中文](README.zh-CN.md)

Python/FastAPI 实现[迁移计划](../../docs/ARCHITECTURE_MIGRATION_PLAN.zh-CN.md)中的可信业务控制层，
与不受信任的 Agent Runtime 分开。显式 `product` 入口已组合 Owner 身份／工作区、模型连接、知识、
对话、日程、文件／处理器、插件／MCP 和 Worker Host 服务；明确配置的 Temporal 引擎负责持久 Work 执行、审批、修正与发布。
入口仍默认只读；退役验收尚未完成，仓库开发与发行默认入口仍选择 TypeScript Server。

当前范围与证据见[迁移交接](../../docs/MIGRATION_HANDOFF.zh-CN.md)。本地产品链路和 macOS arm64 Preview
打包流程已通过；完整远程 Linux 命令链路和 Chromium／人工接管验收尚未完成。
下文早期分阶段章节记录较窄模式的契约与历史测试，不代表当前产品的全部功能范围。

## 开发与验证

完整本地测试先在仓库根目录安装锁定的 npm 依赖并运行 `npm run oracle:build`。
这也会构建保留的发布者 CLI 互操作测试所需的共享契约；该测试仅创建并清理临时合成密钥。
然后在本目录用 Python 3.12 运行：

```sh
./scripts/bootstrap.sh
./scripts/check.sh -q
```

`OPENBOT_CONTROL_PYTHON` 可选择可信的启动解释器。已验收的 Agent Runtime 虚拟环境保持独立。
锁文件记录精确的开发依赖闭包，拒绝缺失、多余或版本漂移。环境包含测试工具，不是生产镜像；启动不会自动安装依赖。

仓库根目录运行一次性数据库流程：

```sh
apps/agent-runtime-python/scripts/bootstrap.sh
npm run test:control:python
```

夹具先构建固定的[测试专用 Server oracle](../../tests/oracles/legacy-server/README.zh-CN.md)，
自建回环 PostgreSQL 17.11 容器，执行未改动的 Node 迁移历史，使用合成凭据、Bot 和频道。
与真实 TypeScript API 对照，覆盖 Unicode、多成员频道和私聊。旧接口未规定成员顺序，只有成员 ID 按集合比较，Python 按 ID 排序；
其余夹具字段逐项相同。两边可识别对方签发的会话，并共同识别撤权。

95 项数据库/HTTP/SDK 检查覆盖读取、过期/撤权、只读事务拒绝写入、精确模式历史、非法旧 Bot 状态、并发持久限流、
认证事务失败不签发成功 Cookie，以及真实回环进程和限时 SIGTERM 停止。身份检查还覆盖精确审计/成长事件、缺失成员、并发重名、审计失败回滚、等锁时撤权、等审计时过期、真实 HTTP 创建。
另有 129 项输入差分与 34 项 Owner 命令差分，以已安装 Zod 与 Python 的真实结果对照。
任务命令数据库检查覆盖子任务取消、补充指令、真实行锁竞争和回滚。
没有显式夹具时普通包测试跳过 95 项集成，跳过不算验收。固定版本仍有两项上游测试客户端弃用提示。
新增任务检查覆盖多接收者原子提交、回复/成员范围、并发源消息时间、审计失败回滚和有界任务读取；另有 60 项真实 TS/Python 路由和 Run 投影差分。
Linux CI 已接入这些检查，但本地改动尚未运行托管 CI，二者不能混称。

不读取 `OPENBOT_DATABASE_URL`、dotenv、模型凭据或用户数据库，只清理自有资源。本段不证明外部模型、浏览器或生产表现。

## 显式本地入口与权限范围

为已准备的兼容参考数据库设置 `OPENBOT_CONTROL_DATABASE_URL`，运行 `.venv/bin/python -I scripts/serve.py`。
默认监听 `127.0.0.1`，默认端口 3101，可用 `OPENBOT_CONTROL_PORT`（1–65535）改变；禁用转发头信任与访问日志。
`OPENBOT_CONTROL_HOST`只接受`127.0.0.1`或`0.0.0.0`，空值或非法值在初始化前拒绝。
可选[产品容器](../../deploy/server/README.product.zh-CN.md)在容器内显式选择`0.0.0.0`，主机端口仍仅发布到回环。
不运行迁移、不读取 dotenv。这不是生产切换指引。

| 设置 | 含义 |
| --- | --- |
| `OPENBOT_CONTROL_HOST` | 默认`127.0.0.1`；另只接受显式`0.0.0.0`。不改变origin、cookie和转发头策略 |
| `OPENBOT_CONTROL_AUTHORITY` | 默认 `read-only`；`owner-auth` 启用登录/退出；`identity` 额外启用 Bot/频道创建、私聊、加入成员与带版本检查的资料编辑；`tasks` 再增加旧任务入队；`work` 额外开放独立工作领域提交接口 |
| `OPENBOT_CONTROL_OWNER_PASSWORD` | `owner-auth`、`identity`、`tasks`、`work` 模式必填；15–1024 个 Unicode 字符，不能用示例密码。不继承旧 Server 密码变量 |
| `OPENBOT_CONTROL_SESSION_TTL_HOURS` | 整数 1–168，默认 12 |
| `OPENBOT_CONTROL_ALLOWED_ORIGINS` | 逗号分隔的精确 HTTP(S) 来源；认证模式默认 localhost/127.0.0.1 与配置端口。不接受通配符、不根据 Host 推断 |
| `OPENBOT_CONTROL_COOKIE_MODE` | 默认 `secure` 使用 `__Host-openbot_session`；本地夹具显式 `loopback` 使用 `openbot_session`，不互相回退 |
| `OPENBOT_OWNER_NAME` | 公开 Owner 显示名称，默认 `Owner` |

认证写入要求匹配 Origin。登录 JSON 限 8 KiB、5 秒，错误不回显凭据。直连 IP 经现有摘要逻辑映射到 PostgreSQL 的
五次/五分钟桶，与 TypeScript 使用同一事务咨询锁；伪造转发 IP 不能重置限流。此段不支持代理部署。
会话令牌有 32 字节熵，数据库只存 SHA-256 摘要。提交后才设置 HttpOnly/SameSite=Strict/Path=/ Cookie；退出先持久撤权再清除。
存储结果不确定时返回 503，不自动重试或签发成功 Cookie。

启动要求 `packages/db/migrations` 的完整 SQL 哈希/时间戳一致；其他历史拒绝且不修复。
读取采用有界只读 READ COMMITTED 事务并复查撤权；不投影 Bot 私有配置或凭据摘要。未认证保护读取返回 401，未支持写入返回 405。
响应上限为 1,000 个 Bot、10,000 行频道成员、4 MiB JSON；超限报错，不静默截断。

**明确保留的旧数据差异：** 非法 Bot 状态会让 Python 整个列表返回 503，旧 TypeScript 可能原样返回未检查值。
数组等非法类型的外观枚举会被 Python 丢弃，旧强制转换可能接受。Python 不自动修改这些行。
有效当前模式数据通过对照，不宣称损坏数据等价。数据库 NOT NULL 约束排除了旧时间戳为 null 的回退情况。

接口为 `/health`、`/api/v1/auth/session`、`/api/v1/bots`、`/api/v1/channels`；认证模式额外启用
`/api/v1/auth/login` 与 `/api/v1/auth/logout`。`/openapi.json` 反映所选接口，交互文档关闭。
`identity` 额外启用 POST `/api/v1/bots` 和 POST `/api/v1/channels`，返回原 201 状态和响应结构。
输入默认值、去空白、Unicode 字符计数、UUID 拼写和去重前的成员上限均与实际 Zod 对照；仅可省略字段不接受显式 null。
请求体上限仍在规范化之前生效。

创建先认证再处理输入错误，并在写事务内用 PostgreSQL SHARE 行锁复查会话。身份、成员与持久审计/成长记录一起提交；
后来的退出等待事务完成，已撤权或过期则拒绝创建。重名返回 409，成员缺失 422，存储结果不确定返回 503 且不自动重试。
普通频道使用原部分唯一索引，与私聊名称分别处理。选择电脑档位不等于获得工具权限。
本段尚无实时个人资料通知、身份删除或任务派发接口；完整客户端兼容、工作区版本快照和持久事件游标仍是后续 S2 工作。

私聊使用 POST `/api/v1/bots/{bot_id}/conversation`；普通频道加入成员使用
POST `/api/v1/channels/{channel_id}/bots`，提交 `{ "botId": "..." }`。两者都返回原有频道结构和 200。
Bot 行锁保证并发只创建一个私聊，重复加入不重复写审计。身份不存在返回 404，修改私聊成员返回 422；
已有私聊成员异常返回 503，不擅自修复。与身份创建共用 Owner 事务边界。新增五项真实数据库检查覆盖并发、幂等、
拒绝与回滚；显式启动进程也通过真实 HTTP 验证两个入口。移除成员随 S2b 的取消与审批迁移；任务提交已加入下述独立 `tasks` 模式。
复用依据见[私聊研究](../../docs/research/python-conversations.md)。

认证后的 GET `/api/v1/channels/{channel_id}/messages` 按时间顺序返回最新 100 条消息，保留 Unicode 和可选 ID。
时间相同时按 ID 稳定排序，旧 TS 未规定这种并列顺序。认证后才能区分频道不存在（404）与空频道（空列表）。
数据库输出的所选文本及公共 JSON 均有 4 MiB 上限，超限返回 503，不缩短或修复内容；最终会话检查发现撤权就丢弃已读数据。
夹具用 105 条消息和空频道与真实 TS/回环 HTTP 对照，额外验证同时间排序、超大正文/标识和读途中撤权。
复用依据见[消息读取研究](../../docs/research/python-message-reads.md)。

`identity` 模式还支持 PATCH `/api/v1/bots/{bot_id}/profile`，必须提交 `role`、`description`、`expectedRevision`，拒绝多余字段。
正文上限为 32 KiB/5 秒，可容纳最大 Unicode 字段。只改变描述性资料：版本过期返回 409、内容未变返回 422、Bot 不存在返回 404。
资料版本、成长事件和审计一起提交，共用带会话锁的 Owner 事务。六项真实数据库检查覆盖竞争、回滚、撤权、过期、错误映射和 TS 回读，
显式启动的进程也已通过真实 HTTP PATCH 验证。完整资料 GET 与实时失效通知仍在 S2c，不提供空数据替代品。
详见[资料编辑研究](../../docs/research/python-profile-details.md)。

## 任务入队参考实现

显式 `tasks` 模式包含身份模式已有入口和登录配置，并启用 POST `/api/v1/channels/{channel_id}/messages`。
接受去空白后的 1–8000 个 Unicode 字符、可选 `botId` 或 1–6 个唯一 `botIds`，以及同频道 `replyToMessageId`。
正文上限 128 KiB/5 秒，多余字段丢弃，可省略字段不接受 null。私聊只能分配给对应 Bot，普通频道默认选择负责人或有序首位成员；名称不授予权限。

带 Owner 会话锁的事务同时提交人类源消息、全部排队任务及原有 MESSAGE_CREATED/RUN_CREATED 审计。
并发源消息保持不同且递增的毫秒时间，不保存部分接收者。返回 `message` 与 `run`，只有显式 `botIds` 才额外返回 `runs`。
当前尚未接入执行器，`queued` 只表示成功入队。实际附件标记在文件权限迁移前返回 503，超过八个唯一引用返回 413。

认证后的 GET `/api/v1/channels/{channel_id}/runs` 返回最新 50 项任务，由新到旧；同时间按 ID 稳定排序。
文本传输和最终 JSON 均限制 4 MiB。必需状态非法时拒绝，无法解析的用量丢弃；合法用量中的 null 计数保留。
用量仅是报告的证据，不代表权限或账单。标题保留原 80 个 UTF-16 单位上限和 77 单位前缀加省略号，截断不切开 Unicode 字符，修复旧实现的孤立代理项边界。
详见[任务研究](../../docs/research/python-task-authority.md)。

## 控制层执行适配器（S2b-2 内部边界）

独立的 `runtime_host`、`runtime_ports`、`runtime_executor` 模块把权限、模型选择、工具执行器、预算、用量和最终结果校验保留在控制层。
SDK Worker 只接收既有进程协议。这些模块尚未接入任务 HTTP 派发：公开队列执行和审批集成仍未完成；内部数据库生命周期见下文。
确定性模型端口用于测试，不代表真实模型服务已迁移。

控制层在异步边界复查权限，执行前消费准确匹配的工具意图，并将返回的历史与真实模型/工具记录对照。
重放、伪造工具观察、失败或取消后的成功都会被拒绝。最终文本仍需 SQL 服务单独提交完成状态。
进程适配器在连接管道前即持有 PID，取消会先完成进程组清理再返回。
在执行监督阶段验收时，包测试 651 项通过，另在独立数据库夹具中通过当时的 45 项；83 项进程/真实 SDK 测试和 48 项实际 TS/Python 协议对照通过。
这不代表数据库任务执行已接通，详见[监督层研究](../../docs/research/python-control-runtime-supervision.md)。

真实 Worker 测试需要先在 `apps/agent-runtime-python` 中建立独立虚拟环境。
缺少该环境或在 Windows 上时，`tests/test_runtime_sdk_integration.py` 会跳过；跳过不代表互操作已验证。
既有 `npm run test:runtime:linux` 夹具会在固定 Linux 镜像中安装两套隔离的锁定环境，并要求真实 Worker 存在。
控制层测试不继承 TS 测试阶段使用的合成数据库凭据。
本地 Linux/amd64 夹具通过 306 项控制层测试，以及既有 418 项 SDK 和 222 项 TS/PG 测试；使用 Docker init 回收孤立后代进程。
托管 CI 已接线，但这次未推送修改尚无托管运行结果。

副作用适配器仍须在派发时完成自己的原子权限/审批检查，并配合取消；宿主的前后检查不能撤销已经发生的外部操作。

## 持久化执行生命周期

`PostgresExecutionStore` 负责后台领取、状态复查、冻结频道上下文、用量、进度、纠正读取、失败和原子交付。
后台事务不依赖浏览器 Owner 会话继续有效；成功写入仍须核实数据库中的任务身份、祖先和当前频道成员资格。
HTTP 命令保留单独的 Owner 会话锁。领取遵守六个根任务和同 Bot/频道互斥限制；用量逐步递增并保留未知计数。
失败不会覆盖取消状态，并会停止符合范围的活动子任务。

交付保留最多两份 Markdown 产物、八项记忆引用和两项已审核技能引用。版本、摘要与已提交纠正全部核对后，
Bot 回复、产物元数据、终态和审计一起提交。经验只生成待审核提案；已有 50 条待审核提案时跳过新增提案，
不撤销正常交付。真实文件和孤立文件清理由可信存储端口负责，SQL 元数据不能证明文件存在。

一次性验收增加 24 项生命周期/SDK 测试，总计 95 项，覆盖真实锁竞争、撤权/取消与交付竞争、单次发布、
审计回滚、上下文截止点，以及真实 TS 回读。其中四项把独立 SDK 子进程接到真实数据库端口和确定性模型，
验证实际报告文件及过时结果拒绝。值契约另通过 40 项实际 TS 对照及全部 20 个失败消息核对。
CI 同时准备两套解释器；组合验收缺少 SDK 环境会明确失败。

这仍是内部控制层适配器。公开任务派发、生产工具/模型/审批端口、实时事件和重启恢复尚未完成，默认后端未切换。

## 复用与许可证

参见[读取研究](../../docs/research/python-control-read-slice.md)、[认证研究](../../docs/research/python-owner-auth.md)、
[输入契约](../../docs/research/python-identity-inputs.md)和[身份事务](../../docs/research/python-identity-transactions.md)。
FastAPI/Pydantic 为 MIT，Starlette/Uvicorn/HTTPX 为 BSD-3-Clause，Psycopg 及二进制发行版为 LGPL-3.0-only，CPython 为 PSF 许可。
安装包声明完整保留。UUID 模式改编自 Zod，完整 MIT 声明随包保存在
[第三方声明](THIRD_PARTY_NOTICES.md)；未修改已安装依赖。分发需保留声明和适用许可证权利。


## Owner 任务命令

显式 `tasks` 模式新增 POST `/api/v1/runs/{run_id}/cancel`，请求必须是空 JSON 对象，最大 128 字节；
POST `/api/v1/runs/{run_id}/steer` 只接受 `instruction` 字段，最大 18,000 字节。两者均要求有效 Owner
会话和允许的 Origin。补充指令要求 UUID 任务 ID，去除首尾空白后为 1–4000 个 Unicode 码点；拒绝附件
标记。只有 Bot 仍属于当前频道的原生 queued/running 任务可接受指令，最多八条，审计事务提交后才返回
202 和 `steering`。这表示指令已记录，尚不表示已执行；内部完成事务已核对全部已提交指令的 ID。

取消原子更新目标与同频道中符合条件的原生活动子任务，并记录 Owner/祖先审计，返回已提交的 `run`。
重复取消不追加审计；其他终态或 Worker 状态返回 409，鉴权后的缺失任务返回 404。事务最多处理 1000 个
子任务，文本传输与 JSON 投影各限 4 MiB；超限、审计失败或 Owner 会话过期时全部回滚。当前参照服务仍
未接入 dispatcher；真正执行中的进程/插件中止和实时事件发布，必须在提交后另行接入，不能据此宣称已经
停止外部动作。

本阶段已通过 71 项组合 PostgreSQL/HTTP 验收（含 TS 读回）、728 项 Python 包测试和全仓检查。
普通包运行会跳过数据库测试；使用现有 `npm run test:control:python` 一次性夹具执行它们。

## 独立工作领域提交（S3 基础）

对明确准备且含 `0027`、`0028` 迁移的参考数据库，显式设置 `OPENBOT_CONTROL_AUTHORITY=work`。启动只校验历史，不自动迁移；保留此前参考接口。此模式没有启用派发器或选定引擎，健康状态为 `s3-work-admission-reference`，默认模式和后端不变。

| 命令 | 提交后的行为 |
| --- | --- |
| `POST /api/v1/tasks` | `{botId, objective, tokenLimit, requestKey}` 原子创建 Task、首个 Run、待引擎接收记录及事件；返回 202/queued，不要求 Channel。同键同内容读现有状态，改变内容返回 409。 |
| `GET /api/v1/tasks/{task_id}` | Owner 专用一致快照，含版本、Run、Action、用量、待处理事项和最近 100 条事件；`eventsTruncated` 明示截断，尚无实时事件流。 |
| `POST /api/v1/actions/{action_id}/decision` | `{intentDigest, approved}` 绑定准确 Action 内容、当前授权版本和数据库期限；冲突或过期返回 409。 |
| `POST /api/v1/tasks/{task_id}/cancel` | `{}` 关闭新动作准入；已准入且结果未明的动作保留预算，核对后才终结取消，不宣称撤销外部操作。 |
| `POST /api/v1/actions/{action_id}/reconcile` | `{intentDigest, requestKey, expectedSequence, reason}` 记录 Owner 对既有未知 Action 的核对请求，返回 202 和持久命令。命令送达与核验完成分别记录；同键重试返回同一命令，绝不重做外部写入。 |

写入要求当前 Owner 会话和准确 Origin。提议、预留、记录已核实结果的方法仅供受信控制层使用；客户端、Runtime、Worker 没有自行提交核对结果的端点。工具调用 ID 不是去重保证，摘要和回执格式校验也不能证明外部事实；`resolve` 只能接收受信适配器独立核对后的证据。

Task 行锁使不同 Run 共享预留，并原子提交事件、用量和结果。未知结果不退款；核实的超额用量如实记录并阻止新支出。当前参考限制为每 Task 256 个 Action、规范 JSON 意图 16 KiB、审批期限最多一小时，不等于完整费用或资源预算。

`0027` 基础检查当时新增 10 项真实 PostgreSQL 测试，控制层集成共 105 项。新增公开接口使用 ASGI TestClient 与真实数据库，客户端关闭重开仍取得已提交状态；该基础检查尚未证明 TCP/浏览器重连、引擎故障恢复、真实副作用核对或产物发布；后续发布检查见下节，完整引擎/执行器流程仍待验收。见[研究](../../docs/research/work-domain-admission.md)。

迁移 `0029` 为显式 `work` 模式增加有界核对命令和幂等请求键。命令送达后仍可被发现，以便旧引擎快照恢复后重新通知；重新通知只触发回执查询。回执缺失、格式错误或内容不符时，Action 仍为 unknown，预算预留不退。只有受信适配器能记录独立核实的事实；取消或撤权后的补记不会恢复执行授权。见[核对研究](../../docs/research/work-reconciliation-commands.md)。

### 执行归属与产物发布

受信引擎适配器在提议/准入 Action 或完成任务前，须调用 `claim` 获得 `WorkFence`。新的认领 ID 增加 Run 执行版本；重放旧 ID 不续期、不恢复执行归属。参考上限为每次 1–300 秒、每 Run 最多 10,000 次。这是数据库写入约束，不是调度器，也不能阻止目标服务未校验版本的外部 HTTP 请求；审批、权限和共享预算仍须分别检查，引擎负责安排有界执行，Store 不增加续租循环。

显式 `work` 模式可设置 `OPENBOT_CONTROL_ARTIFACT_ROOT`，指向已有的绝对路径、控制层私有 POSIX 目录（0700）。配置错误会拒绝启动；不设置时仍可提交/批准，但不能发布/下载文件。不得将目录挂载给不受信执行器。发布使用不可变内容键、文件及目录刷盘和真实读回校验；当前限制为每次最多八个文件，每个 8 MiB，格式处理和任务语义验收由受信适配器负责。

控制层 `complete` 再次检查当前执行版本、期限、Task 版本和权限，要求所有已提议 Action 确认执行且没有未结束同级 Run，并核验真实文件，再原子提交产物元数据、摘要、终态及事件。同内容重试读取已发布结果，不同内容冲突；本段尚无部分完成或豁免动作的状态。模型最终回答或自报回执不能直接完成任务，也没有公开 complete/resolve 接口。受信 `resolve` 可在撤权后核实已准入动作，不产生新的执行权限。

`GET /api/v1/artifacts/{artifact_id}` 校验 Owner 后读取数据库描述符，再核对文件大小和 SHA-256，以编码文件名及禁止嗅探的附件形式下载。缺失、损坏、非普通文件或符号链接一律拒绝，不返回内容。SQL 发布失败可能保留未引用内容，接口不会将其暴露；不会因单次回滚误删其他产物共用的文件。存储配额、孤立文件回收、完整备份恢复、掉电持久性和 Linux 部署仍待验收。

本轮证据包括真实 HTTP 服务启动/重启、持久审批、完成及认证下载，以及事务故障、旧执行者/过期执行者和并发认领。该早期产物发布检查使用受信确定性夹具，119 项数据库检查与 810 项包检查分别通过；这些是历史结果，当前 Temporal 接线及边界见下文。见[发布研究](../../docs/research/work-artifact-publication.md)。


### 已接纳的 Worker 启动上下文

`work_temporal_start.load_current_activity_task` 通过既有绑定入口核对当前 Temporal 活动所属的
Task／Run，再持有 Task SHARE 锁读取 Bot、目标和 token 上限，并复查取消、撤权与精确 Run 状态。
返回值是独立输入数据，不是执行凭证、预算预留或工具授权；每个效果仍须控制层准入。
调用方只提供受信 namespace／queue／workflow 配置，不能替换 Task ID 或 SDK 活动上下文。

`WorkStartPending` 仅表示交接尚未证实，不返回任务数据，也不证明已存在有效预留；有界重试
由 Temporal 负责。公开参考流程为启动单独设置每次 10 秒、累计 120 秒上限，保留首个活动身份与
None 返回。错误身份、权限关闭和 Task／Run 缺失直接拒绝，模型和工具重试策略不变。
[可运行参考](../../experiments/work-journey/README.zh-CN.md) 包含 Worker 早于确认启动及等待期间取消的检查。
该可选入口不启用通用产品 Worker、模型服务或默认后端。

## 可选持久 Worker 组合

在独立 Python3.12 环境安装 `requirements-worker.txt`，可使用 Temporal Worker 组合入口。
`openbot_server.work_worker.product_worker` 要求已连接且启用 `PydanticAIPlugin` 的客户端、
权威存储、逐 Run 可信服务加载器和独立结果核验器；不导入测试夹具，也不启用默认 Worker。
有限派发命令为 `python -I scripts/dispatch-work.py --config /绝对路径/operator.json`，
`--check` 仅作本地配置检查。必须显式提供 mTLS 与私有配置；不迁移数据库、不后台轮询、不隐式加载账户。
详见[配置与可复现恢复用例](../../experiments/work-journey/README.zh-CN.md#产品-worker-恢复用例)。


延期工具须同时提供可信 `plan_effect(context, request)` 与
`load_effect(context, stored_intent)` 回调，分别返回 `DeferredPlan` 和原始动作的
`EffectServices`。回调不授予权限。控制层验证工具目录与参数 schema，保存完整提案后才接受
公开审批；准备阶段重试读取原 Action，不重新规划。人工等待结束后的执行使用新 Activity claim；
已准入或 unknown 的 Action 只能核对原动作。

确认 `applied` 后，同一 Workflow 使用完整 SDK 历史和累计模型用量继续。拒绝、过期或已核验未生效
会将任务关闭为失败，不发布产物；取消和撤权不能产生新执行授权。人工修复命令仍区分已持久化、
已送达与已核验完成。此可选路径不提供真实 Linux 执行环境，也不切换默认后端。

### 工作流关闭后的核对

提供可信 `load_lookup(historical_context, stored_intent)`，返回
`LookupServices(lookup, verifier)`，可在同一 Worker 注册按命令隔离的修复 Workflow。
既有运维 CLI 增加 `--repair-closed`，只执行一轮有限派发；核对原 PG 记录的 engine Run
及修复启动身份后才查询，不重启原 Workflow，也不调用模型、准入、写入或发布服务。
原流程仍运行时返回 `waiting_original`；缺少历史保持送达未确认。退出码 0 仅表示各行属于
已送达、已结束或等待原流程（也包括空批次），不代表外部动作成功。

错误、缺失或超时证据保留 unknown 和预算预留。已结束的 unresolved 命令不会被后续修复
改写结果；核验已提交但回执丢失后的重试直接读回，不重新查询。取消、撤权后只补记历史事实。
本可选路径仅处理已保存的延期工具 Action；可信服务配置、产品纠正及 Linux 隔离仍需另行完成。
见[验证记录](../../docs/research/work-closed-repair.md)。

### Owner 执行中纠正（显式启用）

受信组合使用 `product_worker(..., enable_corrections=True)`，Run 加载后可通过
`POST /api/v1/tasks/{taskId}/corrections` 接受纠正。请求须有 Owner 会话、允许的 Origin，
正文为 `{runId, requestKey, expectedSequence, instruction}`。序号从0开始，每个 Run 最多8条，
每条正文最多4096个 UTF-8 字节；包含 JSON 转义后的 HTTP 请求最多32KiB。
同一 Task 重送相同 key 只能读回相同命令。旧的不支持纠正的 Run 拒绝请求，默认配置不变。

202只表示命令已存储，不表示模型已遵循或任务已完成。控制层冻结每段上下文，仅将从未准入的
提案标为 `superseded`；旧批准不能用于执行已作废提案。已准入或 unknown 的动作保留原身份和
预留，用原收据核对，不能重新写入。新提案与最终发布必须匹配本段已消费的上下文。
取消、撤权仍阻止新动作；历史事实读回不会恢复授权。

此配置在每次服务加载时都拒绝 inline 执行器，包括重启后的配置变化。工具走 deferred 审批边界，
模型适配器向 `execute_model_activity` 传入 `correction_context=context.correction_token`；
受信结果核验器也收到同一冻结 token。SDK 继续执行保留完整历史及累计用量，仍受原有256KiB消息
和请求数量限制。命令接受不会豁免限额，也不保证模型理解正确。本增量没有切换默认后端、增加
纠正界面或启用真实服务配置。
