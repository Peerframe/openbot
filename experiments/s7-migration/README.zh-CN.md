# S7 合成数据迁移资格验证

[English](README.md) · [简体中文](README.zh-CN.md)

本实验验证两条旧 SQL 历史下最小数据集的保留路径。它是 S7 的准备工作，不能作为生产迁移工具，
也不代表 S7 已完成。

| 历史 | 固定来源 | 预期路径 |
| --- | --- | --- |
| 架构历史，27 条迁移 | `c33e03f1a14de739196113769c59fdaace9029e7` | 恢复旧数据，再通过现有生产启动守卫执行增量迁移。 |
| 功能历史，19 条迁移 | `9cc73c9e78451e572f57d142d6b9caf62ccb78e2` | 直接升级必须在索引 17 失败；专用实验随后将有限兼容记录转入新建目标库。 |
| 本次目标，33 条迁移 | `e176e90a9de3854f0bf745773b7996e7bd572c83` | SQL 和 journal 必须匹配 `target-history.json`；变化后需重新验证并更新固定记录。 |

两条旧历史共享 0000–0016。`histories/common` 保存公共 SQL 原始字节，两个分支目录保存各自后缀。
history JSON 记录每份 SQL 的哈希、时间戳和来源提交。`sources.mjs` 校验这些快照、复现已有
[`migration-lineage-baseline.json`](../../docs/migration-lineage-baseline.json)，再检查当前目标。
普通浅克隆即可运行，不依赖本机保存的旧 Git 对象。

每份 `fixtures/<history>/seed.json` 包含一个 Bot、一个频道、成员关系、两条关联消息、一个已完成
旧 Run 和一份 Markdown Artifact。UUID、时间、文件内容、哈希和资料修订号固定；架构历史还保留
Bot 私聊频道引用。所有内容均为合成数据，没有真实凭据、活动任务或私人数据。

## 从新检出运行

需要项目支持的 Node/npm 和可拉取固定 PostgreSQL 17.11 多平台镜像的 Docker Engine。无需模型
账号或已有数据库。缺少前置条件会明确失败，不会静默跳过数据库验证。

```bash
npm ci
node experiments/s7-migration/sources.mjs
npm exec -- turbo run build --filter=@openbot/server
node --test experiments/s7-migration/cleanup.test.mjs
node experiments/s7-migration/qualify.mjs --report /tmp/s7-migration-summary.json
npm run check
```

脚本创建专属 `openbot-s7-<UUID>` 容器，使用临时 PostgreSQL 数据卷、仅回环地址可访问的随机端口
和合成凭据。它不接受数据库 URL、源数据目录或输入备份，所有数据库和文件均由本次运行创建。
正常成功或失败都会关闭连接、删除专属容器和临时文件。若进程被强制终止，只清理该次名称且带有
`openbot.fixture=s7` 标签的容器，不清理无关容器或卷。

[专属 CI](../../.github/workflows/s7-migration.yml) 在 Ubuntu 运行同一命令，仅上传 JSON 摘要。
数据库备份、对象文件及行内容都只存在于临时目录。提交的 `evidence/local-result.json` 是本地实际
运行记录，不是托管 CI 已运行的证明。

## 备份与恢复步骤

本实验没有 Server 和 Worker，因此不会出现应用并发写入。对每条旧历史执行下列步骤，迁移或
转移后再执行一次：

1. 用 PostgreSQL 17.11 的 `pg_dump --format=custom --no-owner --no-privileges` 导出完整夹具库，
   保留其中原始 Drizzle 历史。
2. 在持续停止写入的条件下复制配对对象目录，记录备份哈希、确定性数据库快照哈希及文件哈希。
3. 从 `template0` 新建空库，拒绝非空恢复目标或已变化的清单/备份；运行
   `pg_restore --single-transaction --exit-on-error --no-owner --no-privileges`。
4. 将配对文件复制到新目录，比较所有数据行和历史行、核对引用，通过真实 `FileArtifactStorage`
   读取文件，并按恢复后的元数据检查 SHA-256 和大小。
5. 对当前 schema 的恢复副本再次运行启动守卫，确认身份和内容未改变；全部检查后再清理环境。

负向恢复会刻意创建冲突表，要求原生 `pg_restore` 失败且所有新 DDL 回滚。缺失文件和长度不变的
字节损坏也必须失败。仅成功读取备份目录不计为恢复证明。

## 分叉历史转移边界

直接升级失败是必需证据。实验不会改写源历史，也不会把冲突 SQL 标为已应用的目标迁移。目标库
通过现有守卫从空库执行当前迁移，生成自己的真实 journal。

夹具转移仅覆盖 `bots`、`channels`、`channel_bots`、`messages`、`runs`、`artifacts`，每表最多四行。
其他非空表、未知源字段、模型连接、任何 model Run（即使选择为空）、活动 Run 和 Worker 引用都会
失败。先校验引用，再用单事务写入目标；再次导入非空目标必须被拒绝，并比较源快照证明源数据
保留。这个有限范围不构成正式数据库导出协议。

旧任务和文件引用保留在 `runs`、`artifacts`。0027 明确不重新分类旧记录，因此检查要求
`work_tasks`、`work_runs`、`work_artifacts` 为空。旧任务到新工作域的映射仍需单独决定。

## 证据和剩余条件

摘要记录来源/目标提交、迁移摘要、运行版本及逐项通过结果。真实 PostgreSQL 上覆盖哈希漂移、
时间戳漂移、历史中间行缺失及超前历史，并要求失败后状态不变。转移负例覆盖未映射数据、未支持
任务，以及 SQL 本身没有外键约束的孤立消息引用。

本夹具尚未覆盖完整用户数据、附件、模型密文和密钥、插件状态、发布者密钥、认证/审计恢复、
活动任务恢复、Temporal 配对恢复、Desktop 系统密钥存储、全部平台、真实 Provider 或完整产品
旅程。这些仍是 S7 的集成条件。参见[研究记录](../../docs/research/s7-migration-qualification.md)
及[数据库恢复清单](../../docs/DATABASE.zh-CN.md)。
