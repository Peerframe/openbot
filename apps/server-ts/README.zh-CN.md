# TS 控制面入口候选

[English](README.md)

已批准的 [ADR-0050](../../docs/decisions/0050-typescript-control-plane.zh-CN.md) P2 增加一个公开
HTTP/Worker 入口，目标固定为私有 Python 服务。Python 是 121 个 HTTP 操作及后台服务的默认所有者，
只有明确选择且完成验收的 P3 组才转移相应接口。已安装桌面仍用 Python 基线；P5 删除临时转发。

按 [CONTRIBUTING](../../CONTRIBUTING.zh-CN.md) 准备锁定的 npm 依赖与 Python Worker 环境，在仓库根目录运行：

```sh
npm exec -- turbo run build --filter=@openbot/server-ts
npm run test --workspace @openbot/server-ts
npm run contracts:http:ts
npm run contracts:http:ts -- --suite publisher
npm run contracts:http:ts -- --suite models
npm run contracts:http:tls
npm run contracts:http:tls -- --suite publisher
npm run contracts:http:tls -- --suite models
```

同一个夹具启动两个进程和一份临时 PostgreSQL，不读取 `.env` 或用户数据；publisher/model 变体用临时密钥及
合成传输，不调用真实模型。直接基线用 `contracts:http:python`。HTTP 混合 all 组在同一公开 URL/数据库上执行
mixed→direct→mixed，每次等待旧写入者结束，核对既有 Owner 会话和 Bot 投影。这些检查不替代 Temporal 与原生安装包验收。
HTTPS 组用临时 CA，只让所属 Node 子进程信任它，核对安全 Owner cookie、标准重定向及入口重启，执行同一套
Python/SQL/客户端契约；不更改系统信任或关闭证书验证。HTTPS 入口重启与 HTTP 移除再恢复入口分别验证。

手动组合时，沿用 Python product 的显式数据库和配置，并增加：

```sh
OPENBOT_CONTROL_HOST=127.0.0.1
OPENBOT_CONTROL_PORT=3102
OPENBOT_CONTROL_PROXY_ADDRESS=127.0.0.1
OPENBOT_CONTROL_PUBLIC_ORIGIN=http://127.0.0.1:3101
OPENBOT_CONTROL_ALLOWED_ORIGINS=http://127.0.0.1:3101
OPENBOT_CONTROL_COOKIE_MODE=loopback
```

然后用以下环境启动 `npm run start --workspace @openbot/server-ts`：

```sh
OPENBOT_TS_HOST=127.0.0.1
OPENBOT_TS_PORT=3101
OPENBOT_TS_PYTHON_ORIGIN=http://127.0.0.1:3102
OPENBOT_TS_PUBLIC_ORIGIN=http://127.0.0.1:3101
```

以上是环境配置，不代建凭据或迁移数据。Python 只监听私有 loopback，代理模式拒绝直接请求；两个 origin
必须精确且无路径、凭据或归一化。TS 校验公开 Host，拒绝外部转发/身份头，从直接 socket 生成单跳 RFC7239
`for`。Python 验证该 hop 后继续执行既有登录/注册限流；公开 scheme/Host 固定配置以保留重定向。
Origin、cookie、授权和未知路径/方法的拒绝仍由 Python 执行，已构建网页可继续由 Python 提供。

使用 HTTPS 时，把 Python 的公开 origin 和允许 origin 改成同一个精确 HTTPS URL，设置
`OPENBOT_CONTROL_COOKIE_MODE=secure`，监听地址和代理地址保持私有。TS 使用相同公开 URL 和操作者准备的证书/密钥：

```sh
OPENBOT_TS_HOST=0.0.0.0
OPENBOT_TS_PORT=3101
OPENBOT_TS_PYTHON_ORIGIN=http://127.0.0.1:3102
OPENBOT_TS_PUBLIC_ORIGIN=https://openbot.example:3101
OPENBOT_TS_TLS_CERT_PATH=/absolute/operator/tls/fullchain.pem
OPENBOT_TS_TLS_KEY_PATH=/absolute/operator/tls/server.key
```

