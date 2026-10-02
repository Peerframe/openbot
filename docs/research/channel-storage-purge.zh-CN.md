# C21：频道附件永久删除与实测存储空间

2026-10-03；依赖 C19 PR #161，基准 `85c2f7d`（开始时尚未合并）。
英文决定与主证据：[channel-storage-purge.md](channel-storage-purge.md)。
复用 C19、频道附件、ADR-0047 和现有 OwnerTransactions／审计。
使用已固定的 PostgreSQL 17.11（REL_17_11，PostgreSQL 许可证）、psycopg 3.3.6（LGPL）、
Python 3.12 标准库（PSF），不增加依赖，不复制上游源码。

检查 PostgreSQL 官方锁契约、REL_17_11 的 LockTable 源码，以及 CPython v3.12.12
的 descriptor-relative rename／fsync 实现；410 语义参考 RFC 9110。精确链接见英文决定。
比较将文件迁入 PostgreSQL（大型迁移）、新增存储／队列服务（新增运维边界）、复用私有文件目录
加有界同文件系统暂存日志和小型 SQL 删除／幂等凭证，选择第三项。
最终引用复核、删除凭证、逐文件审计在同一 SQL 事务提交。回滚或提交结果不明时，由真实 SQL 查询
决定恢复原件还是完成物理删除；SQL 不可用则保留待恢复状态。每次获取跨进程文件锁都先恢复，
已运行的另一 Server 也不能跳过。只保留最小 gone 标记，在原频道返回 410，不保留原件或派生内容。

最终持有 messages／runs 的 SHARE 表锁直到提交，阻止并发 INSERT／UPDATE 的幻影引用；
暂存后的新引用使单文件删除返回 409、批量清空保留该文件。正常引用准入也共用文件锁。
沿用语句、锁、事务超时；粗粒度锁可能短暂延迟其他频道写入，争用失败则拒绝删除。
仅靠最终表锁会推迟迟到的写入，不能阻止解锁后引用已删除文件。因此增加窄范围的
SECURITY INVOKER／VOLATILE 触发器，拒绝消息内容或 Run 指令中的已永久删除附件引用。
VOLATILE 取新快照，能看到等锁期间提交的删除凭证；只查同频道及凭证主键，不增加双写引用表。

清空使用 UUID requestKey，提交的响应重试时原样返回，不重复审计，不处理后来回收的文件。
自动清理是 Server 生命周期维护，独立于模型与 Temporal 任务准入；默认关闭、只可选择 30 天。
先持久化每日领取与 started 审计，再事务性复核设置、年龄、引用并追加终态审计。
任何引用不明都不能授权该轮的任何删除。进程中断保留 started 状态；提交回复丢失要查终态凭证。

空间统计只扫描有界、拒绝跟随链接的受管目录，并查询实际数据库大小。工作电脑浏览器目录不可测，
返回 null；频道附件与 Owner 原生任务附件分别计量，后者不由 C21 删除。
实际逻辑字节与物理磁盘空闲空间不同，不估算未知项。

## 当前交接

目录 `/private/tmp/openbot-c21-storage`，分支 `codex/c21-storage-purge`，实现版本 `8209bf9`，
已对齐 C19 的 `6dd5d32`。PR [#164](https://github.com/Peerframe/openbot/pull/164) 依赖
[#161](https://github.com/Peerframe/openbot/pull/161)，应先合并依赖；不开自动合并。
不改 Web，不调用付费模型，不发布，不修改生产数据；Claude 负责 ChannelFilesTrash／SettingsStorage 界面。

接口：永久删除、带 UUID requestKey 的频道清空、Owner 存储读取、带 expectedRevision 的
null／30 天清理设置，详见 [API.zh-CN.md](../API.zh-CN.md#c21频道回收站永久删除与实测存储空间)。
迁移 0050 增加最小删除／重试凭证、关闭的默认设置及迟到引用守卫。整频道删除原有契约不变。

真实隔离 PostgreSQL 17.11／HTTP 重点检查：**26 项通过、零跳过**，其中 C21 15 项、C19 3 项、
原有生命周期 8 项。覆盖已有／中途消息与任务引用、等锁写入及大小写更新拒绝、Owner 失效回滚、
同键清空重试、保留列表／频道上限、SQL 不可用／提交回复丢失恢复、整频道删除、默认关闭、31／29 天
边界、引用保护、维护启动／停止、整轮失败回滚、实测分类／未知项与链接拒绝。

`npm run test:control:python`：**1,031 项通过、2 项跳过**；基础解释器未安装 temporalio，
两项 Temporal activity／effect 模块由托管 Worker 检查执行。C21 无跳过。
对齐 C19 后的 `npm run check` 通过：18 个构建任务成功，17 个缓存。
初次沙箱拒绝回环监听，授权本机隔离检查已通过；初次 SQL 检查发现一项旧频道读取锁顺序断言，
为暂存恢复改成先文件锁、再 Owner 事务后，完整 SQL 检查通过。

首轮托管 validate 通过，但 S7 当前目标 pin 与产品容器预检仍固定 50 条迁移，导致资格检查失败。
只更新当前目标 pin 和预检为 51 条，历史封存 SQL 不动；修正后的 `npm run check` 再次通过，
18 个构建任务全部缓存。真实 S7 重新验证通过 40 项迁移／恢复及
8 项清理检查；[无内容报告](../../experiments/s7-migration/evidence/channel-storage-result.json)。

托管结果和不可变运行／任务链接维护在 PR 的 Verification 栏及
[当前版本检查](https://github.com/Peerframe/openbot/pull/164/checks)，以托管实际结果为准。
上述基础解释器与托管 Worker 的证据分开标明，不把跳过记为通过。
