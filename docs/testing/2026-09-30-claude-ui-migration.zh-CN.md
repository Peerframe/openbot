# Claude 界面草稿迁移 — 2026-09-30

[English](2026-09-30-claude-ui-migration.md)

## 当前交接

分支：`codex/claude-ui-integration-20260930`。基线是当前 `origin/main` 的
`5e5d6ac`，原草稿则基于 9 月 8 日的 `9cc73c9`。原始未提交草稿保留在原工作目录，
不作为集成入口。请在本分支继续修改并推送到同名分支；不要用旧组件覆盖当前实现，也不要
把草稿里的旧仓库规则覆盖到当前规则。

本次迁移合并频道与 Bot 导航列表，增加已知成员头像及 Bot 角色搜索，支持 Escape 清空
搜索，并通过现有样式文件应用草稿的中性表面及主按钮。消息气泡和输入框复用当前实现。
`@` 选择按光标位置识别，保留后面的正文，在受控输入提交后恢复光标，接收者继续使用已有的
结构化命令。现有设置、插件、任务监督、附件、所有人及多接收者、移动导航、回复与消息操作、
Server 权限边界均保留。

范围仅限第一批草稿。设置与档案后续改版、置顶、未读、隐藏和重命名不属于本次交付。
没有改动依赖、权限、持久化结构、后端或 Electron 桥接。复用依据为
`docs/OPEN_SOURCE_REUSE.md` 中现有桌面频道、导航和会话记录；没有复制上游源码。
保留当前原生 disclosure 生命周期，没有引入草稿中的第二套弹层 hook。

## 实际执行的验证

- 在独立的最新基线目录执行锁定版本的 `npm ci`，通过。
- mention、Sidebar、ChannelWorkspace 和 ApprovalCard 定向检查：30 项测试通过。
- `npm run check`：退出码 0。Web：72 个文件、529 项测试通过。Desktop：44 个文件、
  514 项通过、3 项既有平台或环境跳过。未受影响的 Turbo 任务复用缓存；修改过的 Web
  测试与构建实际执行。仓库既有 lint/style 和 Vite 体积、配置提示仍如实记录，不视为错误
  或新增平台验收。
- `npm run build:demo --workspace @openbot/web`：退出码 0，执行于最后的光标细化之前；
  最终生产 Web 与 Desktop 构建在完整检查中执行。
- 在 `http://127.0.0.1:5180/` 验证实际生产 App，使用独立 Chrome 与合成 API 夹具，
  视口为 1440×900 和 390×844。页面身份、非空渲染、无框架错误遮罩、无应用控制台错误、
  无页面横向溢出均通过。桌面检查角色搜索、Escape 清空、已知成员头像、菜单键盘与焦点、
  设置入口；窄屏检查现有移动端频道和审批导航。两个视口都验证正文中间的 `@` 选择，
  并核对捕获请求保留正文及正确接收者 ID。截图与夹具脚本留在仓库之外。
- 开发模式既有的 meta-CSP `frame-ancestors` 提示单独记录。

浏览器 API 与 EventSource 夹具替代了本次界面检查的后端，不证明真实 Python、Temporal、
模型执行、付费 Provider、打包安装或更多平台支持。本次保留已安装的 alpha.9 应用，未升级安装。

## 续作 — 已确认设计的剩余部分

本分支在 `0df5c33` 之后的提交：`ca6aaaf`、`4827c34`、`694d0ad`、`2cba593` 及本记录。范围仍限于
`apps/web`；没有改动依赖、Server 路由、持久化结构、权限或 Electron 桥接，也没有复制上游源码。

- 右侧栏与审批卡片改为中性分组卡片，正文 12–14px。需要注意的状态用彩色标签和胶囊按钮表达；
  破坏性或提权审批的主按钮保持红色。
- 侧栏底部把账户头像（沿用现有账户菜单）和插件胶囊放在同一行，Owner 名称移入头像的无障碍标签。
- 插件/技能、Desktop 设置和 Bot 档案去掉 macOS 蓝色强调，改用黑色主按钮、胶囊分页/筛选和共用的灰色
  卡片；焦点环保留 `--blue`。
- 侧栏右键菜单（右键、Shift+F10 或菜单键）：打开档案、置顶、移至分组（可就地新建）、标为未读、从侧栏
  隐藏。分组按段显示，可重命名或解散；搜索会匹配分组名，也能找到已隐藏的对话。右键不再直接打开档案，
  档案是菜单第一项。
