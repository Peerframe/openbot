# 研究：干净检出的登录与 Node 身份保留流程

[English](2026-09-22-contributor-journey.md)

- 状态：接受并实施
- 日期：2026-09-22
- 维护方：OpenBot maintainers
- 验收流程：完成 `npm ci` 后，在没有构建产物和私人 dotenv 的检出中启动真实 Server/Web，登录，可选注册真实开发 Node，重启后验证 Owner 会话与 Node 身份保留。
- 安全边界：只使用合成 Owner 凭据、临时环回数据库与私有目录；注册仍需 Server 授权的 Owner 一次性操作。Node 不配置 Provider、不执行任务、不获得新增权限。清理仅限本次进程组、私有目录与所有权标签匹配的 PostgreSQL 容器。

## 搜索与审查依据

2026-09-22 查询 GitHub：`repo:vercel/turborepo is:issue is:open shutdown`、固定版本 `graceful_shutdown_test.rs`、`nodejs/node test-child-process-detached`、`porsager/postgres v3.4.9 connect_timeout end timeout`。

核对 [Node 子进程文档](https://nodejs.org/docs/latest-v22.x/api/child_process.html#optionsdetached)、[Turbo run](https://turborepo.dev/docs/reference/run)、[Postgres.js 连接与关闭](https://github.com/porsager/postgres/tree/v3.4.9)、[Docker run](https://docs.docker.com/reference/cli/docker/container/run/)。

已检查复用账本中的贡献者启动、Node 引导身份、迁移完整性、无界面 Runtime fixture 条目；在 OpenBot `2cc32d04d08b1c7e70288b326b990762e0db27aa` 上阅读现有 startup smoke、Runtime Docker 驱动、Node runtime/client/文件凭据与测试、Server 注册接口和 [ADR-0023](../decisions/0023-one-time-node-enrollment.md)。

复用[已有启动研究](2026-09-15-contributor-startup.md)的 Turbo `2.10.12` / `53752d452049bdda47698354b16a83d7ce92ced0`。重新检查固定版本[优雅关闭测试](https://github.com/vercel/turborepo/blob/53752d452049bdda47698354b16a83d7ce92ced0/crates/turborepo/tests/graceful_shutdown_test.rs)，包含 Unix 进程组信号、Node 包装器关闭及子进程生命周期。当天 `shutdown` 开放 issue 查询没有结果，没有替换调度器的证据。

检查 [Node v22.22.2 detached-child 测试及 MIT 许可说明](https://github.com/nodejs/node/blob/v22.22.2/test/parallel/test-child-process-detached.js)，固定提交 `2645dc73720b1b4f27c49f395d3c66025ce126cc` 沿用[已有归档研究](linux-worker-host-archive.md)。官方文档说明仅终止父进程不保证终止后代，因此保留明确的 POSIX 进程组与清理验证，不声明 Windows 支持。

Postgres.js 仍为 `3.4.9`，许可 Unlicense；阅读已安装版本的连接、超时、结束实现及现有集成测试。[该版本发布](https://github.com/porsager/postgres/releases/tag/v3.4.9)修复 issue 1143；开放 [issue 988](https://github.com/porsager/postgres/issues/988) 涉及多主机故障切换。本 fixture 只接受单个环回地址，不声明故障切换能力，并限制连接、语句和关闭等待。

## 候选比较

| 候选 | 固定版本 | 适用性与许可 | 决定 |
| --- | --- | --- | --- |
| 现有 OpenBot smoke 与 Turbo | OpenBot `2cc32d0`；Turbo `2.10.12` / `53752d45` | MIT；已有 CI 启动验证和上游 Unix 关闭回归，执行贡献者实际使用的依赖图 | 扩展现有适配器 |
| 现有 Node 进程、HTTP 与文件 API | Node `22.22.2` / `2645dc73` | Node.js 许可，主要为 MIT；官方 detached-child 测试，支持环回请求、私有目录和 POSIX 进程组 | 复用，不加 runner 依赖 |
| 现有临时 PostgreSQL 模式 | Postgres.js `3.4.9`；`postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0` | Unlicense、PostgreSQL 与镜像组件许可；已用于 Runtime/迁移验证，随机环回端口与 tmpfs 数据 | 复用固定 fixture |
| 新测试框架或重新实现 Node 身份 | 不采用 | 会重复现有生产入口和生命周期测试 | 缺口只是验收驱动，无需新增实现 |

## 复用决定

保留 `dev:smoke` 作为干净检出的入口，增加 `--with-node`。调用真实 `npm run dev`、`npm run dev:node`，不把 Server/Node 类导入脚本模拟启动。通过真实 HTTP 检查代理、登录、一次性注册、Server 在线身份，并在无引导凭据的重启后比较完整身份文件摘要。

本地缺口仅是 fixture 生命周期、分阶段的有界诊断和保留状态断言。默认容器仅在私有标签匹配时删除。显式提供的空 `_dev_smoke` 数据库由调用方管理，不删除、不重置；CI 继续负责销毁临时服务。私有文件和子进程始终清理，不使用私人 `.env`、模型密钥、系统钥匙串或已安装应用资料。

后续升级保留固定镜像、现有 npm/Turbo 版本与凭据契约；工具、端口、非空 fixture、登录或身份失败必须非零退出并指出阶段，不能静默省略已请求的 Node 验证。Windows 支持必须另有原生进程树证据。

## 源码与通知

没有复制或大幅改写上游源码。只在同一 MIT 仓库内复用和整理已有 OpenBot 启动/Runtime fixture。不新增依赖、协议、导出的凭据或上游许可通知。

## 验证计划

- URL/干净检出拒绝、环境隔离、敏感诊断脱敏、身份文件约束与进程组清理测试。
- 真实 Docker-backed Server/Web 登录及会话重启；可选 Node 一次性注册、token 重放拒绝、无引导凭据重连。
- 成功与受控失败/中断后，不遗留自有容器、进程和私有目录。
- 冷启动验收后再运行仓库检查，避免检查构建的产物掩盖首次启动问题。
- 专属英中使用说明；根命令、CI、复用账本由集成工作接线。
- 证据仅覆盖本地 POSIX 贡献者生命周期，不证明原生安装、Provider 权限、电脑操作兼容或付费模型质量。

## 未决事项

本次范围没有未决问题；Windows 原生验收独立处理。

## Darwin 已退出进程组的关闭修复（2026-09-22）

最终集成 `88fbce0` 的干净副本在 Node 断开阶段出现 `kill EPERM`，当时 Turbo 已停止任务。
之前的成功没有覆盖这一竞态。独立 macOS 探针创建一个自有 detached 子进程，确认 `ps` 状态为
`Z` 时 signal zero 返回 `EPERM`，对同一子进程执行 `waitpid` 回收后返回 `ESRCH`。

核对 Apple [kill(2) 官方文档](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kill.2.html)
和固定 [XNU `kern_sig.c` 提交 `f6217f891ac0bb64f3d375211650a4c1ff8ca1ea`](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_sig.c)：
`killpg1` 排除 `SZOMB` 成员，没有可接收信号的成员时 POSIX 路径返回 `EPERM`；不存在的组返回
`ESRCH`。这与本机复现一致，不声称该公开提交就是本机内核版本。上游采用 Apple Public Source
License 2.0，没有复制实现；继续使用 Node 的直接子进程退出通知确认回收，无需新增进程树依赖。

只向已知自有 detached 子进程的 PGID 发信号。遇到 `EPERM`，有界读取仅含 PID、PGID、UID 和状态
的 OS 快照，不读取命令或环境。仅没有成员或全部成员为 zombie 才能证明没有执行仍在进行；存在
活进程或无法检查仍明确失败，并等待直接子进程退出通知。并发 stop 共享一次清理，成功后才标记
stopped；失败后允许 finally 重试。验证真实 zombie 竞态、存活后代、权限拒绝后重试、并发 stop，
以及最终集成版本的冷启动完整旅程。

验证结果：10 项定向测试全部通过，包括真实 macOS `Z`/`EPERM` 竞态，以及需要 SIGKILL 的存活孤儿
后代。全新导出的 `88fbce0` 副本仅替换修复后的 helper 和测试，经 `npm ci --ignore-scripts` 后运行
完整 `npm run dev:smoke -- --with-node`，退出码为 0；随后检查该副本工作目录的进程、端口、标记容器
和私有目录，均无残留。原始失败日志、独立内核探针、成功 smoke 日志及清理证据保留供集成审阅，
没有向无关进程发送信号或删除无关容器。
