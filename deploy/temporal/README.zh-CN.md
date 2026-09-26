# Temporal PostgreSQL 验收配置

[English](README.md) · [简体中文](README.zh-CN.md)

此单机参考配置固定 Temporal Server/admin-tools **1.32.0**、PostgreSQL **17.11** 及镜像摘要，
用于验证[公开任务流程](../../experiments/work-journey/README.zh-CN.md)的引擎持久化。
它不会启用生产 dispatcher 或更改默认后端。[研究与来源](../../docs/research/temporal-postgres-operations.md)。

## 边界与运行

引擎历史和可见性使用独立 PostgreSQL 实例中的两个数据库，不是 OpenBot 的业务授权库。
运行账户只有数据权限，不能创建 schema 对象或修改 schema 版本记录；管理账户负责显式迁移。
服务启动不会自动初始化或升级数据库，迁移使用匹配版本的官方 SQL 工具。

只向宿主 IPv4 回环发布 gRPC 端口，不发布数据库或内部服务端口。基础 Compose 配置**没有前端认证或 TLS**，
信任能访问宿主端口及 Docker 的人员。不能公开暴露，也不能让不可信工具、执行沙箱或无关客户端
接入该网络。Docker 管理员可以读取容器凭据；这不是生产安全配置。

可选 `compose.mtls.yaml` 使用原生双向 TLS，校验服务端名称并要求客户端证书，内部通信也启用。
它只认证一组受信控制服务，**不是 API/namespace 分级授权**；持证客户端仍能调用全部引擎操作。
不能把证书发给不可信 Runtime、工具或公开客户端。数据库私有网桥流量未加密，宿主/Docker 管理员
仍是受信角色。见[传输研究](../../docs/research/temporal-transport-security.md)。

按任务流程 README 准备独立 Python 环境、Docker Compose 和仓库构建后，运行：

```sh
/tmp/openbot-work-reference/bin/python -B -m unittest discover -s experiments/work-journey -p 'test_*.py' -v
/tmp/openbot-work-reference/bin/python -B experiments/work-journey/probe.py --engine postgres-mtls
```

mTLS 路径需要 PATH 中的 OpenSSL。夹具生成临时证书，检查明文、缺少证书、未知客户端 CA、错误
服务端名称都被拒绝，并在每项前后证明合法连接正常。等待批准时停止引擎、更换客户端 CA、拒绝旧证书，
再用新证书恢复同一任务。这不等于即时撤销已有连接、生产 PKI 或无停机轮换。等待与完成历史在内存中
重放，不产生新动作；故意不兼容的工作流必须被拒绝。`--engine postgres` 保留明确的明文对照入口。

手动使用 mTLS 时，在私有环境文件设置绝对 `OPENBOT_TEMPORAL_TLS_DIRECTORY`，只放入
`server.pem`、`server.key`、`server-ca.pem`、`client-ca.pem`。服务端叶证书包含 server/client auth
及 SAN `temporal.openbot.internal`；控制客户端由独立 CA 签发。CA 私钥和客户端私钥不能挂入引擎。
父目录限制宿主访问，四个单独的只读挂载须允许引擎 UID 读取。每条 Compose 命令追加
`--file deploy/temporal/compose.mtls.yaml`，维护命令追加 `--mtls`；缺少配置或证书时拒绝启动。
下方手动维护链接中的命令仅演示明文基础配置。

夹具只创建随机项目、临时凭据和新卷；检查权限拒绝、运行公开任务、恢复旧引擎快照，然后在
`finally` 清理自己创建的资源，不打开用户已有数据库。宿主掉电可能留下测试资源，应按 Docker
显示的确切 `openbot-temporal-qualification-*` 项目清理，不能全局 prune。

## 相邻版本升级验收

提供与 Docker daemon 架构匹配的官方 **1.31.3 Linux 归档**，来源和固定摘要见
[研究](../../docs/research/temporal-release-upgrade.md)。运行：

```sh
/tmp/openbot-work-reference/bin/python -B experiments/work-journey/probe.py --engine postgres-mtls --upgrade-archive /absolute/path/to/temporal_1.31.3_linux_arm64.tar.gz
```