- 排列状态保存在 `sidebar-organization.ts`，使用本机 `localStorage` 键
  `openbot.sidebar-organization.v1`，与工作区偏好相同的有界白名单解析。它只影响显示，不授予权限、
  不重命名、不删除。未读是手动标记，打开该对话时清除；自动未读计数需要 Server 的已读状态，不在本次声明
  范围内。
- 在词首输入 `/` 会列出当前唯一 @ 接收者已审核的技能（通过现有草稿技能列表附加），以及现有的添加附件、
  频道文件操作。路径和 URL 不会触发；候选技能不显示。

未交付：重命名或删除频道与 Bot（Server 没有对应路由，需要契约与持久化变更）；没有 Server 数据支撑的
设置分区（审批策略编辑、审计查看、通知及设计稿中的例行任务页）；非 Desktop 的 Web 入口仍打开模型表单，
尚无分区设置页。

### 续作验证

- 定向 Vitest：Sidebar、侧栏排列、slash 解析、ChannelWorkspace（含新增 `/` 菜单用例）、
  ChannelWorkspace 集成、mention 解析、App 工作区状态/导航、ContextRail、ApprovalCard、
  EmployeeProfileView、SkillLibraryScreen、DesktopSettingsScreen、ModelSettingsScreen、
  PluginManagerPanel 全部通过；Web typecheck 通过。与基线版本相比，改动文件没有新增 Biome 警告。
- `npm run check`：在提交 `2cba593` 上退出码 0。Web：74 个文件、546 项测试通过。Desktop：44 个文件、
  514 项通过、3 项既有平台或环境跳过。Node：129 项通过、3 项跳过。Turbo 复用 12 个缓存任务；改动过的
  Web 测试与构建实际执行。
- 通过 Vite 开发服务器渲染真实 App，`OPENBOT_DEV_API_URL` 指向仓库外的一次性回环合成 API，视口
  1440×900 与 390×844：右侧栏与底部、账户菜单、插件页、Bot 档案、右键新建分组、置顶、手动未读、按分组名
  搜索、有/无接收者时的 `/` 菜单（附加技能标签、移除命令文本、Escape 关闭）、移动端审批面板，且页面无横向
  溢出。

合成 API 不能证明 Python/Temporal 执行、真实模型、Desktop 打包行为或更多平台支持。

## 续作 — 身份生命周期、未读与设置

本段补上前一记录中缺少的 Server 契约，见 [ADR-0047](../decisions/0047-identity-lifecycle-and-read-state.md)。
Owner 选择“永久删除并弹出确认、删除内容但保留审计墓碑”，审批策略页只读展示。

- 迁移 `0045_identity_lifecycle` 为 `bots` 和 `channels` 增加 `deleted_at` 墓碑，名称唯一性只作用于
  现存行，并新增 `channel_read_states`；已有频道在迁移时视为已读。
- Python 路由：`PATCH`/`DELETE /api/v1/channels/:id`、`PATCH`/`DELETE /api/v1/bots/:id`、
  `POST /api/v1/channels/:id/read`、`GET /api/v1/channels/unread` 和 `GET /api/v1/audit`。重命名和删除
  在同一个 Owner 事务中写入审计事件。有进行中的任务时拒绝删除；删除未被引用的消息，被 Work 引用的消息
  替换为占位内容，移除成员、自动任务、学习记录，Bot 的插件授权在墓碑提交后移除。工作区、列表、消息/任务
  读取、成员、单独对话、档案、任务提交、自动任务、附件、模型选择、浏览器和插件授权入口都排除墓碑。
- Zod `renameBotInputSchema`/`renameChannelInputSchema` 与 Pydantic 模型一致，并加入身份差分用例。
- Web：侧栏菜单新增“重命名…”（就地编辑，Server 错误就地显示）和“删除频道…/删除 Bot…”，确认框写明
  对象和删除范围。Server 未读数显示为角标，打开频道即标为已读。设置新增“审批与权限”（依据插件、受控
  浏览器、原生 Agent 和技能文档的只读说明）与“审计记录”（分页、白名单字段）。非 Desktop 的 Web 入口
  现在打开同一套分区设置，隐藏仅限 Desktop 的连接与材质项，手机上分区列表改为顶部横排。顺带修复本分支
  早先的两个问题：频道行的尾部标记会换行；设置开关的黑色覆盖因优先级不足没有生效。
