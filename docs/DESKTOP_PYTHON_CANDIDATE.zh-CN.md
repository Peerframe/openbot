# Desktop Python product 开发候选

这个显式选择的 macOS arm64 Preview 包使用可迁移的 CPython 启动现有 Python product API，保留 Desktop 的 PostgreSQL 管理、加密引导配置、Owner 登录和本地数据布局。默认打包与发布流程保持原来的后端选择。

这是未签名的开发候选。已用一次性合成数据验证 Python API 和包内运行时生命周期。此前 canonical41／61依赖的 Preview 还通过了真实系统解密、跨进程恢复、Owner 就绪界面、正常菜单退出／重启后合成频道保留，以及最终 API／PG 关闭。[原生证据](../experiments/work-journey/evidence/desktop-native-keychain.json)记录实际范围；界面自动化使用 `--force-renderer-accessibility=complete`，未修改包内容。此前canonical43／63依赖候选还通过了包内真实mTLS Worker两次连接及生命周期检查，原始源码证据保留。最新1978bcb候选已完成全新63项依赖构建、暂存与包内API／重启／清理实测，并核对159个Python源码模块、生命周期脚本和锁文件。ASAR／控制器哈希与前包一致，产品Python变更是`serve.py`和模型连接校验。[更新证据](../experiments/work-journey/evidence/desktop-preview-refresh.json)明确区分本次检查与之前的mTLS、原生GUI证据。正式签名、新产物GUI／Keychain复验、新包mTLS连接及完整模型执行仍属独立门槛。

## 从仓库重现

需要 macOS arm64、仓库要求的 Node/npm 和 Xcode Command Line Tools（`xcrun clang`）。无需系统 Python、维护者虚拟环境、Docker、付费模型账户或现成数据库。构建时需要访问公开 GitHub、nodejs.org 和 PyPI；建议为资源、应用包和临时副本预留约 3 GB 空间，不会使用付费服务。

应用本改动后，在仓库根目录执行：

```sh
npm ci
npx turbo run build --filter=@openbot/desktop... --filter=@openbot/db...
node apps/desktop/scripts/prepare-native-server.mjs --python-product
node apps/desktop/scripts/smoke-python-product.mjs apps/desktop/out/python-product-runtime
node apps/desktop/scripts/package.mjs --preview --python-product
node apps/desktop/scripts/smoke-python-product.mjs 'apps/desktop/out/python-product/OpenBot Preview-darwin-arm64/OpenBot Preview.app/Contents/Resources/native-runtime'
```

暂存资源位于 `apps/desktop/out/python-product-runtime`，未安装应用位于 `apps/desktop/out/python-product/OpenBot Preview-darwin-arm64/OpenBot Preview.app`；两者都在已有生成目录排除规则内。不带参数的资源准备与既有发布命令不变。候选要求同时指定 `--preview --python-product`，拒绝正式签名配置和正式 Worker companion。`scripts/prepare-desktop-release.mjs` 未改动，也不会收集这个本地候选。

开发者之后可以打开这个尚未安装的 Preview 应用，进入既有本地 Server 设置流程。这会使用 Preview 应用自己的用户目录，和一次性 smoke 不同；不要让两个 Server 同时写同一个目录。固定资源 manifest 只选择包内后端，不支持通过环境变量提供任意解释器或命令。

## 固定依赖和数据兼容

构建器对 CPython 3.12.13（`python-build-standalone` `20260807`）与 Node 24.21.0 归档校验固定 SHA256，保留上游许可证，将现有 `requirements-worker.lock` 的 63 项精确依赖安装到独立 Python 中，并运行环境校验与 `pip check`，最后才写启用 manifest。资源只包含 Python product/runtime 源码、既有 PostgreSQL migrator 和文档解析依赖闭包，不携带或启动 TypeScript 业务 Server。构建会下载代码，不会启动服务。

