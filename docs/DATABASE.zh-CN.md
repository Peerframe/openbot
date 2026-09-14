# 数据库运维

[English](DATABASE.md) · [简体中文](DATABASE.zh-CN.md)

OpenBot 把频道、员工、Run、审批、审计记录、Session 和 Artifact 元数据保存在 PostgreSQL；
对象文件、插件状态及加密模型设置位于数据库之外。可用的恢复集必须包括数据库和下列持久文件、密钥。

Migration `0015_employee_memory_lifecycle.sql` 为员工记忆增加乐观 revision 与无内容生命周期
审计。删除记忆会移除标题和正文所在记录，审计只保留员工 ID、记忆 ID、动作、revision、变化
字段、操作者和时间。备份仍包含其他未删除私人记忆，保护等级必须与凭据相同。

Migration `0017_request_throttle_buckets.sql` 增加短时、经摘要化的登录与 Node 登记滥用控制桶。
它只保存范围、域分隔客户端地址摘要、有界计数和时间，不保存原始 IP、密码、登记令牌或 Node 凭证。

## Migration 契约

- 不得修改已经应用的 migration；只能新增带序号的 SQL 文件和 journal 条目。
- `npm run migrations:check` 校验仓库 journal 和 SQL 文件集合。
- Server 启动时先取得 PostgreSQL advisory lock，确认数据库历史是仓库计划的精确前缀，再执行
  Drizzle migration，并验证最终历史完整。
- 哈希、时间戳、缺失条目或数据库超前都会阻止启动。不得手工修改 Drizzle 表来绕过检查。
- `npm run db:verify` 只允许运行在名称以 `_test` 结尾的数据库，并验证并发与重复启动。

重要数据出现漂移时，应对照已部署版本调查并恢复经过验证的备份。一次性本地数据库只有在确认
不再需要其中数据后才可重建。

## 编写迁移

OpenBot 使用经过审阅的手写 SQL 与只追加 journal。
`npm run generate --workspace @openbot/db` 会明确失败并指向正确入口：历史 snapshot 不能用作
schema diff 基线。不要使用 Drizzle generate/push/up 修补该历史。

在仓库根目录打印只读计划：

```bash
npm run migration:plan --workspace @openbot/db -- --name describe_change
```

命令先验证已有 manifest，再打印建议文件名、纯注释 SQL 模板和 journal 条目。不写文件、不连库、
不推断 DDL。不带参数或带 `--help` 时显示帮助。

1. 先 rebase 到当前目标分支。新文件唯一四位前缀必须等于新 journal 条目的零基 `idx`；工具根据
   当前历史计算两者。
2. 在建议路径编写实际 SQL，审阅已有数据处理、约束、事务/锁和恢复方式；多条语句用
   `--> statement-breakpoint` 分隔。同步 `packages/db/src/schema.ts`，保留 SQL-only 约束。
3. 将建议条目追加到 `migrations/meta/_journal.json`。`when` 按
   `max(当前毫秒时间, 上一个 when + 1)` 计算，即使历史时间超前也单调。不改已经应用的序号、
   时间、SQL 或 snapshot。
4. 运行 `npm run migrations:check`。如有其他迁移先合并，rebase 后重新计算尚未发布的文件名和
   条目。计划只预览编号，不预留编号。
5. 分别从空库和上一版本数据库在一次性 PostgreSQL 验证，包含重复启动及业务约束。
   使用 Server 的受保护 `createDatabase(...).migrate()` 路径；直接 Drizzle CLI 不包含 OpenBot
   的历史检查。最后运行 `npm run check`。

Manifest 检查只验证编号、文件对应与单调时间，不证明 SQL 正确。Server 仍在迁移前后检查哈希、
精确已应用前缀和完整历史。

## 备份边界

捕获完整恢复集前必须停止 Server 写入。PostgreSQL `pg_dump` 能提供一致数据库快照，但无法与
另一个卷中正在写入的文件自动协调。停机前先核对真实配置路径：