HTTPS 必须同时提供两个 TLS 路径；公开监听拒绝明文。路径必须是无符号链接组件的规范绝对路径，文件为当前服务
UID 所有的普通文件且只有一个硬链接。密钥权限必须0600、最多16KiB；证书链禁止组/其他用户写入、最多64KiB，
叶证书在最前。监听前验证叶证书不是 CA、当前有效、匹配私钥和公开主机 SAN；扩展用途有限制时必须允许服务端
认证。启动错误隐藏文件名、PEM 和密钥细节。当前文件策略支持 POSIX，Windows ACL 仍需单独验证。

TLS 在现有 Node/Fastify 入口终止，最低 TLS1.2、握手期限5秒、最多192个 TCP 连接；关闭也会清理未完成的握手。
通过重启入口轮换证书，不增加 ACME 签发服务或隐式可信代理。操作者仍需提供客户端信任的证书链并验收真实部署，
重启期间私有 Python 继续作为唯一写入方。

HTTP 使用 Fastify5.12.5、reply-from12.6.5，保留原始 stream 并关闭重试。最多128 个 HTTP 请求、32 个 Worker
连接；请求/空闲期限45s，Worker 握手5s。SSE 心跳维持连接；握手等待缓冲用64KiB stream 水位，后续双向字节流
使用 Node 背压。取消和关闭清理上游工作，传输失败返回脱敏503，不重复可能已提交的写操作。body 校验与限制
仍由 Python 负责；入口不转换 JSON。许可证见[第三方声明](../../THIRD_PARTY_NOTICES.zh-CN.md)。

独立 macOS arm64 候选只运行一份 PostgreSQL 监督器/迁移器，Python 使用私有端口，TS 使用公开端口。
严格 `ts-control.json` 标记选择组合；错误或不完整的 TS 资源拒绝启动。任一份退出即停止另一份，
Desktop 退出时通过继承的父进程管道停止两份。TS 只接收传输配置，额外 Node 运行时仍须保留。
可以生成并审阅未签名候选，已有安装版无需替换：

```sh
npm exec -- turbo run build --filter=@openbot/desktop --filter=@openbot/server-ts --filter=@openbot/python-node-runtime
node apps/desktop/scripts/prepare-native-server.ts --ts-product
node apps/desktop/scripts/smoke-python-product.ts apps/desktop/out/ts-product-runtime
node apps/desktop/scripts/package.ts --preview --ts-product
node apps/desktop/scripts/smoke-python-product.ts "apps/desktop/out/ts-product/OpenBot TS Preview-darwin-arm64/OpenBot TS Preview.app/Contents/Resources/native-runtime"
```

产物为 `OpenBot TS Preview`，应用身份、配置和输出目录独立。原生 smoke 使用临时 PostgreSQL 和合成加密回调，
核对父进程死亡后的两份 PID、单份崩溃、持久化与退出；它不证明 Keychain、原生 Work 或签名。
上面的记录单独保存实际 Electron/safeStorage 流程证据。

完整桌面资源验证先从干净源码提交，用[既有 C19构建器](../../scripts/build-macos-worker-host-candidate.ts)
生成 macOS Worker辅助程序，再将 `OPENBOT_DESKTOP_MACOS_WORKER_COMPANION`设为其绝对路径，
运行 `node apps/desktop/scripts/package.ts --ts-product`。这个 macOS arm64入口强制要求辅助程序，
保留正式应用身份，输出到 `apps/desktop/out/ts-product/OpenBot-darwin-arm64`。
隔离 Preview仍拒绝生产辅助程序。构建候选不会安装应用或注册 Worker服务。
未签名开发验证须清空签名变量；正式身份共享正常 profile默认值，启动必须指定一次性 profile。
Worker注册、Keychain访问组配置和发行签名仍按既有门槛单独验收。

使用同一暂存资源和已编译 Desktop 启动器测量 API-only 转发开销：

