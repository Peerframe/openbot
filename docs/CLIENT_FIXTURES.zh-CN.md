# 共享客户端故障夹具

[English](CLIENT_FIXTURES.md)

使用官方 Web/Desktop 共用的 `ChannelWorkspace`、`ContextRail` / `ApprovalCard`、`RunInspector`、`Sidebar` 和产物组件，加载公开合成数据。这是贡献者开发入口，不需要 Server、私人 `.env`、账户、数据库或付费模型。场景按钮驱动页内内存传输，不执行真实外部动作。

## 从全新检出启动

使用根 `package.json` 指定的 Node/npm 版本。在仓库根目录运行：

```sh
npm ci --ignore-scripts
npx turbo run build --filter=@openbot/web^...
npm run dev:fixtures --workspace @openbot/web
```

打开 **http://127.0.0.1:5182/client-fixtures.html**。默认场景为 `approval`；可以用 `client-fixtures.html?scenario=reconnect` 等明确地址重现场景。选择器和 **重置场景** 会重置完整合成任务。未知场景会被拒绝。

该命令构建并预览独立入口。修改共享组件后，在另一终端执行 `npm run build:fixtures --workspace @openbot/web`，再刷新页面。此入口没有 HMR：构建预览保留 `connect-src 'none'`，不加载 Vite 开发 WebSocket 客户端。默认端口固定，避免自动切换后误开另一服务；需要时明确添加 `-- --port 5183`。

## 验证官方组件

| 场景 | 操作 | 预期结果 |
| --- | --- | --- |
| `approval` | 在正式审批卡中点击 **提交这张表单** 或 **拒绝** | 审批卡消失。批准后收到最终消息；拒绝后任务为已取消。重置后可尝试另一种决定。 |
| `tool-fault` | **触发工具故障**，再点 **任务详情** | 正式详情解释失败，并展示合成超时进度记录。 |
| `cancellation` | 点击正式 **停止任务**，再点 **注入迟到输出** | 任务保持已取消，迟到内容不会出现。 |
| `partial-output` | **下一段（含重复和旧事件）**，再点 **完成回复** | 重复/旧事件不会让较长内容倒退；完成后最终消息替代部分输出。 |
| `artifacts` | 点击最终消息中的报告 | 正式产物链接通过本地 Blob 下载固定、公开的合成 Markdown 报告。 |
| `reconnect` | **断开事件流** → **离线期间完成** → **恢复连接** | 正式频道连接状态显示正在重连；离线期间不出现最终消息，随后由现有 2 秒重试和 API 补读恢复。 |

窄屏通过 **频道**、**审批与状态**、**侧栏** 切换到相同组件。夹具仅模拟审批和取消写入；新消息、重新提交、账户、设置、模型和插件操作不在此入口中提供，其请求不会回退到真实 Server。

## 验证和构建

```sh
npm run typecheck --workspace @openbot/web
npm exec --workspace @openbot/web -- vitest run src/client-fixtures src/demo --maxWorkers=2
npm run build:fixtures --workspace @openbot/web
npm exec --workspace @openbot/web -- vite preview --config vite.fixtures.config.ts
```

预览仍使用 5182 端口下的明确地址。独立构建输出为 `apps/web/dist-client-fixtures/`，已被 Git 忽略。正常 Web/Desktop 构建保留原入口，不包含夹具。新增组件测试也在正常 Web 测试和根 `npm run check` 中运行。

适配器在现有网站演示的 origin、method 和 body 校验之后扩展。页面在导入正式 UI 前安装适配器，存储仅在当前文档内存中。未知接口被拒绝；CSP 禁止网络连接、框架和 Worker，摄像头、麦克风及位置能力被禁用。预览服务仅监听 loopback，没有 API 代理。不要把夹具导入生产 `main.tsx`、`App`、认证或 Desktop bridge。

## 证据与限制

夹具验证的是已知合成状态下的客户端行为，包括断线漏事件的恢复；它不验证真实 Server 授权、真实工具/模型、Electron IPC/打包、原生权限或真实网络故障。ContextRail 使用合成工作区状态；频道连接标记与重连补读使用正式 API 订阅器。审批有效期标签使用本地显示时钟，其余场景推进均为显式操作。

依赖固定版本、隔离决策和浏览器/测试证据见[研究记录](research/shared-client-fixtures.zh-CN.md)。没有新增依赖。