程序检查归档及两个准确普通文件成员的大小/SHA-256，只将 Server/SQL-tool 只读挂载到固定1.32.0
基础镜像。这是**官方二进制替换夹具，不是官方1.31.3容器镜像**。两个版本的 PG schema 内容相同，
因此验证服务升级而非 DDL 变化。旧版在创建任务前完成不可跳过的600秒健康观察；停止引擎后，
检查四个分片与 schema 历史、运行目标官方维护工具，再确认实际运行版本1.32.0。

等待批准、已发布但未确认的任务先在升级后的原卷恢复；之后才把旧引擎快照恢复到新卷，保留更新的
业务事实（包括主任务的未知写入）。检查原引擎 Run ID、完整业务快照、确切请求数、预算和下载内容。
已经完成的 Task 若被旧等待历史再次读取，必须因权限已关闭而停止，不重新工作；引擎结果不取代
业务 Task 的完成事实。升级任务采用1200秒有界期限，CI 使用此较长入口，短版同版本验收仍保留。

它不证明滚动/HA升级、降级、任意未来 Worker 代码、真实 DDL 迁移或完整业务库回滚。

## 手动维护

[英文操作步骤](README.md#manual-schema-inspection)提供完整可复制命令：创建仓库外的私有凭据文件，
启动 PostgreSQL，运行 `maintain.py initialize`，最后启动引擎。示例拒绝覆盖已有凭据文件。

凭据必须是两个不同的随机十六进制字符串，长度 48–128，文件仅当前用户可读写。
固定版本的上游 YAML 模板不能转义任意密码字符，因此入口会先校验。不要输出展开后的 Compose
配置、提交凭据或将密码放进命令参数。只改环境文件不会修改已有 PostgreSQL 角色密码。

维护必须由一个独占管理员执行，并先停止 Worker 和引擎。`initialize` 先检查两个库均为空，
不能顺便升级旧库。`upgrade` 先检查两个版本，拒绝格式错误或高于固定工具版本的库，再调用官方
工具到明确目标：历史 **1.19**、可见性 **1.14**，验证结果并撤销运行账户对版本表的写权限。
失败时引擎保持停止；先检查部分完成状态，不盲目重试，也不绕过检查直接运行底层脚本。

基础配置检查同版本维护与拒绝条件；上述独立相邻版本夹具另验收服务升级，不代表任意版本、Worker 代码升级或回滚。
未来按官方相邻版本规则固定新镜像和 schema，并验证历史重放及恢复任务后再更新。
上游 Server 可以接受部分较新 schema，不能声称所有版本不匹配都会被上游拒绝。

## 恢复语义和未完成项

夹具先停止引擎写入，再使用官方 `pg_dump` 备份两个库，记录大小、SHA-256、schema 和 namespace
身份；使用 `pg_restore --exit-on-error` 恢复到**全新空卷**，重建权限并禁止运行账户修改版本表。
摘要只用于可信本地测试的完整性检查，不等于备份来源认证。

业务库、产物和外部回执刻意不回滚。测试在外部写入已经发生、业务库记录为未知后，恢复先前仍在
等待批准的引擎快照。恢复必须读取回执、遵循当前权限和预算、交付验证后的文件，不能再次写入。
这不是完整产品的原子备份或灾难恢复方案。

生产 API 授权/PKI、版本升级和未来代码的代表性历史重放、保留与归档、HA、存储故障、资源成本、凭据恢复、完整产品恢复
仍需单独验收。完整业务回滚可能恢复旧授权，需要暂停执行并核对事实。此配置不证明 Linux 隔离或
真实模型任务质量。

本地 arm64 验收：12 项升级/公开工作记录、57 项单元检查通过；11 份真实历史无副作用重放通过，
不兼容的首条命令均被拒绝。先验证升级后的原卷继续，再恢复旧快照。
见[实际范围](../../docs/research/temporal-release-upgrade.md#measured-qualification--2026-09-23)。