- `.claude/launch.json` 记录渲染检查用的 Web 开发服务器入口。

未交付：通知设置页（Desktop 和 Server 都没有可配置的通知能力）；审批策略编辑（按 Owner 选择只读）。
已删除频道的附件文件仍在磁盘上但无法访问，物理清理属于单独的保留策略任务。

### 生命周期验证

- `apps/server-python/scripts/check.sh -q`：1344 通过，477 跳过（无夹具时数据库用例跳过）。
- `node scripts/test-python-control.mjs`（自有的一次性 PostgreSQL 容器）：871 通过、2 跳过，包括新增的
  7 个 `test_identity_lifecycle.py` 用例（重名与审计、单独对话拒绝、进行中任务拒绝、内容删除与 Work
  引用消息占位、墓碑排除、未读上限与游标、审计白名单与分页、HTTP Origin 与 404）以及新的插件授权用例。
  Worker/Temporal 检查未运行（未设置 `OPENBOT_TEMPORAL_TEST_PYTHON`）。
- `compare-identity-inputs.ts`：Zod 与 Python 在 149 个用例上一致。
- Web：新增侧栏身份操作、设置分区和 Web 设置测试；完整 Vitest 见下方 `npm run check`。
- `npm run check`：在本段提交前 exit 0。Web：76 个文件 / 554 个测试通过。Desktop：44 个文件 / 514 通过、3 个既有跳过。
  Node：129 通过、3 跳过。Protocol 430 通过。Turbo 复用了未变更任务的缓存，变更的包实际执行。
- 通过一次性回环合成 API 在 1440×900 和 390×844 渲染真实 App：未读角标、重命名成功与就地冲突提示、
  有进行中任务时拒绝删除、成功删除 Bot 后其行和频道头像消失、打开即已读、Web 设置分区、审批策略、
  带墓碑标记的审计列表、黑色开关，手机宽度无横向溢出。

## 续作 — 通知与已删除频道的文件

补完生命周期一节留下的两项。

- 删除频道（或 Bot 的单独对话）后，墓碑提交后会在附件锁下、并在再次确认墓碑的事务中删除其附件文件；
  响应中返回 `attachmentsRemoved`（已更新 ADR-0047）。
- 设置 → 通知：可按设备选择开启系统通知，在 OpenBot 处于后台时提醒新的待批准操作和 Bot 新回复
  （[ADR-0048](../decisions/0048-owner-system-notifications.md)）。Desktop 通过新的可信主框架桥接调用
  Electron 主进程 `Notification`，输入仅为有界的 `{title, body}`，渲染进程权限仍全部拒绝；Web 入口在开关
  触发的授权提示后使用浏览器 Notifications API。通知只包含 Bot、频道名称和数量，点击打开对应频道，首次
  快照不会补发积压。当前打开的频道现在只在窗口处于前台时自动标为已读，回到窗口时再标记，因此后台收到的
  回复仍能提醒。
- 修复生命周期 Web 提交引入的一条 Biome 警告（逗号运算符）。

未声明：任何平台上已打包或已签名 Desktop 的实际显示效果（未签名的 macOS 版本会返回 `failed`），以及
OpenBot 关闭时的推送。

### 通知与清理验证

- `node scripts/test-python-control.mjs`（一次性 PostgreSQL）：873 通过、2 跳过；HTTP 生命周期用例上传真实
  文件，证明已删除频道和单独对话的文件被删除、现存频道的文件保留，且清理拒绝作用于现存频道。
- Desktop：通知器与 preload 测试（边界、不支持、仅点击聚焦、失败、过期、最多四个待处理）。Web：跟踪与
  投递测试（首次基线、不含审批详情、按频道节流、浏览器授权与 Desktop 桥接路径）和通知设置测试。
- `npm run check`：本次提交前 exit 0。Web 77 个文件 / 559 个测试；Desktop 45 个文件 / 520 通过、3 个既有跳过；
  Node 129 通过、3 跳过；Protocol 430 通过。
- 通过一次性回环合成 API 渲染设置页：通知分区；浏览器面板拒绝通知时，开关和测试按钮均为禁用并显示原因。
