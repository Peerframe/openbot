# 研究：S2 任务监督入口

- 状态：实现候选，待主控独立验收。
- 日期：2026-09-24；负责人：@yxflc11；关联：架构迁移 S2。
- 基线：`6f69be91185a08350ca52964c3f0543ef51f0020`；分支：`codex/s2-work-supervision`。
- 验收目标：已登录的 Web/Desktop 共用界面创建 Python work Task，断线后读取服务端快照，并显式取消。
- 边界：身份、授权、任务事实与取消只由 Server 决定。请求失败、超时、导航或组件卸载不会取消任务。客户端没有 Agent 或新增执行授权。

## 检索与复用

2026-09-24 检索 `repo:react/react is:issue is:open useEffect fetch`，查看官方 v19.3.0 标签、Effect 清理测试和 MIT 许可。固定 React 19.3.0 / `1d34f91dfde6bba84d08b683aaba164c7194dacb`，沿用 Zod 4.6.2 和 OpenAPI 3.1.0。参考 [React Effect 清理](https://react.dev/reference/react/useEffect) 与 [OpenAPI 规范](https://spec.openapis.org/oas/v3.1.0)。开放问题 #19671、#37556、#15293 支持显式清理与竞态回归；未引入新的 Suspense 数据 API。

核对复用账本的工作台快照、React 版本一致性、Python 读取与 work admission 条目。检查指定基线的 `work_models.py`、`work_routes.py` 与 `app.py` OpenAPI 生成入口；该基线没有 work 客户端生成脚本或生成产物。

| 候选 | 固定版本及许可 | 适配判断 | 决策 |
| --- | --- | --- | --- |
| HTTP/OpenAPI + 现有 React/Zod | 上述固定版本；规范条款、MIT | 共用浏览器/Electron 渲染器，同源 Owner 会话；官方测试及项目回归可复用 | 采用标准与已发布依赖的薄适配 |
| 旧 Run API 和保存桥接 | OpenBot `6f69be9`；MIT | 任务契约不同；旧产物保存固定 `/content`，work 为 `/api/v1/artifacts/{id}` | 保留现有实现，不假称兼容 |
| 新状态框架或本地 Agent | 未选择 | 超出单条监督流程需要，增加依赖或权限 | 不采用 |

没有复制上游源码、增加依赖或更改锁文件；保留依赖随包附带许可。新增内容只解决入口、创建/读取/取消、快照顺序、原请求显式重试与 stale/unknown 展示。响应不兼容时显式报错；401 复用既有会话失效事件。未来仓库引入生成客户端时可替换此适配层。

## 真实入口修正

实际登录后发现 Python 没有 `/api/v1/workspace`，旧工作台因此返回 404。增加显式 `#/tasks` 入口，在原有连接及 Owner 登录后直接读取 `/api/v1/bots` 和 work API。失败工作台提供入口链接，原工作台侧栏也可进入共用屏幕。不修改 Python 路由、默认后端或 Desktop 授权桥接。

## 验证证据

- 最终 `npm run check` 退出 0。Web 63 文件、370 测试通过。Turbo 类型检查 31/31（28 缓存），测试 31/31（29 缓存），构建 18/18（17 缓存）；仓库前置检查实际执行。缓存的其他平台或环境结果不算新增原生证据。
- 独立夹具通过真实 PostgreSQL 17.11 与本检出的 Python 公共 HTTP 验证登录、Bot、创建/读取/取消、同键重试、参数变化冲突、幂等取消、401/403/409/422、OpenAPI 和退出失效；未使用假 API 或 Worker。
- Chrome 实际入口 `http://127.0.0.1:5189/#/tasks` 创建 `db16b9b0-89fe-4aee-80d1-f5bc77151054`，快照 revision 1 / queued。停止本次 Server 后保留 queued、显示待同步并禁用取消；重启读取仍 queued。点击取消得到 revision 2 / cancelled 和授权关闭。刷新页面后按 ID 读取恢复相同事实。
- 最终构建加载 `index-YCmPl8Ap.js`，新建 `40a9c54f-ba7d-4bdd-b0b3-2bfb2ae9eecb`，在 390 宽度点击取消，得到 revision 2 / cancelled。
- 默认 1470 × 779 与 390 × 844 截图检查通过；窄屏文档宽度为 390，无横向溢出。页面 URL、标题、内容正确，无框架错误遮罩，最终控制台错误/警告样本为空，验证后恢复视口。当前未提供 Browser skill，使用已安装 CUA Chrome 集成完成 DOM、截图与控制台验证，未安装浏览器依赖。
- Vitest/jsdom 模拟反例包括创建与取消回执丢失、同请求显式重试、错误身份/结构、权限与状态拒绝、过期读取、低版本快照、慢轮询、unknown、核验已送达但无结果、卸载不取消，以及 Web/Desktop 入口与侧栏草稿保留。模拟反例不算真实 Worker 验证。

最终浏览器 JS SHA-256：`98d9f9a690c28d679d942478bccb4ed0282583521fbfbfd15a5a6172bbbb273b`。源码 SHA-256 与完整英文记录见 [英文研究与交接](s2-work-supervision.md)。日志：`/private/tmp/s2-repository-check-final.log`、`/private/tmp/s2-owned-probe-final.log`、`/private/tmp/s2-real-http.log`、`/private/tmp/s2-real-server.log`。浏览器 DOM/截图保留在本任务工具证据中，不提交截图。早期临时密码因长度不足被拒绝，仅修正夹具；GitHub 网页缓存失败后改用官方 API。现有大 chunk 与 jsdom `<search>` 警告未隐藏。

## 从干净检出复验

```sh
npm ci
npm run build -- --filter=@openbot/web --filter=@openbot/db
sh apps/server-python/scripts/bootstrap.sh
apps/server-python/.venv/bin/python apps/web/src/test/work-http-probe.py
```

夹具创建唯一命名、只监听回环的 PostgreSQL 容器，使用 tmpfs 数据与仓库现有迁移器，启动真实 Python 和构建后的 Web，验证后只清理其自身资源。需要 Docker 和锁定的 Python 控制环境，不需要付费模型或维护者私有凭证。加 `--serve` 会输出临时 URL 和测试 Owner 密码；打开 `#/tasks` 登录、创建目标、保留 Task ID、读取、取消、刷新后按 ID 读取，Ctrl+C 清理夹具。自动化网络故障注入未纳入该脚本，上面的服务停启为 Agent 实际操作验证。

```sh
npx vitest run apps/web/src/work-api.test.ts apps/web/src/components/WorkTasksScreen.test.tsx apps/web/src/App.navigation.test.tsx --maxWorkers=2
npm run check
```

## 交接范围与剩余项

- 本次只完成创建、快照监督、取消竖切。待主控独立验收；未推送、发布、切换默认或宣称 S2 完成。
- 审批/拒绝、unknown 核验提交和新 work 产物下载仍未接入。Server 已提供的相关事实可显示，核验 delivered 且 outcome 为空仍显示尚无结果。
- 没有任务列表接口，刷新后需用保留的 Task ID 读取。创建响应不明确时，原请求及请求体仅在屏幕挂载期间保留（包含共用侧栏往返），应先显式重试确认，再关闭或刷新页面。不把任务目标或凭证写入持久浏览器存储。
- Desktop 证据为模拟 bridge 的共用渲染器测试和 Desktop 构建；未用已安装原生 Desktop 连接 Python 验证，不作原生功能对等或平台支持声明。
- 客户端 schema 手工对应固定 Python 模型；接口变动需同步并重跑真实入口。缺少 `/workspace`、任务列表和取消送达回执已报告主控，本次不新增这些接口。

## 独立验收返工（父提交 `0a9fc21`，2026-09-24）

主控独立复现两个契约问题。先加入保留回归，修复前 2/2 失败（`/private/tmp/s2-rework-red.log`）：offline 前的在途 GET 晚到后会恢复 fresh；7000 个中文字符虽未达字符上限，却超过 HTTP 字节上限，收到明确 413 后表单仍锁住。

修复前复查该提交的 `http_input.read_json` 与 `work_routes.create`：20,000 字节上限的 413 在 writer 之前返回。复用上述固定 React/AbortController 方案，并核对 [HTML 在线状态规范](https://html.spec.whatwg.org/multipage/system-state.html#browser-state) 和 [RFC 9110 的 413 语义](https://www.rfc-editor.org/rfc/rfc9110.html#name-413-content-too-large)。无新增依赖、源码复制或 Server 契约变更。

修复使 offline 中止在途 HTTP 请求、保留旧快照并禁止离线轮询/操作。中止传输不撤销服务端已提交的写入；重连事件仅启动新读取，最新请求成功后才恢复同步。明确 413 清除被拒绝的创建尝试，允许缩短后用新键提交；网络失败、超时等仍保留原请求体和键，不笼统把所有 4xx 都当成可改键重提。

验证结果（这两个边界以本段为准，前文为上一候选的证据）：

- 相同 focused 命令 32 项通过，覆盖 offline→旧 GET 晚到→保持旧版本/stale/取消禁用→离线 focus/轮询不读取→新 online 读取成功后恢复；413 的多字节正文可修改且改用新键；网络错误、TimeoutError、HTTP 408/503 仍保留原请求体和键。
- `npm run check` 退出 0；Web 63 文件、375 测试通过。Turbo 类型检查 31/31（28 缓存），测试 31/31（29 缓存），构建 18/18（17 缓存）。日志 `/private/tmp/s2-rework-check.log`、`/private/tmp/s2-rework-focused.log`；没有重跑历史 Worker/Temporal 长流程。
- 更新后的独立 HTTP/PG 夹具用 UTF-8 JSON 提交 7000 个中文字符，实际返回 413，并直接验证夹具数据库中对应任务为零；未改 Server 字节限制。沿用前文 probe 命令即可复验，结果包含 413。
- 实际 Chrome 在 `http://127.0.0.1:58453/#/tasks` 提交 7000 个中文字符后看到“请求内容过大”；在同一 textarea 改为 `S2 返工：413 后缩短正文再次提交。` 后成功创建 `efc5f740-3020-4b37-b440-84ab3b62972e`，revision 1 / queued，无需刷新。一个浏览器 locator 辅助查询先返回 `isEnabled: false`、随后超时；重新读取原生可访问性树显示可编辑，实际编辑/提交及截图确认恢复成功，不需要产品改动来绕过工具结果。
- 被测构建 `index-9HCSInIO.js`，SHA-256 `0aa247677df8c23284e9bc2eae42450b7ed7ba59a2f565f81321c99166e6fc80`；`WorkTasksScreen.tsx` SHA-256 `25397d5a212391741101899b89dc0d0474e929a53aec0b565e53829b3d1d7fcb`。最终控制台错误/警告样本为空。offline 竞态顺序由组件模拟回归确定验证，不假称新增真实网络故障注入。临时服务及容器已清理。
- 原剩余范围与原生 Desktop 限制不变；这是待独立验收的新候选。

## 独立验收与主线整合

独立审查先在 `0a9fc21` 复现两项失败，再接受 `dfa40d40`：原32项通过，另以内存方式追加
迟到读取、413 以及离线时在途创建／取消的4项反例，全部通过，未改交稿工作树。失败未关闭前
没有整合初稿。最终整合为 `ef1e254`＋`a61153e`，与 S3 `76667ea`、离线 S5 `ace87c8` 并存；
补写本证据前，S2 全14文件与被审候选字节一致且无主线路径重叠；S3 冻结的14份代码／测试
哈希保持不变。

组合代码 `a61153e` 的 `npm run check` 实际退出0，缓存情况：typecheck 28/31 cached, test 29/31 cached, build 17/18 cached。
Web375项为实际执行；缓存的其他平台测试输出不算新执行，原环境跳过仍是跳过。日志：
`/private/tmp/openbot-parallel-integrated-check-20260924-01.log`。

随后主线实际执行 `apps/server-python/.venv/bin/python -B apps/web/src/test/work-http-probe.py`，
新建临时 PG/HTTP，登录／Bot／创建／读取／取消／精确重试／401/403/409/413/422／OpenAPI／退出
通过且退出0。超大请求未创建任务，夹具已清理。日志：
`/private/tmp/openbot-parallel-integrated-http-20260924-01.log`。相关输入未变，复用 S3 长恢复证据。

S5 整合8文件与 `df1c24d` 一致，主线15项新增测试实际通过，记录位于
`/private/tmp/openbot-integrated-s5-20260924-01.log`，仍仅接受离线范围。没有导入 S4 代码，
其单独候选仅验证挂载拒绝，不证明 Linux/runsc 隔离。本轮是局部交付，不表示各阶段完成或发布。