```sh
env -i PATH="$PATH" LANG=en_US.UTF-8 apps/desktop/out/ts-product-runtime/node/bin/node apps/desktop/scripts/measure-ts-product.ts apps/desktop/out/ts-product-runtime > p2-overhead.json
```

这个 macOS arm64 探针拒绝过期 TS 编译输出，创建独占的一次性 profile，三轮交替运行 Python 直连和 TS 转发，
每轮分别首次启动和重启。按 P0 相同等待时间测量原生子进程 RSS，并对 health 与已认证频道读取分别预热10次、
串行测量100次，最后核对全部退出。加密为合成回调，不使用配置的外部传输。这些原始结果是本机 loopback
API 实测；渲染器/Keychain、运行中的 Temporal 和公开网络吞吐仍须单独验证。

上面的记录包含实际同源码 API-only 开销测量。当前仍是本机候选，实际对外 TLS/PKI 部署与托管平台检查仍需
P2 实证；本机证书/传输契约不证明真实部署或 P3 已验收。

## P3 首个读取组

明确选择 `transcription` 的候选仅接管 GET `/api/v1/settings/transcription`，使用现有 PostgreSQL
会话/设置行和严格共享 DTO。PUT、登录/退出、模型解析、审计写入和 Temporal 仍归 Python。
默认保持只转发（`none`）。

设置 `OPENBOT_TS_READ_GROUP=transcription`，`OPENBOT_TS_DATABASE_URL` 与
`OPENBOT_CONTROL_DATABASE_URL` 使用同一自管数据库；`OPENBOT_TS_READ_ALLOWED_ORIGINS` 与
Python 的明确允许来源列表相同，以逗号分隔，默认 TS 公开来源。私有 Python product 设置
`OPENBOT_CONTROL_TS_READ_GROUP=transcription`；对应 GET 明确拒绝，不允许自动回退。反向切换时
两边组开关同时设回 `none`，保留地址、数据库和 cookie 模式，不复制数据或重新签发会话；先停止
旧进程再启动替代进程。完整转写组验收后退役 Python 读取，P5 删除转发。

