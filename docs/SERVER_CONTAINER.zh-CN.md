# Server 容器

[English](SERVER_CONTAINER.md) · [简体中文](SERVER_CONTAINER.zh-CN.md)

从源码构建的 Server 镜像采用 Debian Bookworm slim 上的 Node.js `24.21.0` LTS，并在
[Dockerfile](../deploy/server/Dockerfile) 中固定经过审查的多架构 digest。构建使用 npm
`10.9.9`，把仓库裁剪为 Server 及其六个内部运行工作区；最终镜像只复制这些工作区的编译输出、
生产依赖、包元数据和数据库 migration。官方基础镜像随附的 npm 和许可证声明予以保留。

这是 pre-alpha 部署基线。本地 arm64 Docker Desktop 测试以及 Linux amd64、arm64 原生任务
均已通过，见 [CI 33938120773](https://github.com/yxflc11/openbot/actions/runs/33938120773)。
本地测试或绿色托管 CI 都不代表通用生产环境或宿主平台
支持。该工作流不向镜像仓库发布产物。已有来源证明的 Worker 运行时仍保留 Node `22.22.2`。

## 从源码构建与运行

在仓库根目录操作；如果还没有 `.env`，请从 `.env.example` 创建。设置至少 15 个字符的随机
`OPENBOT_OWNER_PASSWORD`，以及独立随机的 `OPENBOT_POSTGRES_PASSWORD`。当前 Compose 会把
数据库密码直接拼入 URI，因此请使用足够长的随机 URL-safe 值，例如 64 位十六进制字符串。
`/`、`?`、`#`、`@`、`%` 等分隔符需要单独审查的编码调整。开发用数据库默认值不适合生产。
请保护 `.env`，不要将其纳入版本控制。

```bash
docker compose --env-file .env -f deploy/server/compose.yaml config --quiet
docker compose --env-file .env -f deploy/server/compose.yaml up --build -d
docker compose --env-file .env -f deploy/server/compose.yaml ps
curl --fail http://127.0.0.1:3001/health
```

使用同一端口前，先停止已有的源码开发 Server。Web 与 Worker 服务需要分别运行；本镜像不包含
客户端或电脑 Provider。两个宿主映射端口仍只绑定回环地址。连接远程客户端前，请遵循现有私网、
TLS、Cookie 和 Origin 配置要求。

Server 以 UID/GID `1000` 运行，使用只读根文件系统、私有的 16 MiB 临时文件系统，以及显式
可写的对象数据卷。PostgreSQL 使用独立持久卷。升级现有部署前，请按[数据库运维](DATABASE.zh-CN.md)
备份两类存储。旧版 root 进程写入的对象卷可能需要运维人员审查并迁移为 UID/GID `1000` 所有。
不会自动修改现有卷的所有权；新卷冒烟通过也不代表旧卷升级通过。不要通过删除数据卷解决权限问题。

```bash
docker compose --env-file .env -f deploy/server/compose.yaml stop
```

Compose 提供 20 秒停机宽限，Server 的 HTTP 排空上限为 10 秒，随后进行最终清理。当前集成证据
覆盖健康、空闲的 Server；启动中断、繁忙调度和数据库卡住时的停机仍需生命周期测试。`/health`
检查进程身份和启动完成，不持续检查数据库就绪。PostgreSQL 目前仍使用版本标签而非不可变
digest，因此不能宣称整套部署达到逐字节可重现。

## 复现验证

运行 `npm run server:container:check` 和 `npm run check` 验证仓库契约。在对应原生目标上使用
`docker build --platform linux/arm64 --tag openbot-server:smoke --file deploy/server/Dockerfile .`
构建（amd64 使用 `linux/amd64`），然后运行：

```bash
OPENBOT_TEST_IMAGE=openbot-server:smoke OPENBOT_TEST_PLATFORM=arm64 bash scripts/smoke-server-container.sh
```

amd64 目标请将变量改为 `amd64`。冒烟只创建和清理自身的临时测试容器、网络与对象卷，验证运行
架构、非 root 身份、依赖清单、缺少密码时拒绝启动、完整迁移日志、健康身份、对象
持久化、migration 幂等和 SIGTERM 零退出码，不发布产物。

详细证据与残余风险见[上游调研](research/server-node24-production-container.md)。

## 持久化模型配置

默认 Compose 会将 `openbot-model` 挂载到 `/var/lib/openbot/model`，并设置
`OPENBOT_MODEL_DIRECTORY`。第一次启动时，Server 在私有目录创建 32 字节加密密钥；加密后的
模型配置保存在同一目录。默认不启用任何提供方，Owner 连接后在 Desktop 设置中配置并明确开启。
源码开发的 `.env.example` 使用 `./data/model`，生命周期相同。

备份时，将**整个模型目录**（包括 `encryption.key` 和 `settings.json`）与 PostgreSQL、对象文件
一起保留。备份应当作机密保护：密钥与密文放在一起，不能抵御读取整个目录的攻击。恢复时使用
Server 用户所有权，目录权限 `0700`、文件权限 `0600`。已有配置却缺少密钥、密钥损坏、符号链接
或 Unix 权限过宽会阻止启动；应恢复原密钥，不要删除数据。容器重启测试使用假提供方验证配置
保留，不发送付费请求。

已有 Desktop 管理的服务继续使用 `OPENBOT_MODEL_SETTINGS_PATH` 与
`OPENBOT_MODEL_ENCRYPTION_KEY` 初始化配置，不要与 `OPENBOT_MODEL_DIRECTORY` 同时设置。
独立部署也可保留原来的显式密钥方案；目前没有自动密钥迁移或轮换。明文密钥只允许 Server 用户
读取，渲染进程与 Worker 不持有，设置 API 从不返回密钥。

## 可选 Python 执行镜像

架构迁移新增 `runtime-python` 构建目标：包含相同 Server 产物、Node 24.21.0、Python 3.12.13
和严格锁定的运行依赖，不包含 Python 测试或 pytest。默认构建和原有 Compose 命令仍选择 TypeScript。
使用同一 `.env` 和 Compose 项目，通过覆盖文件显式选择实验性 Python 执行层：

```bash
docker compose --env-file .env -f deploy/server/compose.yaml -f deploy/server/compose.python.yaml config --quiet
docker compose --env-file .env -f deploy/server/compose.yaml -f deploy/server/compose.python.yaml up --build -d
```

覆盖文件沿用数据库、对象文件和模型设置卷、回环端口、只读文件系统。
Server 在迁移和中断任务恢复前检查固定解释器与完整依赖配置，缺失或漂移时拒绝启动。
身份、凭据、审批、预算、审计和结果发布仍归 Server；容器内 Python 子进程拥有同一系统用户的访问权，
不构成独立沙箱。

切回默认执行层时，先停止交办新任务，让现有任务完成或取消，再使用不带 Python 覆盖文件的原命令，
执行 `up --build -d --force-recreate`。保持相同项目名称、`.env` 和持久卷，不使用 `down --volumes`。
切换镜像不表示迁移检查点或重放已中断的外部操作。

新增镜像沿用必需的双架构容器 CI。对应架构可这样复验（amd64 环境替换下列 `arm64`）：

```bash
docker build --platform linux/arm64 --target runtime-python --tag openbot-server:python-smoke --file deploy/server/Dockerfile .
OPENBOT_TEST_IMAGE=openbot-server:python-smoke OPENBOT_TEST_PLATFORM=arm64 OPENBOT_TEST_AGENT_RUNTIME=python bash scripts/smoke-server-container.sh
```

验收仅使用临时数据和内部测试网络，覆盖真实 Python SDK 工具循环、Unicode 参数、取消、运行依赖清单、
异常依赖在数据库变更前拒绝启动、真实 Server 登录/API、迁移、持久化、重启和 SIGTERM。
工具与模型端口是合成替身，不调用真实模型。
本地结果和平台限制见[打包研究](research/python-server-container.zh-CN.md)；配置 CI 不等于托管验收已通过。
