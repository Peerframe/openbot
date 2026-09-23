# Python 控制层参考实现

[English](README.md) · [简体中文](README.zh-CN.md)

这是[迁移计划](../../docs/ARCHITECTURE_MIGRATION_PLAN.zh-CN.md)的 S2a 与 S2b-1：Python/FastAPI 读取现有 Owner 会话、Bot、频道和近期消息，
并可显式启用基于现有 PostgreSQL 的登录/退出。可信控制层与不受信任的 Agent Runtime 分开。
**默认后端仍是 TypeScript。** Python 默认只读；显式 `owner-auth` 启用认证，`identity` 额外启用 Bot/频道创建、私聊、加入成员与带版本检查的资料编辑。
`tasks` 额外启用原子任务入队。任务派发、审批、文件、日程和实时事件尚未迁移。

## 开发与验证

本目录已有 Python 3.12 时运行：

```sh
./scripts/bootstrap.sh
./scripts/check.sh -q
```

`OPENBOT_CONTROL_PYTHON` 可选择可信的启动解释器。已验收的 Agent Runtime 虚拟环境保持独立。
锁定 23 项开发依赖，拒绝缺失、多余或版本漂移。环境包含测试工具，不是生产镜像；启动不会自动安装依赖。

仓库根目录运行一次性数据库流程：

```sh
apps/agent-runtime-python/scripts/bootstrap.sh
npm run test:control:python
```

夹具先构建现有 Server，自建回环 PostgreSQL 17.11 容器，执行未改动的 Node 迁移历史，使用合成凭据、Bot 和频道。
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
仅监听 `127.0.0.1`，默认端口 3101，可用 `OPENBOT_CONTROL_PORT`（1–65535）改变；禁用转发头信任与访问日志。
不运行迁移、不读取 dotenv。这不是生产切换指引。

| 设置 | 含义 |
| --- | --- |
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

写入要求当前 Owner 会话和准确 Origin。提议、预留、记录已核实结果的方法仅供受信控制层使用；客户端、Runtime、Worker 没有自行提交核对结果的端点。工具调用 ID 不是去重保证，摘要和回执格式校验也不能证明外部事实；`resolve` 只能接收受信适配器独立核对后的证据。

Task 行锁使不同 Run 共享预留，并原子提交事件、用量和结果。未知结果不退款；核实的超额用量如实记录并阻止新支出。当前参考限制为每 Task 256 个 Action、规范 JSON 意图 16 KiB、审批期限最多一小时，不等于完整费用或资源预算。

`0027` 基础检查当时新增 10 项真实 PostgreSQL 测试，控制层集成共 105 项。新增公开接口使用 ASGI TestClient 与真实数据库，客户端关闭重开仍取得已提交状态；该基础检查尚未证明 TCP/浏览器重连、引擎故障恢复、真实副作用核对或产物发布；后续发布检查见下节，完整引擎/执行器流程仍待验收。见[研究](../../docs/research/work-domain-admission.md)。

### 执行归属与产物发布

受信引擎适配器在提议/准入 Action 或完成任务前，须调用 `claim` 获得 `WorkFence`。新的认领 ID 增加 Run 执行版本；重放旧 ID 不续期、不恢复执行归属。参考上限为每次 1–300 秒、每 Run 最多 10,000 次。这是数据库写入约束，不是调度器，也不能阻止目标服务未校验版本的外部 HTTP 请求；审批、权限和共享预算仍须分别检查，引擎负责安排有界执行，Store 不增加续租循环。

显式 `work` 模式可设置 `OPENBOT_CONTROL_ARTIFACT_ROOT`，指向已有的绝对路径、控制层私有 POSIX 目录（0700）。配置错误会拒绝启动；不设置时仍可提交/批准，但不能发布/下载文件。不得将目录挂载给不受信执行器。发布使用不可变内容键、文件及目录刷盘和真实读回校验；当前限制为每次最多八个文件，每个 8 MiB，格式处理和任务语义验收由受信适配器负责。

控制层 `complete` 再次检查当前执行版本、期限、Task 版本和权限，要求所有已提议 Action 确认执行且没有未结束同级 Run，并核验真实文件，再原子提交产物元数据、摘要、终态及事件。同内容重试读取已发布结果，不同内容冲突；本段尚无部分完成或豁免动作的状态。模型最终回答或自报回执不能直接完成任务，也没有公开 complete/resolve 接口。受信 `resolve` 可在撤权后核实已准入动作，不产生新的执行权限。

`GET /api/v1/artifacts/{artifact_id}` 校验 Owner 后读取数据库描述符，再核对文件大小和 SHA-256，以编码文件名及禁止嗅探的附件形式下载。缺失、损坏、非普通文件或符号链接一律拒绝，不返回内容。SQL 发布失败可能保留未引用内容，接口不会将其暴露；不会因单次回滚误删其他产物共用的文件。存储配额、孤立文件回收、完整备份恢复、掉电持久性和 Linux 部署仍待验收。

本轮证据包括真实 HTTP 服务启动/重启、持久审批、完成及认证下载，以及事务故障、旧执行者/过期执行者和并发认领。测试中的执行流程是受信确定性夹具，尚未接入持久引擎、真实模型或外部副作用执行器。真实数据库/HTTP 检查共 119 项通过，Python 包检查通过 810 项（119 项数据库用例另行运行），`npm run check` 通过。见[发布研究](../../docs/research/work-artifact-publication.md)。