混合 all/control/resources 与 HTTPS control 夹具实际检查读取、会话撤销/到期、锁/断开、停止 Python
和双向切换，不读取用户数据。每组切换前运行 `npm run ui:acceptance -- --entry ts`，达到 PASS12/12，
未预期响应和页面错误为0。workspace503 须检查原因，不豁免。见
[决策与当前检查点](../../docs/research/typescript-control-plane-p0.zh-CN.md#p3-转写读取决策与安全检查2026-10-07)。

## 主 Bot 保存候选

本候选设置 `OPENBOT_TS_WRITE_GROUP=primary-bot`，继续使用明确的 `OPENBOT_TS_DATABASE_URL`，
并让 `OPENBOT_TS_WRITE_ALLOWED_ORIGINS` 与 Python 的准确来源名单相同（默认 TS 公开来源）。
私有 Python 同时设置 `OPENBOT_CONTROL_TS_WRITE_GROUP=primary-bot`。只有
PUT `/api/v1/workspace/primary-bot` 改变归属，其他方法/接口继续转发。SQL 权限、工作区优先的
版本校验、Bot 存活及审计一起提交，身份生命周期仍在 Python。入口按 Origin→会话→请求体顺序
检查；5秒内最多收集1024字节 UTF-8 JSON，随后在6秒事务内锁定并复查同一会话。不接纳 bearer
替代身份，不访问新凭证，不隐式重试或自动回退。提交回包中断时结果未知，须权威刷新，不能自动重提。

默认写入组 `none`。显式反向切换须先停止两进程，同时把两边写入组设为 `none`，在同一地址、
SQL 和会话恢复服务，不还原旧数据。有界回退窗口保留此前验收发布物。新严格原生标记为
`openbot.desktop.ts-control/v2`，明确包含 `readGroup:transcription` 和 `writeGroup:primary-bot`，
拒绝旧标记或缺失资源；此前独立打包版本保留作回退。

实际混合/HTTPS 契约覆盖主 Bot 失败、并发、过期/撤销、审计回滚、断开后 SQL 清理、Python 停止
及双边反向切换。每次接口归属切换前仍须准确候选的 TS 界面12/12，并验收 staging 和实际未安装包。
见[限定决策](../../docs/research/typescript-control-plane-p0.zh-CN.md#p3-主-bot-选择决策2026-10-08)。

## Owner 身份认证候选

显式 `owner` 组接管 GET session/sessions 和 POST login/logout/password/revoke-others 六个操作。
两端同时设置 `OPENBOT_TS_AUTH_GROUP=owner` 和 `OPENBOT_CONTROL_TS_AUTH_GROUP=owner`。
共用数据库，并将 `OPENBOT_TS_OWNER_PASSWORD` 配为 Python 相同的启动密码；保持 Owner 名称
（`OPENBOT_OWNER_NAME`，默认 Owner）、会话寿命（`OPENBOT_TS_SESSION_TTL_HOURS`，默认12小时，范围1–168）、
允许来源（`OPENBOT_TS_AUTH_ALLOWED_ORIGINS`，默认公开入口）和 Cookie 模式一致。数据库已保存密码优先，
Python CLI 恢复权限保留。被选中的六个 Python 私有路由返回503，其他方法及 OPTIONS 继续转发。

原生 v3 标记在已有读写组之外固定 `authGroup:owner`；仅向 TS 传入现有数据库和 Owner 启动凭据，不传模型密钥。
最多同时执行两个原生异步 KDF、四个 SQL 事务，超量返回503。断连/超时后名额仍保留到实际工作结束。
JSON 限8192字节/5秒，每个 KDF/SQL 操作限6秒；保持 UTF-8 标量/码点长度及固定 scrypt 存储格式，
不保存明文令牌。发会话前重新检查密码版本，审计和会话提交后才返回 Cookie。

反向切换需停止两端进程、同时将认证组设为 `none`，保留相同数据库、地址和 Cookie 模式，不恢复旧凭证或旧会话。
回退窗口内保留上个已验收安装包；整组验收且窗口关闭后才删除 Python 旧路由。真实 SQL HTTP/HTTPS 并发与
反向切换、UI12/12、完整检查及原生暂存/打包均须通过。原生探针在改密重启后显式提交新密码，不代表桌面
旧启动凭据能自动登录。决策和实际结果见[研究记录](../../docs/research/typescript-control-plane-p0.zh-CN.md)。

## 频道读取候选（P3）

本地 `channels` 组只接管 GET Bot 列表、频道列表、频道消息及运行记录。TS 配置
`OPENBOT_TS_CHANNEL_READ_GROUP=channels`，私有 Python 配置
`OPENBOT_CONTROL_TS_CHANNEL_READ_GROUP=channels`，使用其他已选组的同一个显式
`OPENBOT_TS_DATABASE_URL`。默认均为 `none`；未知组或非私有 product 模式的 Python 选择拒绝启动。
可选的 `OPENBOT_TS_READ_ALLOWED_ORIGINS` 沿用现有读取 CORS 策略。

选择后 Python 对这 4 个公开路由拒绝服务，内部读取及身份、消息、Run 写入仍按原有职责运行。
TS 使用有容量上限的只读 READ COMMITTED 事务，返回数据或频道错误前复查 Owner 会话；
保留游标微秒精度、排序及 SQL/JSON 大小上限，无表结构迁移、模型调用或任务调度。
反向切换时停掉两端、都选 `none`，再用同一份较新的数据库重启。保留上一份合格安装包，不能还原旧会话或消息。

v4 macOS arm64 未签名 Preview 标记包含 `channelReadGroup:channels`，启动前校验 3 个编译模块。
契约和界面驱动与既有组一起选择它。真实 HTTP/HTTPS 对照覆盖分页、读取阻塞时撤销、容量、异常及超大记录、
Python 停机可用性和反向切换。当前状态见[迁移检查点](../../docs/research/typescript-control-plane-p0.zh-CN.md#当前迁移检查点2026-10-08)。
