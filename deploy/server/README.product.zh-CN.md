# Python 产品容器候选

此独立候选打包真实 Python 产品 API、构建后的 Web、保留的 PostgreSQL 迁移器和文档解析器，
不依赖待退役的 TypeScript 业务 Server 或测试 oracle。现有 Dockerfile／Compose 默认入口不变。

**2026-09-25 已通过真实 Linux arm64 镜像及独占临时容器验收。** 真实 Owner HTTP、Web、
43 条迁移、DOCX／PDF 提取、空白 OCR 初始化、原附件／密钥／schema 持久化及 SIGTERM 停止／重启均通过。
四项非法启动在创建 schema 前拒绝，测试资源全部清理。[结果与源码哈希](PRODUCT_CONTAINER_RESULT.json)
标识本次确切镜像。该结果来自本地 Docker VM；随后 commit817d46c 的原生 Linux amd64／arm64 CI
也已通过，见[任务级证据](../../docs/research/python-product-container.md#hosted-native-matrix-result)。
同一轮 PR 仍有其他检查失败，不能据此宣称整体通过；配置 Temporal 与部署仍另行验收。

当前浏览器增量将构建和smoke固定为45条迁移。上方43条迁移镜像证据保留原范围；
更新后的镜像需要新的原生CI验收。

`serve.py`的`OPENBOT_CONTROL_HOST`仅接受127.0.0.1或0.0.0.0，默认仍为127.0.0.1；
非法值在数据库、密钥或模型初始化前失败。显式候选镜像选择0.0.0.0，不自动改变Origin、Cookie或代理信任。

在仓库根目录复现：

```sh
docker build -f deploy/server/Dockerfile.product --target runtime-product -t openbot-python-product:candidate .
python3 deploy/server/smoke-product.py --image openbot-python-product:candidate
```

smoke 只创建随机名称的独立 PG／API 容器、内部网络和一个状态卷，并清理这些确切资源。
不选择已有数据库、Docker socket挂载、SSH、付费模型、Temporal引擎或用户数据。
入口检查真实 Owner HTTP、真实 Web、canonical45迁移、Office／PDF提取及空白图像离线OCR初始化，
再检查原附件／密钥／迁移历史持久化和SIGTERM停止／重启。空白OCR仅验证引擎和语言加载，不证明识别质量。
Uvicorn0.53.0关闭完成后会恢复并重新发出SIGTERM，因此接受退出码0或143，不接受强杀137。
缺少Owner密码、无效Origin／Temporal路径和隐藏Python依赖必须在创建迁移schema前失败。
本次记录由该脚本对真实镜像执行产生。

显式使用候选 Compose 时，应选择新的项目和新命名卷；此处不是已有卷原地升级说明。
通过可信运行环境提供`OPENBOT_POSTGRES_PASSWORD`与`OPENBOT_OWNER_PASSWORD`，不要放入构建参数：

```sh
docker compose -p openbot-python-product-candidate -f deploy/server/compose.product.yaml build
docker compose -p openbot-python-product-candidate -f deploy/server/compose.product.yaml up -d
```

Compose只发布127.0.0.1:3001，不发布PG。默认仅允许两个localhost Web Origin与loopback Cookie。
若另行审阅HTTPS部署，须显式配置安全Cookie／Origin；容器监听地址不会自动改变这些策略或代理信任。
Server以UID／GID1000运行，根文件系统只读，临时目录为128MiB私有noexec tmpfs，
持久状态在`/var/lib/openbot`。备份时数据库与状态／密钥必须配套保留。

没有`OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH`时只启动API。若明确启用Work，须先有可用的mTLS
Temporal服务，再通过另选Compose覆盖文件只读挂载配置、证书与密钥，并设置上述变量。
配置及私钥须由UID1000持有且权限0600；配置引用容器内路径。原ProductWorkService验证并启动原Worker。
此包不嵌入引擎，不提供明文回退，也不自动授予command／browser能力；其他可信Control配置仍须明确选择，
不会把凭据放进镜像。

依赖沿用完整63项Worker锁（含pytest／开发辅助包）以及平台过滤前43项Node parser／DB闭包，
不声称Python已经按生产最小化。Node24.21.0／Python3.12.13复用已固定官方Bookworm镜像摘要。
Web／TypeScript构建依赖不进入最终镜像；保留包内许可、Node许可、Python组件通知和THIRD_PARTY_NOTICES。
Python只安装锁定wheel，缺少对应架构wheel时拒绝构建。本地Linux arm64及原生Linux amd64／arm64 CI镜像smoke均已在记录的提交上通过。

不使用Docker或模型的聚焦检查：

```sh
node --test deploy/server/product-container.test.mjs
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=apps/server-python/src:apps/agent-runtime-python/src apps/server-python/.worker-venv/bin/python -m pytest -p no:cacheprovider -q deploy/server/test_product_container.py apps/server-python/tests/test_entry.py
```

见[研究与准确边界](../../docs/research/python-product-container.md)。
