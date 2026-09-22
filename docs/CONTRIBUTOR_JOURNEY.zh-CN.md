# 干净检出的贡献者流程

[English](CONTRIBUTOR_JOURNEY.md)

现有 smoke 会从干净检出启动真实 Server/Web 开发命令，检查代理与 Owner 登录，重启后验证保留的 Owner 会话。可选 Node 流程通过生产客户端与文件凭据适配器完成真实注册和重连。全过程不使用模型密钥、已配置的 Provider、已安装应用的个人资料、私人 dotenv 或个人账户。

## 运行

准备干净的 checkout/worktree、`package.json` 支持的 Node、npm、Docker，并确保端口 3001 和 5173 空闲。在 Linux/macOS 上运行：

```sh
npm ci --ignore-scripts
npm run dev:smoke
```

要包含 Node 验证，用下面命令**替换**最后一条命令：

```sh
npm run dev:smoke -- --with-node
```

首次运行可能下载固定的 PostgreSQL 17.11 镜像。驱动创建随机名称、专有所有权标签、随机环回端口、合成凭据和 tmpfs 数据的容器；删除前核对所有权。不停止或重置已有容器。

必须在 `build`、`test`、`check` 之前运行，因为 Turbo 的前置构建本身属于验收内容。发现已有 workspace `dist` 目录，或根目录/Web 目录中的本地 `.env*` 文件（`.env.example` 除外）时，驱动拒绝运行，不会删除它们来让检查通过。完成后保留正常、被 Git 忽略的开发构建和缓存；重复冷启动验收需使用另一份干净检出。此 smoke 验证 HTTP 行为，不代表浏览器渲染或原生平台验收。

## 验证内容

1. 真实 `npm run dev` 构建共享依赖，启动 Server/Web，提供 Vite 页面、Server health 和代理 health。
2. 匿名工作区请求返回 401。合成 Owner 通过代理登录，拿到可访问会话和工作区 API 的 Cookie。
3. 使用 `--with-node` 时，Owner 创建绑定 Node 的一次性注册 token，`npm run dev:node` 通过生产客户端消费它。Server 显示 Node 已注册且在线，没有 Provider 能力；私密身份文件中的注册时间与 Server 一致；重复消费 token 返回 401。
4. 停止 Node 并观察 Server 显示离线。使用相同的私有 fixture 状态重启 Server/Web；原 Owner Cookie 无需再次登录仍然有效。
5. 使用 `--with-node` 时，新 Node 进程只使用保留的身份文件，不携带注册 token 或环境凭据。Server 识别相同的注册身份重新在线，完整身份文件的 SHA-256 摘要保持不变。
6. 驱动仅终止自己的进程组、删除自己的私有临时目录和带所有权标签的数据库容器；中断和失败采用相同清理路径。

此流程不提交任务、不执行 Provider 能力。注册和重连结果不能证明原生 Worker Host 安装、系统钥匙串保护或电脑控制能力。

## 现有 CI 数据库

已有的临时数据库 CI 任务可提供 `OPENBOT_DEV_SMOKE_DATABASE_URL`，替代 Docker 自动创建。该 URL 必须指向单个环回 PostgreSQL 地址、没有参数、数据库名称以 `_dev_smoke` 结尾，并且没有现存应用表。驱动在迁移前检查，不重置非空数据。

显式提供的数据库属于调用方，由调用方销毁其服务。驱动不删除数据库，也不重置生成的 schema 或数据；本次运行的临时凭据、文件和子进程仍会清理。CI 应在 `npm ci` 之后、该任务首次构建之前运行 `npm run dev:smoke -- --with-node`。已经用于 smoke 的数据库不能重复作为空 fixture。

## 失败诊断与定向检查

进度消息指出当前阶段；失败时说明缺失服务或失败的 HTTP/身份条件，并输出有限长度的子进程诊断，移除 fixture 密码、数据库 URL、Cookie 与 Node 凭据。Docker 失败不会打印包含合成密码的命令参数。开发端口被占用时，在创建数据库或启动进程之前失败。

```sh
node --test scripts/smoke-dev-fixture.test.mjs
npm run check
```

Fixture 测试覆盖目标地址、干净检出、子进程环境隔离、日志脱敏、身份文件约束、端口所有权和进程清理；它们不替代真实 smoke。进程组驱动明确仅适用于 Linux/macOS；在单独完成 Windows 原生进程树验证之前，不声明支持 Windows。

固定版本、复用依据和验证边界见[研究记录](research/2026-09-22-contributor-journey.md)。

## 本地验收证据 — 2026-09-22

完整 `--with-node` 流程已在 macOS arm64、Node 26.0.0、npm 11.12.1 和固定 PostgreSQL Docker 镜像下通过，包含默认路径的全部断言与可选 Node 断言。最初七项定向 fixture 测试和 `npm run check` 均通过。在另一份干净 fixture 中，于数据库和开发进程启动后发送 SIGTERM：驱动以非零状态退出并指出失败阶段，未遗留 smoke 私有目录、所有权容器或 3001/5173 监听服务。这是本地证据；该工作包没有修改或单独执行已有 hosted Node 22/npm CI 固定版本。

最终集成复验暴露了 macOS 已退出但未回收进程组的 `EPERM` 竞态。修复只在该错误出现时检查
PID/PGID/UID/状态，不读取命令或环境；仅没有活进程才接受退出，并等待直接子进程退出通知。
活进程或检查失败仍明确失败；并发停止共享清理，失败后 finally 可重试。补充真实 macOS zombie、
权限拒绝后重试、并发停止和父进程退出后存活后代的回归，现有 10 项均通过。在 `88fbce0` 全新导出
副本应用该修复后，完整 Node 注册/停止/Server 重启/身份重连流程再次通过，确认无自有进程、
3001/5173 监听、标记容器或私有目录残留。zombie 回归仅在 macOS 运行，其余新回归同属 POSIX 范围。
