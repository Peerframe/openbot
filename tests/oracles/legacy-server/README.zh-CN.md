# 固定的 TypeScript Server 测试 oracle

这个私有夹具保存 Python 迁移差分测试使用的原实现。它**不是受支持的 Server、运行时回退或第二套产品实现**，不得继续加入产品功能。最终目标是一套 Python 业务 Server 和固定的兼容性测试证据，不是长期维护两套后端。

`snapshot.json` 逐项记录 55 个 TypeScript 文件、4 个合成 PDF/来源样例的原路径、工作区基线 commit、SHA-256 和长度。复制内容保持原始字节，沿用 OpenBot MIT 许可及 LICENSE。`workingTreeSnapshot: true` 表示具体 hash 也记录了已接受但尚未提交的改动，不能仅凭 commit 推断源码。协议、领域类型和数据库包继续使用原来的规范实现，不另复制。

闭包包含类型导入，以便原源码无需重写即可编译、类型检查。旧 App 只由临时测试夹具创建。包内没有 index/start/dev/serve/bin 入口、导出或生产依赖；只有显式 `build:oracle`，依赖均为锁文件已有版本的开发依赖。`filename-reserved-regex@4.0.1` 单独保留嵌套 lock 项，避免依赖旧 Server 的安装位置。没有升级依赖版本。

新检出环境从仓库根目录运行：

```sh
npm ci --ignore-scripts
npm run oracle:build
node apps/server-python/scripts/compare-task-contracts.mjs
node apps/server-python/scripts/compare-runtime-wire.mjs
node apps/server-python/scripts/compare-execution-values.mjs
```

差分程序还需要按现有说明准备 `apps/server-python/.venv`。`oracle:build` 只构建这个夹具与规范的数据库、领域类型、日志、协议、Windows ACL 包，不构建或启动 `@openbot/server`。`oracle:check` 检查固定字节、额外文件、启动脚本，并拒绝产品源码、包元数据、部署或非测试脚本引用 oracle；它是回归门禁，不是系统隔离器。

真实 PostgreSQL 差分仍使用 `npm run test:control:python`，需要现有 Python/Worker 环境和由脚本独占、清理的临时 Docker 数据库；`npm run db:verify` 保持既有合成数据库限制。Python 的模板迁移、插件、知识与附件测试已切换到这个固定路径；S7 使用相同的固定产物读取器，历史、迁移执行器和恢复断言不变。原本直接使用 `packages/protocol` 的测试和历史 model-feature 夹具不变。禁止自动从 apps/server 刷新 oracle；修改兼容性基线必须说明理由并审阅新 hash。

## 尚未关闭的退役门槛

本候选只消除 snapshot.json 所列消费者对旧业务 Server 的**测试依赖**，不授权切换默认后端或删除 apps/server。制作时真实远端产品命令与浏览器验收尚未通过，Owner 权限、原 Action、批准、回执、产物审阅与恢复仍需完成产品门禁。

验收后需要一起处理以下剩余路径：

- 根目录 `dev`/`dev:server`、Desktop 的 `prepare:native` 和 `main.ts` 旧启动分支。显式 Python 候选已有独立 parser/DB 依赖根。
- `deploy/server/Dockerfile` 和 `smoke-python-runtime.mjs` 旧 Python 子进程 smoke。本夹具没有复制其 bootstrap/host/process 三文件；应先用真实产品入口验收替代旧桥接验收，不能为保留 smoke 把 oracle 打进生产镜像。
- `test-runtime-headless.mjs` 和 CI 里的旧 TS 集成测试；在产品侧保留对应回归后再移除，本包没有跳过这些测试。
- publisher-key CLI、MCP 示例生成器的源码位置；把可复用工具和素材移入正确的保留包或测试目录，生产工具不得通过 oracle 继续依赖旧业务实现。
- 最后再移除 apps/server 的启动、源码、dist、workspace 及独有生产依赖，使用项目固定 npm 版本重新安装并完成常规门禁、产品/容器/Desktop 打包、S7 与活动任务成套恢复资格。保留 parser/SDK 许可、测试依赖和规范数据库迁移。

本候选不包含整包删除，也不新增 Linux 或浏览器支持声明。
