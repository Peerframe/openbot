# 调研：可复现的贡献与迁移流程

- 状态：已接受，进入实施
- 日期：2026-09-14
- 负责人：@yxflc11
- 关联：Owner 授权的独立仓库检查后续修复
- 验收路径：贡献者先启动 Server/Web，再按需登记 Node；获得安全的手写迁移计划，并能列出完整恢复资产。
- 安全边界：迁移帮助只读且不连接数据库；既有 SQL、snapshot、journal 条目和启动检查不变；Node 凭据仍由 Owner 登记流程产生。

## 检索证据

2026-09-14 检索 GitHub：`repo:drizzle-team/drizzle-orm 0.31.10 snapshot generate`、`repo:drizzle-team/drizzle-orm custom migrations`、`repo:mozilla/pdf.js 6.3.289`。已检查复用账本中的 PostgreSQL 生命周期、Node 身份引导、备份恢复、PDF 依赖记录，以及 DATABASE、开发脚本和 Desktop/容器持久化配置。

- [Drizzle Kit 0.31.10 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/drizzle-kit@0.31.10)、[固定 tag 的 migrationPreparator.ts](https://github.com/drizzle-team/drizzle-orm/blob/drizzle-kit@0.31.10/drizzle-kit/src/migrationPreparator.ts) 和 [CLI generate 测试](https://github.com/drizzle-team/drizzle-orm/blob/drizzle-kit@0.31.10/drizzle-kit/tests/cli-generate.test.ts)：生成依赖前一个 snapshot，测试区分普通生成与 `--custom`。阅读了发布包源码和上游测试，未运行完整上游测试套件。
- [官方自定义迁移文档](https://orm.drizzle.team/docs/kit-custom-migrations)允许手写 SQL。继续使用已有 Drizzle ORM 0.45.2/Postgres.js 3.4.9 执行路径。
- [开放问题 #5528](https://github.com/drizzle-team/drizzle-orm/issues/5528)讨论无 snapshot 的生成方式；[#6093](https://github.com/drizzle-team/drizzle-orm/issues/6093)报告 0.31.10 的 PostgreSQL introspection/generation 不对称。这些是上游报告，不代表 OpenBot 复现了每项；不能据此静默重建本仓库基线。
- 对 `3a02750e8851298a1b27246fd1ac4925f319fdc1` 的隔离检查确认唯一 snapshot 没有表；固定 CLI 在未修改的副本生成了全部 24 张已有表，当前生成时间还早于 journal 末项。历史 SQL 的额外约束也意味着不能仅靠 TypeScript schema 替换历史。
- [PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)限定数据库归档范围；库外文件和密钥需协调备份。本次只补齐现有运维流程，不新增备份引擎。
- [PDF.js 6.3.289](https://github.com/mozilla/pdf.js/releases/tag/v6.3.289)，提交 `1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56`，以及[已有解析器调研](pdfjs-6.3-lock-coherence.zh-CN.md)：逐字节保留安装分发包的全部许可证文件，只同步版本、来源、哈希及确有变化的 notice 原文。

## 候选比较

| 候选 | 固定版本或提交 | 许可证 | 维护与测试 | 平台/API/安全适配 | 决定 |
| --- | --- | --- | --- | --- | --- |
| Drizzle 普通生成 | drizzle-kit 0.31.10 | MIT | 已读 snapshot 准备代码和 CLI 测试 | 当前没有可信 baseline，可能输出已有 DDL | 停用误导入口 |
| Drizzle 手写约定 + OpenBot 只读计划 | drizzle-kit 0.31.10；drizzle-orm 0.45.2；3a02750 的 manifest checker | MIT | 复用 SQL/journal 和已有检查 | 适配四位唯一编号与单调时间，不改历史 | 选择薄适配器 |
| 重建 snapshot/升级迁移格式 | 未选择 | 上游 MIT | 需完整数据库等价性与升级审查 | 超出范围，可能丢失 SQL-only 约束 | 延后 |
| PostgreSQL 归档 + 停机文件快照 | PostgreSQL 17 文档；3a02750 的 Server 生命周期 | PostgreSQL License | 保留已有迁移/恢复检查 | 补齐模型密钥、设置、插件、对象及可选签名凭据 | 保留原生工具，仅更新流程 |

## 复用决定

保留发布版 migration runner 和手写 SQL。窄 Node.js 帮助工具先复用 manifest 校验，再打印 journal 建议条目和纯注释 SQL 模板；不加载 schema、不调用 Drizzle generate、不连库、不写文件。普通 generate 返回稳定失败及正确入口。差集仅是 OpenBot 的编号、时间和历史契约。自动生成只有经过独立完整 baseline 等价性审查后才能重新考虑。

最短开发路径先构建依赖并仅启动 Server/Web；单独步骤通过现有已认证脚本签发一次性 Node token。缺少登记使用固定错误码和可执行提示；其他存储/Provider 错误保持无内容诊断，不改变认证权限。

## 源码与声明

未复制或实质改编上游实现和测试。`pdfjs-dist@6.3.289` 许可证文件按原字节复制到 `licenses/runtime/pdfjs-dist`，在 `sources.json` 记录版本、路径和哈希；保留所有独立字体和解码器声明。

## 验证计划

- 执行被停用的 generate 和只读 plan，比较完整迁移目录前后哈希；拒绝坏名字、冲突/不完整历史；在 journal 超前时仍计算单调时间。
- Node fixture 验证未登记不发请求、不保存凭据，固定提示可用；未知存储异常正文不泄漏。
- 核对 PDF notice 完整清单、安装版本和字节哈希；保持 staging 路径不变。
- 运行定向测试和双语文档检查；主线运行仓库检查及隔离 PostgreSQL 迁移验收，不需要付费模型或真实数据。
- 开发步骤只针对源码；Desktop 的 OS 保护 bootstrap 不声明可跨用户或跨主机恢复。备份自动化和完整异机恢复不在本次范围。

## 验证证据

2026-09-14 在 Node 26.0.0、npm 10.9.9 下，3 个迁移计划测试全部通过，包括完整迁移目录的前后哈希对比。真实 workspace `generate -- --custom` 入口以代码 1 退出，给出固定停用标记。其他任务追加迁移 0026 后，真实 plan 命令选择 0027，时间戳大于 journal 末项，未创建 SQL 文件。

2 个 Node 身份定向测试通过。真实 `apps/node/src/index.ts` 在隔离空环境和临时凭据目录运行，以代码 1 退出，输出 `node_enrollment_required` 和登记命令，未创建身份文件；未使用 Server、Provider、外部模型或真实凭据。

PDF.js 全部 11 份保留许可证的路径、字节及记录的 SHA-256 均与安装版本 6.3.289 一致。上游 2 份声明与旧保留副本不同：`standard_fonts/LICENSE_LIBERATION` 为分发包的 GPL v2 字体协议及例外，`wasm/LICENSE_PDFJS_QCMS` 为 MIT 正文；两者均逐字保留。原打包复制路径不变。文档检查与定向 Biome 检查通过；完整仓库和隔离 PostgreSQL 验收由主线负责。

## 未决项

snapshot 自动重建和 Desktop 异机凭据恢复另行处理。迁移编号只预览、不预留；存在并行迁移时必须在 rebase 后重新计算。
