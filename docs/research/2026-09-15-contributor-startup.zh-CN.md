# 研究：可复现的贡献者首次启动

- 状态：已接受，进入实现
- 日期：2026-09-15
- 维护人：OpenBot 维护者
- 验收：全新检出执行 `npm ci` 后，直接启动 Server 和 Web、打开页面并登录，不需要预先构建或模型账号。

实现前核对了 [Turborepo `2.10.12` / `53752d452049bdda47698354b16a83d7ce92ced0`](https://github.com/vercel/turborepo/tree/53752d452049bdda47698354b16a83d7ce92ced0) 的发布、MIT 许可、任务运行源码、持久任务与进程退出测试，以及当前公开问题。固定版本的运行文档明确说明 `--parallel` 会忽略任务依赖。仓库已有 `dev.dependsOn: ["^build"]`，但根目录入口绕过了这份声明；复用清单此前也缺少这部分审查。

采用现有 Turbo 的依赖图和筛选能力：`npm run dev` 同时启动 Server 与 Web；`dev:server`、`dev:web`、`dev:node` 分别启动单个应用。Node 仍需明确登记后启动。开发任务透传 `OPENBOT_*` 和 `TAVILY_API_KEY`，保留之前通过环境变量配置 Server/Node 的能力。无需新增依赖或另写构建调度器；npm workspace 命令保留为包内基础入口。

新增的本地代码仅补齐项目自己的启动验收：在没有构建输出和 `.env` 的全新检出中，要求临时数据库名以 `_dev_smoke` 结尾、地址为回环地址且开发端口空闲，使用随机测试密码与临时存储启动真实入口，验证健康检查、Web 页面、代理登录及带会话的 API。结束时停止进程组并删除本次临时存储，不自动删数据库或已有构建产物。CI 提供并销毁独立 PostgreSQL 服务。

未复制或实质改编上游源码。完整检索、候选比较与精确源码位置见[英文记录](2026-09-15-contributor-startup.md)。`npm run dev:smoke` 必须在 `npm ci` 之后、任何构建之前运行，数据库由 `OPENBOT_DEV_SMOKE_DATABASE_URL` 指定。该进程组脚本仅用于 Linux/macOS；HTTP 启动验收不代表真实浏览器界面、桌面端、模型调用、Worker 或 Windows 进程生命周期已验证。常规仓库检查另行运行。
