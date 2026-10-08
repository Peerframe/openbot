# P4：TypeScript 任务执行与 Python 排空

[English](typescript-control-plane-p4.md) · 简体中文

- 状态：开发中，尚未验收 P4 切换或 Python 排空
- 日期：2026-10-09
- 负责人：@yxflc11
- 决策：[ADR-0050](../decisions/0050-typescript-control-plane.zh-CN.md)
- 验收链路：现有 Owner 任务接口 → 独立版本的 TS Temporal 工作流 → 有界模型与报告 Activity
  → 不可变回执 → 校验与原子发布 → 产物下载。Worker 重启和响应丢失不得重复执行未知副作用。

P4 沿用 P0 已批准的官方 Temporal TS SDK `1.24.0`，固定提交
`1fd1c81a0383f5f5c7923dd735472c7d1ffdc867`（MIT）。2026-10-09 复核了官方发布、npm 元数据、
重放测试和 TypeScript 文档；仓库公开安全公告 API 未返回公告，这不等于完整漏洞审计。
原生模块已实际加载通过，依赖闭包审计结果见下文。采用已有 Node 24.21.0 和已缓存的 Temporal Server
1.32.0 镜像；禁用安装脚本，不自动下载测试服务器，不安装桌面应用，不调用付费模型。
具体来源、对比和验证边界见同版本英文记录。

现有 Python 会扫描所有待启动任务。因此先在现有任务交接事实中增加不可变执行归属；历史记录
默认归 Python。扫描和加锁后的预留、确认都必须核对归属；不能用环境变量或工作流名称替代持久
事实。新根任务在插入前选定归属，子任务继承根任务。Python 继续处理旧历史，TS 使用独立版本的
工作流与队列。保留 Python 只用于过渡和排空；没有跨语言历史重放证据时不直接接管旧历史，
不增加第二个调度器或通用自主代理框架。

P4 集中在一个分支推进。首个完整检查点是现有空资源范围的原生任务及报告工具；扩大资源范围、
频道任务、Worker 连接、命令/浏览器/媒体/插件、协作以及 Python 排空仍属于 P4 必需范围。
候选必须显式启用并拒绝未支持的资源范围；不会以测试夹具输出代替真实产品行为。切换验收前
不改变公共默认入口。Server 继续独占身份、权限、根预算、执行占用、审批和发布；模型使用已有
受审阅连接与精确端点，发送前复核权限，SDK 零重试，传输有界。测试使用可控模型替身。
请求回执未确定时只能查询，不能重发；工作流代码不能访问数据库、文件、凭据、环境或网络。

未复制或改编上游源码；沿用上游 MIT 声明。以当前 Python 行为为兼容依据，退役 TS 代码仍只是
测试参照。不改写数据库迁移历史、不搬数据。排空必须同时检查完整分页的 Temporal 与 SQL 事实，
包括未确认启动、运行/续接链和尚未对账的副作用；引擎结束不能成为重试副作用或发布产物的授权。

必需验收包括真实 PostgreSQL 并发与跨归属拒绝、真实 HTTP 与现有网页请求、真实 Temporal
启动/历史绑定、Worker 重启与响应丢失、TS 历史重放、不可变报告与原子发布、显式回切与临时夹具
清理，以及 `npm run check`。接口组切换前必须界面验收 `PASS 12/12`。P4 全部完成还要求全部运行时
工具、真实隔离执行链路及 Python 排空证据；当前检查点不代表 P4 完成、生产排空、安装发布或 P5 退役。

## 当前实现边界与依赖审计

当前本地实现仅完成引擎/控制底座，尚未接入产品启动，也未切换公开接口。真实引擎探针用合成控制
Activity 组合实际 SQL 交接、Activity 绑定和执行栅栏，证明单次启动、恢复、回放和并存；不代表
模型/工具执行、报告发布、浏览器/执行器集成或生产排空。公开 HTTP → 模型 → 产物仍是同一分支
的下一完整产品检查点。

`npm audit --omit=dev` 首次发现 GHSA-68fv-2mgg-jv7q：SDK 的 source-map-loader 会使用已有锁定
版本 source-map-js1.2.1。已审核[公告](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)、
[1.2.2 发布](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2)及
[修复与测试 PR79](https://github.com/7rulnik/source-map-js/pull/79)。兼容的 BSD-3-Clause 补丁
限制索引 source-map 偏移并包含回归测试。只更新这一已有解析版本，其余原有依赖版本保持不变，
保留 LICENSE。复查生产依赖为零已知漏洞。实际工作流打包和回放覆盖此加载器，完整仓库检查覆盖
已有 Web 消费者。

`npm run test:work:ts` 使用已有且锁定验证的 Worker 环境。归属明确的夹具启动 PostgreSQL 持久化
Temporal1.32.0 与 mTLS，运行 TS/SQL 探针并清理资源；现有托管 Temporal 验收作业执行相同命令。
没有新增常驻服务、超出测试生命周期的容器、桌面应用或付费模型调用。原生 SDK 已在 macOS arm64
实际加载通过。

## 本地底座验证（2026-10-09）

- `npm run test:work:ts`：macOS arm64 上真实 PostgreSQL/Temporal1.32.0 与 mTLS 通过。
  覆盖并发预留/归属隔离、取消后的丢响应恢复、Worker 替换、旧栅栏拒绝、Continue-As-New 和前后
  两段导出历史回放，以及 Activity 提前执行的确认竞态。Activity 为合成控制探针，不代表产品
  模型/工具执行完成。
- `npm test --workspace @openbot/work`：9 项通过。最终源码 `npm run check` 通过；未变的 Turbo
  任务复用缓存，此前完整运行实际执行受影响 Work/Server/Desktop/Web 消费者。初次检查正确拒绝
  旧迁移/闭包指纹，已更新为实际验收目标，没有放宽门禁。
- 指定已验证 Worker 解释器的 `npm run test:control:python`：控制面1,077 通过，基础环境的2 项
  可选 Temporal 测试跳过；Worker1,589 通过，1 项外部历史输入跳过。两个新增跨归属 PostgreSQL
  拒绝测试均实际执行通过。既有 harness quality 通过，跳过项不算通过。
- 既有合成迁移/配对恢复验收：canonical56 的40/40 通过。新增 SQL SHA-256 为
  `9c54411cde1c4a0779b077c956765ff4848a82998e9d1268b0ba7166895150d1`，journal SHA-256 为 `6aa92977510c6a9297f54847b7d4627df9fe2f575b140f787332e92a0e046a41`。
  target-history 保留 main 集成基线与精确的未提交追加后缀，未修改旧 SQL 字节。
- macOS arm64 TS/Python 运行时暂存成功。既有 P3 原生检查覆盖重启/会话/模型设置、34 项资源和
  13 项可携带性合同、子进程/父进程退出与停止；模型联网次数0。暂存包自带 Node 实际加载
  Temporal SDK/原生桥成功。这不代表 P4 桌面执行、已安装 Keychain 或 P4 安装包发布。
- 生产依赖审计为0 已知漏洞。本轮 P4/PostgreSQL/Temporal 测试容器均已清理，没有安装应用或使用
  生产数据。本轮未切换公开接口组，因此不声称新的 UI12/12 结果；产品切换前仍须完成该门禁、
  真实端到端执行和 Python 排空。