启动环境从 Desktop main 的既有引导配置和显式 Desktop 搜索配置生成，不继承终端中的通用凭据或引擎配置。密钥只通过子进程环境传递，不进入命令参数。`python -I -B` 启动固定生命周期入口；Server 仅监听 `127.0.0.1`。有界 `/health` 必须返回 `python-product-candidate`，随后原有 Owner 登录成功才算就绪。

设 `D` 为既有 `<userData>/openbot/local-server`：

| 原有输入或状态 | Python 映射 |
| --- | --- |
| App 自管 PG、引导数据库密码 | `OPENBOT_CONTROL_DATABASE_URL`；继续使用 `D/postgres`，不转换为 SQLite |
| 引导 Owner 密码 | `OPENBOT_CONTROL_OWNER_PASSWORD` |
| 回环端口、精确 origin | `OPENBOT_CONTROL_PORT`、`OPENBOT_CONTROL_ALLOWED_ORIGINS`、`OPENBOT_CONTROL_COOKIE_MODE=loopback` |
| `D/model-settings.json`、原 safeStorage 解密的 model key | 成对传入 `OPENBOT_CONTROL_MODEL_SETTINGS_PATH` 和 `OPENBOT_CONTROL_MODEL_ENCRYPTION_KEY`，不使用 `MODEL_DIRECTORY` |
| `D/objects/attachments` | 原附件布局；`OPENBOT_CONTROL_OBJECT_ROOT=D/objects` |
| `D/objects/plugins/state.json` | `OPENBOT_CONTROL_PLUGIN_STORE_PATH` |
| 显式逗号分隔的 `OPENBOT_PLUGIN_LOCAL_ENDPOINTS` | 按原数量和长度边界转成 JSON 传入 `OPENBOT_CONTROL_PLUGIN_LOCAL_ENDPOINTS`，Python 继续执行 endpoint 和 Owner 权限判断 |
| `D/objects/work-artifacts` | `OPENBOT_CONTROL_ARTIFACT_ROOT` 指向控制层持有的私有不可变文件 |
| `D/model-connections.key` | `OPENBOT_CONTROL_MODEL_CONNECTION_KEY_PATH`；只有 Python SQL 规则允许时才创建缺失的 32 字节私有 key |
| Owner 可选创建的 `D/temporal.json` | 固定映射为 `OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH`；缺失时仅启动 API，存在时必须是当前用户私有普通文件，并通过 Python mTLS 配置校验 |
| 显式传给 Desktop 进程的 `OPENBOT_DESKTOP_TAVILY_API_KEY` | 原启动器将其映射为 `TAVILY_API_KEY`，供 Python Work 网页搜索适配器使用；通用终端 `TAVILY_API_KEY` 会被忽略 |
| 包内 Node、parser 依赖 | `OPENBOT_CONTROL_NODE_EXECUTABLE`、`OPENBOT_CONTROL_NODE_MODULE_ROOT` |

启动器仅创建缺失的私有对象子目录，并拒绝符号链接、非规范路径、错误 owner 或开放权限；不会放宽权限或替换已有文件。PostgreSQL 继续作为产品数据权威。本候选不创建 SQLite Runtime 状态库、Temporal 服务或 sandbox。模型凭据及推理仍由 Python product 的显式 Owner 设置控制。按下述方式启用现有 Work runtime 后，公共网页工具支持原 Desktop Tavily 显式配置；没有 Tavily key 时，仅当前选中模型符合已审阅的官方 Kimi 条件才提供搜索，其他配置保留公共 HTTPS 读取。打包这些适配器本身不会启动引擎或调用模型。

## 显式连接已有 Temporal 服务

缺少 `D/temporal.json` 时仅启动 API：包内虽然包含 Worker 依赖，却不会启动产品 Temporal
Worker 或 Work 入场服务。要启用现有 Work 执行路径，需事先准备可访问的 **已有 mTLS Temporal
服务**、namespace，以及 Owner 控制的 TLS 文件。本候选不会创建或内嵌另一套 Temporal 引擎。