| 资产 | 位置与必须保存的内容 |
| --- | --- |
| PostgreSQL | 配置数据库的逻辑归档，以及匹配的 PostgreSQL 主版本和 OpenBot 构建身份 |
| 对象与插件 | 整个 `OPENBOT_OBJECT_STORE_PATH`，包括报告、附件原文/元数据/派生文本及 `plugins/state.json` |
| 模型目录模式 | 整个 `OPENBOT_MODEL_DIRECTORY`，包括 `encryption.key`、`settings.json`；密钥丢失后密文不可读 |
| 旧模型配置模式 | `OPENBOT_MODEL_SETTINGS_PATH` 与受保护服务配置中对应的 `OPENBOT_MODEL_ENCRYPTION_KEY`；不要将密钥写入公开清单 |
| 可选员工签名 | 整个 `OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH`，以及独立配置的 `OPENBOT_EMPLOYEE_PUBLISHER_PASSPHRASE_FILE` |
| 服务配置 | 恢复连接所需的受保护配置，包括 Owner/数据库凭据及已配置外部密钥；保留严格访问权限和恢复方法 |

源码开发命令在各 workspace 运行，因此示例 `./data/objects`、`./data/model` 位于 `apps/server`
之下。Compose 使用对象/模型命名卷，见[容器模型持久化](SERVER_CONTAINER.zh-CN.md)。从其他
入口操作时使用核实后的绝对路径。

Desktop 管理的本地 Server 使用 Electron user-data 下的 `openbot/local-server`：包括
`postgres`、`objects`、`model-settings.json` 和经 OS 加密的 `bootstrap.json`；后者含模型、
数据库和 Owner 密钥。保留停机后的完整 data root 及原 OS 账户的秘密存储访问能力。只复制
`bootstrap.json` 不能保证在其他主机/账户解密，本流程不证明 Desktop 跨主机凭据恢复可用。
远程 Desktop 客户端不保存远程 Server 的恢复资产。

1. 停止 OpenBot Server，但保持 PostgreSQL 运行。
2. 使用 `pg_dump --format=custom --no-owner --no-privileges` 创建 PostgreSQL 自定义格式归档。
3. 在 Server 停止期间快照清单中所有适用持久文件及秘密，保留权限，确保模型密文配套原密钥。
4. 记录 OpenBot 版本、PostgreSQL 主版本、migration 数量、资产清单、校验和与备份时间；清单
   标识资产，不能包含秘密正文。
5. 加密恢复集并复制到 Server 主机之外，绝不能提交到 Git。
6. 重启 Server 并确认健康状态。

`pg_restore --list backup.dump` 只能证明 PostgreSQL 可以读取归档目录，不能证明备份可恢复，也
不能证明配套文件、设置和密钥完整。

## 恢复演练

恢复演练必须使用隔离数据库和持久文件副本，不能使用线上目标。保持 Worker Hosts 断开，并在
演练环境阻止向模型/插件/Provider 发起外部请求：恢复的设置与定时任务可能处于启用状态。
恢复检查不需要付费调用。

1. 创建名称以 `_test` 结尾的空数据库。
2. 使用 `pg_restore --single-transaction --exit-on-error --no-owner --no-privileges` 恢复。
3. 将适用的对象、模型设置/密钥、可选签名及配置副本恢复到全新的私有路径，让非生产构建只连接
   这些副本和恢复数据库。恢复正常工作前先验证已保留模型设置能解密。
4. 运行 `npm run db:verify`，抽查频道、员工、Run、审批、审计、Artifact 下载、附件完整性和
   插件/模型设置。读取模型设置不得执行推理；完成恢复后另行决定是否恢复外部连接。
5. 记录耗时和结果，再删除隔离环境。

生产恢复应先写入全新的空数据库和持久文件目录，验证后再切换部署，不能覆盖正在运行的 OpenBot
数据库。

## 回退应用改动

应用逻辑回退后，已经应用的迁移仍须保留在构建的迁移历史中。回退本轮任务流程改动时，保留
`0026_automation_attachment_outcome` SQL 和 journal 条目；扩展后的 CHECK 继续接受所有旧结果值。
该迁移作为单独的前置提交，任务逻辑可单独回退。不要删除数据库中的迁移记录，也不要改写历史 SQL
来强行启动旧构建。启动检查会有意拒绝迁移历史比构建更新的数据库。以后如确需逆转结构，应另写经过
审查的前向迁移，并明确如何处理已有数据。

## 当前限制

- OpenBot 尚不会定时创建、加密、上传、保留或清理备份。
- 尚无时间点恢复或 WAL 归档流程。
- 本地对象存储与 PostgreSQL 之间还没有事务级快照协议。
- 备份凭证和存储 Provider 不属于员工包或工作主机。

这些仍是 M6 工作。相关贡献必须先做上游审查，并证明数据库、持久文件与密钥能完整恢复，不能只证明
归档创建成功。
