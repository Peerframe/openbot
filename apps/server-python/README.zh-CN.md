# Python 控制层参考实现

[English](README.md) · [简体中文](README.zh-CN.md)

这是[迁移计划](../../docs/ARCHITECTURE_MIGRATION_PLAN.zh-CN.md)的 S2a-1/2/3/4/5/6：Python/FastAPI 读取现有 Owner 会话、Bot、频道和近期消息，
并可显式启用基于现有 PostgreSQL 的登录/退出。可信控制层与不受信任的 Agent Runtime 分开。
**默认后端仍是 TypeScript。** Python 默认只读；显式 `owner-auth` 启用认证，`identity` 额外启用 Bot/频道创建、私聊、加入成员与带版本检查的资料编辑。
任务派发、审批、文件、日程和实时事件尚未迁移。

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
npm run test:control:python
```

夹具先构建现有 Server，自建回环 PostgreSQL 17.11 容器，执行未改动的 Node 迁移历史，使用合成凭据、Bot 和频道。
与真实 TypeScript API 对照，覆盖 Unicode、多成员频道和私聊。旧接口未规定成员顺序，只有成员 ID 按集合比较，Python 按 ID 排序；
其余夹具字段逐项相同。两边可识别对方签发的会话，并共同识别撤权。

35 项数据库/HTTP 检查覆盖读取、过期/撤权、只读事务拒绝写入、精确模式历史、非法旧 Bot 状态、并发持久限流、
认证事务失败不签发成功 Cookie，以及真实回环进程和限时 SIGTERM 停止。身份检查还覆盖精确审计/成长事件、缺失成员、并发重名、审计失败回滚、等锁时撤权、等审计时过期、真实 HTTP 创建。
另有 105 项输入差分，以已安装 Zod 与 Python 的真实结果对照。
没有显式夹具时普通包测试跳过 35 项集成，跳过不算验收。固定版本仍有两项上游测试客户端弃用提示。
Linux CI 已接入这些检查，但本地改动尚未运行托管 CI，二者不能混称。

不读取 `OPENBOT_DATABASE_URL`、dotenv、模型凭据或用户数据库，只清理自有资源。本段不证明外部模型、浏览器或生产表现。

## 显式本地入口与权限范围

为已准备的兼容参考数据库设置 `OPENBOT_CONTROL_DATABASE_URL`，运行 `.venv/bin/python -I scripts/serve.py`。
仅监听 `127.0.0.1`，默认端口 3101，可用 `OPENBOT_CONTROL_PORT`（1–65535）改变；禁用转发头信任与访问日志。
不运行迁移、不读取 dotenv。这不是生产切换指引。

| 设置 | 含义 |
| --- | --- |
| `OPENBOT_CONTROL_AUTHORITY` | 默认 `read-only`；`owner-auth` 启用登录/退出；`identity` 额外启用 Bot/频道创建、私聊、加入成员与带版本检查的资料编辑 |
| `OPENBOT_CONTROL_OWNER_PASSWORD` | 认证与身份模式必填；15–1024 个 Unicode 字符，不能用示例密码。不继承旧 Server 密码变量 |
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
拒绝与回滚；显式启动进程也通过真实 HTTP 验证两个入口。移除成员、提交消息与 S2b 一起迁移，因为它们还会取消或创建任务及审批。
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

## 复用与许可证

参见[读取研究](../../docs/research/python-control-read-slice.md)、[认证研究](../../docs/research/python-owner-auth.md)、
[输入契约](../../docs/research/python-identity-inputs.md)和[身份事务](../../docs/research/python-identity-transactions.md)。
FastAPI/Pydantic 为 MIT，Starlette/Uvicorn/HTTPX 为 BSD-3-Clause，Psycopg 及二进制发行版为 LGPL-3.0-only，CPython 为 PSF 许可。
安装包声明完整保留。UUID 模式改编自 Zod，完整 MIT 声明随包保存在
[第三方声明](THIRD_PARTY_NOTICES.md)；未修改已安装依赖。分发需保留声明和适用许可证权利。