在本地 Server 停止时，将配置写入固定的 `D/temporal.json`。它必须是当前用户拥有的普通文件，
禁止 group/world 权限（例如使用0600），大小为1–16384字节；符号链接、目录、空文件、超限文件及
开放权限文件都会被拒绝。启动器只接受既有私有、规范 app 数据目录下的这个固定文件。
Renderer 输入、`OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH`、`OPENBOT_DESKTOP_TEMPORAL_CONFIG_PATH`
及通用 Temporal 环境变量均不能选择其他路径。启动器不会替用户复制凭据或生成这个文件。

既有 Python 配置格式如下：

```json
{
  "temporal_address": "temporal.example.test:7233",
  "namespace": "openbot",
  "queue": "openbot-product",
  "tls": {
    "ca": "/absolute/owner-controlled/ca.pem",
    "certificate": "/absolute/owner-controlled/client.pem",
    "key": "/absolute/private/client-key.pem",
    "server_name": "temporal.example.test"
  }
}
```

这些只是占位符，不是可用的服务地址或凭据。Python 使用 `O_NOFOLLOW` 重新打开配置，核对真实文件
描述符，按严格 schema 校验，并读取 Owner 控制的 CA、客户端证书和私钥。连接必须使用 mTLS 并核对
配置的服务端身份，不降级为明文。该文件不能覆盖 Desktop 数据库、模型选择、解释器或模块。
原有可选有界字段为 `limit`、`execution_timeout_seconds`、`item_timeout_seconds` 和
`interval_seconds`，边界由 Python 服务校验。

配置存在但无效，或服务不可用时，本地 Server 启动失败，不会悄悄退回 API-only。有效连接启用原有
ProductWorkService、SDK Worker 和 Work 入场路径；模型及工具权限仍来自当前 Owner 配置和 Work
Actions，不因此宣称任何 Worker Host 或电脑隔离 profile 已验收。修改或移走配置前先停止本地
Server；配置只在启动时读取，不会持续监听。

正常停止会关闭父管道、等待 Python 退出，再由原控制器停止 PostgreSQL。父进程意外消失也会关闭管道；卡住的 Python 关闭过程有强制退出时限。启动失败会清理 API 和数据库。整个启动过程不使用 shell，预检、迁移和就绪等待均有固定时限。

## 验证和限制

smoke 创建新的临时私有规范目录，启动真实包内 PG 和 CPython，登录 Owner、创建 channel、重启、核对引导配置字节与连接 key 未改变、读取空节点和插件列表并停止。测试会杀死一次性启动父进程，验证真实 API 在管道 EOF 后退出；符号链接 artifact 目录必须使启动失败并释放 PG。所有合成夹具和子进程最终清理。测试只用合成 base64 加密，不冒充原生 Keychain 验证。

同一 smoke 已在构建出的 `.app` 资源目录中执行，证明不依赖宿主 venv 的迁移运行。默认 smoke 没有启动 Electron 界面，也没有验证原生 safeStorage、签名、公证、系统权限弹窗、安装器、Linux/Windows 包、模型传输或真实 mTLS Temporal 执行路径。另一个[包内连接探针](../experiments/work-journey/desktop-temporal/README.zh-CN.md)已于2026-09-25连接专用 mTLS／PostgreSQL Temporal 服务通过：两次启动都观察到同一新 Worker 的 Workflow／Activity poller，正常退出、重启保留数据、父进程 EOF 以及无效配置／不安全目录拒绝均通过。包内控制器与启动器字节和编译产物一致。这证明真实包内 Worker 的连接和生命周期；模型执行与历史重放由独立产品流程验收，不归入包内探针。无凭据的[公开结果](../experiments/work-journey/evidence/desktop-packaged-temporal.json)已入库。现有 Python 功能边界仍然有效；正式发布需分别完成这些产品路径的验收，并为所有嵌套原生运行时制定经过审阅的签名、公证方案。

精确上游版本、来源、许可证和复用决策见 [研究记录](research/desktop-python-product.md)。
