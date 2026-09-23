# Python 控制层参考实现

[English](README.md) · [简体中文](README.zh-CN.md)

这是[迁移计划](../../docs/ARCHITECTURE_MIGRATION_PLAN.zh-CN.md)的 S2a-1/2：Python/FastAPI 读取现有 Owner 会话、Bot、频道，
并可显式启用基于现有 PostgreSQL 的登录/退出。可信控制层与不受信任的 Agent Runtime 分开。
**默认后端仍是 TypeScript。业务写入、任务派发、审批、文件、日程和事件尚未迁移。** Python 默认只读，认证写入需显式选择。

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

9 项数据库/HTTP 检查覆盖读取、过期/撤权、只读事务拒绝写入、精确模式历史、非法旧 Bot 状态、并发持久限流、
认证事务失败不签发成功 Cookie，以及真实回环进程和限时 SIGTERM 停止。本段另有 198 项本地测试通过。
没有显式夹具时普通包测试跳过 9 项集成，跳过不算验收。固定版本仍有两项上游测试客户端弃用提示。
Linux CI 已接入这些检查，但本地改动尚未运行托管 CI，二者不能混称。

不读取 `OPENBOT_DATABASE_URL`、dotenv、模型凭据或用户数据库，只清理自有资源。本段不证明外部模型、浏览器或生产表现。

## 显式本地入口与权限范围

为已准备的兼容参考数据库设置 `OPENBOT_CONTROL_DATABASE_URL`，运行 `.venv/bin/python -I scripts/serve.py`。
仅监听 `127.0.0.1`，默认端口 3101，可用 `OPENBOT_CONTROL_PORT`（1–65535）改变；禁用转发头信任与访问日志。
不运行迁移、不读取 dotenv。这不是生产切换指引。

| 设置 | 含义 |
| --- | --- |
| `OPENBOT_CONTROL_AUTHORITY` | 默认 `read-only`；`owner-auth` 显式启用登录/退出写入 |
| `OPENBOT_CONTROL_OWNER_PASSWORD` | 仅认证模式必填；15–1024 个 UTF-16 单元，不能用示例密码。不继承旧 Server 密码变量 |
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
完整客户端兼容、工作区版本快照和持久事件游标仍是后续 S2 工作。

## 复用与许可证

参见[读取研究](../../docs/research/python-control-read-slice.md)与[认证研究](../../docs/research/python-owner-auth.md)。
FastAPI/Pydantic 为 MIT，Starlette/Uvicorn/HTTPX 为 BSD-3-Clause，Psycopg 及二进制发行版为 LGPL-3.0-only，CPython 为 PSF 许可。
安装包声明完整保留，没有内嵌或修改上游代码；分发需保留声明和适用许可证权利。
