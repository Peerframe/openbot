# 研究：MCP OAuth 账户连接生命周期

- 状态：Proposed；仅研究，未启用 OAuth 产品能力
- 日期：2026-09-23
- 审查基线：集成版本 OpenBot `820d17d`；已安装 MCP SDK `1.30.0`
- 关联工作：P2 账户连接；[既有 MCP 复用记录](../OPEN_SOURCE_REUSE.md#third-party-mcp-tool-plugins)、[插件研究](third-party-mcp-plugins.md)、[兼容性预检](mcp-compatibility-preflight.zh-CN.md)
- 验收流程：已登录 Owner 连接合成的受保护 MCP 服务，为一个 Bot 授予一个工具权限，经过 Server 重启和 token 轮换后仍可使用；随后断开连接，不再发送调用或重放旧操作。
- 安全边界：凭据、身份绑定、授权、revision 和审计属于 Server；获得 OAuth access token 不等于为 Bot 授权。首个交付使用可丢弃的本地服务，不依赖私人账户或付费模型。

## 决策

围绕已安装 MCP SDK 建立预注册客户端的账户生命周期，复用其公开的
`OAuthClientProvider`、发现辅助函数、`auth`、`exchangeAuthorization` 和
`refreshAuthorization`。**后续实现变更**再引入已发布的 `oauth4webapi@3.8.8`，仅使用
`validateAuthResponse`、`revocationRequest` 和 `processRevocationResponse`，补齐 SDK
1.30.0 缺少的客户端回调校验、撤销接口。本次研究不新增依赖。

工具调用通道不接入 `StreamableHTTPClientTransport.authProvider`。Server 在调用前获得可用
token，再通过既有有界、限定目标的传输发送请求。工具收到 401/403 或丢失响应后，不得因刷新
或重新登录而重发。继续使用持久化插件回执记录不确定的调用；重新连接账户不恢复遗留副作用。

最小交付支持：每个插件一个账户连接、单 Server 进程、authorization code + PKCE S256、
预注册客户端、明确的 issuer/resource 配置，以及重启、轮换刷新 token、本地断开和远程撤销
结果。自动 DCR、发布 CIMD、任意 grant type、跨插件共享账户、OIDC 登录、多租户和跨进程刷新
锁另行开发。兼容性报告必须写明这个受限 profile，不能宣称通用 MCP OAuth 全兼容。

## 搜索和固定上游证据

2026-09-23 实际查询 GitHub：`repo:modelcontextprotocol/typescript-sdk oauth`、
`repo:modelcontextprotocol/typescript-sdk is:issue is:open oauth`、
`repo:panva/oauth4webapi is:issue is:open`；官方资料检索覆盖 MCP 授权、issuer 校验、PKCE、
撤销、GitHub remote MCP host integration、Google Drive MCP configuration。已阅读源码、
测试目录、发行记录和许可证。未创建账户、应用或授权；服务文档是注明日期的证据，不是实际
连接成功的证明。

| 候选 | 精确版本与一手证据 | 维护、测试、许可 | 决定 |
| --- | --- | --- | --- |
| MCP 授权规范 | [2025-11-25，`a597fef9805e07a217f45645a830964728276226`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/a597fef9805e07a217f45645a830964728276226/docs/specification/2025-11-25/basic/authorization.mdx) | 仓库 LICENSE 说明规范贡献处于 Apache-2.0/MIT 迁移期，其他文档为 CC-BY-4.0。规范不提供账户存储或已验证的客户端。 | 采用 HTTP 授权角色、发现和 resource 要求，明确首期受限范围。 |
| 已有 MCP SDK | [`1.30.0`，`2d889f2b329e46680ec9bdd565de4616c497825a`](https://github.com/modelcontextprotocol/typescript-sdk/tree/2d889f2b329e46680ec9bdd565de4616c497825a)；[2026-07-27 发布](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.30.0) | MIT。审查 `src/client/auth.ts`、`streamableHttp.ts`、`src/shared/auth.ts`、Server auth router/provider、`test/client/auth.test.ts` 和 `auth-extensions.test.ts`；测试涉及 PKCE、resource、刷新、发现、客户端认证。 | 用于 MCP 和 token 协议操作，外包应用策略；P2 不升级 SDK 大版本。 |
| OAuth 客户端原语 | [`oauth4webapi 3.8.8`，`916b97952dbf431d8b72f369840de54f5a286e4d`](https://github.com/panva/oauth4webapi/tree/916b97952dbf431d8b72f369840de54f5a286e4d)；[2026-09-05 发布](https://github.com/panva/oauth4webapi/releases/tag/v3.8.8) | MIT，Node 20 基线、Web API。审查 `src/index.ts`、`test/revocation.test.ts`、`discovery.test.ts`、`authorization_code.test.ts`、package scripts 和 LICENSE。撤销测试包含无效目标/token、附加参数、状态及错误；发现测试拒绝其他 issuer。查询时开放 issue 为零，不代表没有缺陷。 | 仅补缺失的响应校验和撤销原语，共用有界 custom fetch；不另换整套 MCP auth。 |
| OpenBot 适配层 | `820d17d` 的 `plugin-store.ts`、`plugin-service.ts`、`plugin-transport.ts`、`plugin-routes.ts`、`owner-auth.ts`、`app.ts` | 已有加密原子文件存储、grant/revision 校验、回执、传输约束和 Owner 会话测试；仅单进程序列化。 | 复用已有权威源，补连接状态及生命周期协调，不另造一套权限系统。 |

已查阅：[RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html)（PKCE）、
[RFC 8414 §3.3](https://www.rfc-editor.org/rfc/rfc8414.html#section-3.3)（issuer 校验）、
[RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html)（resource metadata）、
[RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html)（resource indicator）、
[RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html)（授权响应 issuer）、
[RFC 9700 §§4.4、4.14](https://www.rfc-editor.org/rfc/rfc9700.html)（混淆攻击、刷新保护）、
[RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html)（撤销）、
[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html)（原生客户端回调边界）、
[RFC 7591](https://www.rfc-editor.org/rfc/rfc7591.html)（DCR）。这些固定 RFC 遵循 IETF 条款，
本次未复制 RFC 代码或正文。选定 MCP 版本引用的 OAuth 2.1 是 `-13` 草案，不能称为正式 RFC。

开放问题包括 [SDK #2510](https://github.com/modelcontextprotocol/typescript-sdk/issues/2510)
（会话中重新授权无法完成，报告版本为 1.25.3）和
[#2784](https://github.com/modelcontextprotocol/typescript-sdk/issues/2784)（发现回退混淆
resource/issuer 主机）。据此设计回归用例，不断言每个问题都能在 1.30.0 重现。
Server [#2773](https://github.com/modelcontextprotocol/typescript-sdk/issues/2773) 还报告错误
重定向丢失 state；不能为兼容服务而接受无法绑定的错误回调。

## SDK 1.30.0 的实际实现

下表来自源码，不从规范推断实现：

| 公开能力 | 核实的行为 | OpenBot 必须补的边界 |
| --- | --- | --- |
| `OAuthClientProvider` | 应用负责 state、verifier、token、client information 和 discovery 存储。`auth` 接受 code，但不接收回调 state 或 issuer。 | transaction 绑定 Owner 会话、插件 revision、issuer、resource、redirect、client 和审核过的 scopes；交换前校验回调；不同连接和事务不共享 provider 实例。 |
| 发现 | `discoverOAuthServerInfo` 捕获 resource 发现错误后可把 resource origin 当 issuer，且选第一个 AS；AS metadata schema 不比较返回 issuer 和请求 issuer。 | 必须有有效 resource metadata，选择已配置 issuer；校验精确 issuer 和所有 endpoint 后才缓存或发凭据；安全检查失败不得进入旧协议回退。 |
| URL、PKCE schema | `SafeUrlSchema` 拒绝若干危险 scheme，但不是 HTTPS/SSRF 策略。`startAuthorization` 拒绝已公布但不含 S256 的列表，却接受缺少 PKCE 方法字段。 | 要求 HTTPS、明确 S256 能力和 code response type；测试只放行精确、自有 loopback URL。 |
| Resource、scopes | 无 resource metadata 时可能省略 `resource`；默认允许 resource 路径前缀；未给 scopes 时可能使用完整公布列表。 | profile 固定规范 resource，授权、交换、刷新均传递；拒绝 issuer/resource 变化；明确审核 scopes，challenge 只能提出新同意请求，不能自动扩权。 |
| 交换、刷新 | 公开辅助函数发送 form 请求并解析 token；成功刷新未返回新 refresh token 时保留旧值。上层 `auth` 可以清凭据后重试或回退交互授权。 | `auth` 仅启动已校验、预注册且无既有 token 的交互流程；完成时单次 `exchangeAuthorization`；后台直接 `refreshAuthorization`，不开浏览器，不重试结果不确定的轮换。 |
| HTTP transport | 启用 auth 的 `send` 在 401、insufficient-scope 403 后可执行 `auth` 并递归 `send(message)`。 | 副作用通道不设置 `authProvider`；准入前刷新，失败后返回稳定的需重新授权状态。 |
| 撤销 | 客户端 `auth.ts` 没有 revoke 导出；Server 的 `OAuthServerProvider.revokeToken` 和 handler 不是客户端接口。`terminateSession` 的 MCP DELETE 也不是 OAuth 撤销。 | 复用选定的 RFC 7009 客户端原语，或另审服务专用 API；区分本地断开、远端确认和结果未知。 |

已用安装的 1.30.0 公开 API 做只读 Node 探针，`fetchFn` 只返回内存合成 metadata：得到
`mismatchedIssuerAccepted: true`、`plaintextTokenEndpointAccepted: true`、
`missingPkceMetadataAccepted: true`、`clientRevocationExports: []`。没有网络请求或 token
交换。该结果直接证明需要策略校验，不能假定 SDK 已执行完整 profile。

`oauth4webapi.validateAuthResponse` 检查 state、已声明/返回的 `iss`，拒绝它读取的重复参数及
implicit/hybrid 响应。OpenBot 仍须要求恰好一个有界 code 或 error，拒绝重复安全参数，首个
通用 profile 要求 `iss` 支持。库错误可能包含响应参数，只能映射固定诊断码，不能记录原异常。
撤销 custom fetch 本身也不是 SSRF 保护；生产不允许 `skipStateCheck` 或全局不安全请求开关。

## 已有 OpenBot 的接入约束

`plugin-transport.ts` 固定 DNS 结果，拒绝私网和重定向，限制请求/响应大小，并自行提供 bearer
token。它只允许配置的 MCP endpoint，在返回 Response 前拒绝 401/403，且不暴露
`WWW-Authenticate`。简单加入 auth provider 无法完成 OAuth。应新增独立、有界的发现路径，
从无副作用的初始化探针读取必要 challenge 字段；不得用工具调用试探授权。复用地址校验和固定
HTTP/TLS 连接机制，不扩大正常 MCP endpoint 的白名单。

`FilePluginStore` 使用 AES-256-GCM、原子写入及私有文件/密钥权限。在同一状态中新增可选、
严格解析的 OAuth connection，兼容已有 bearer 安装。保留总大小限制，为 token、metadata、
账户数和待处理工作设上限。当前 `publicPlugin` 只剥除 `token` 再展开其他字段：加入秘密之前，
必须改成明确的公开投影。密钥缺失、加密失败、记录无效时禁止使用，不能重置为空。

`PluginService` 已有插件 revision、manifest digest、Bot grant、在途 abort 和持久化调用
回执。连接分别维护普通刷新的 credential generation，以及重连、scope 变化和断开时改变的
身份/权限 revision。调用绑定插件与连接两个 revision；正常 token 刷新不使未变更的 grant
失效。重连/换账户废止待批准调用并清空 grant，要求重新审查。通用 OAuth 不证明某个人的身份：
只能显示连接标签和 issuer，不能编造已验证邮箱。稳定的服务账户 ID 需要服务 profile 或验证
过的 OIDC 流程，不能从 opaque access token 推断。

[ADR-0007](../decisions/0007-local-owner-auth.md)、
[ADR-0016](../decisions/0016-control-plane-web-security.md) 要求 Owner 会话、Strict cookie
和精确 mutation Origin。跨站回调不能依赖该 cookie；保留现有策略，只新增一个具名 callback
入口，放在默认 `/api/v1/*` 认证门之外。该入口不返回账户数据，也不能独自授权连接。
`OwnerAuthService.authenticate` 目前提供 Owner 身份但不提供私有会话绑定，因此新增只供
Server 使用的绑定方法，不把 cookie 或摘要发到 UI。
[ADR-0045](../decisions/0045-capability-lease-protocol.md) 针对 capability lease 延后 OAuth；
本方案是对外 MCP 客户端，不新增 Server 登录方式或 lease AS。

## 最小生命周期和存储失败语义

1. **发起：** 已认证、Origin 校验通过的 Owner POST 选择已配置 profile 和插件 revision。
   生成 256-bit state、SDK PKCE verifier，绑定当前私有会话、精确 issuer/resource/client/
   redirect/scopes，返回 SDK 生成的授权 URL。模型和 Provider 不能发起或完成同意。默认最多
   16 个待处理 flow、10 分钟 TTL、每个连接一个 flow，不接受调用者传入 return URL；替换
   flow 时销毁旧 verifier。
2. **回调与完成：** 校验有界 query、state、issuer、精确 callback profile，原子转到
   `callback_received`，只在有界 Server 内存保留 code。跳到固定的同源完成页面，仅带 opaque
   flow ID，不带 code/state/token。原先仍有效的 Owner 会话通过已认证、Origin 校验的完成
   POST 单次认领后才交换。退出、其他会话、重复回调、过期 state、revision 变化均为零 token
   请求。拒绝授权也必须先验证绑定才进入终态。callback 响应 no-store/no-referrer；日志、trace
   和反向代理说明不得记录 query/body 凭据。
3. **提交：** 校验 token type、有限正数且有上限的 expiry、scope、token 大小；保存绝对到期
   时间并留少量刷新余量。凭据与绑定 revision 加密原子落盘后才能标记 connected。写失败不
   返回连接成功；token 响应丢失或未保存为结果未知，不重试交换，应重新同意。安装仍要经过
   preview、声明接受、启用和 Bot grant。
4. **刷新：** 每个 connection/generation 最多一个在途刷新，等待者有界、可移除且有期限。
   HTTP 请求之前落盘 refresh intent；轮换凭据和清除 intent 同次原子写入。只有有效成功响应
   缺少替换 token 时才保留旧 refresh token。网络等待不得占住存储串行队列。保存前重新比较
   revision/generation，迟到结果不能恢复已断开的账户。超时/丢响应、`invalid_grant`、保存
   失败、重启时未完成的 intent 均进入 `reauthorization_required`，不重放该 refresh token；
   迟到响应受状态隔离约束。
5. **使用：** 在既有调用准入/回执边界前检查连接及有效期，dispatch 前再次检查权限。取消只
   移除自身等待者，共享刷新仍有固定期限。已发送请求之后的 401/403 只更新安全诊断并终止本次
   调用；之后 Owner 同意不重试这次请求。
6. **断开：** 先持久化本地 disconnected、推进 revision 并 abort/隔离待处理工作，再远程
   撤销。写失败就是失败，不能返回断开成功。已发送的外部动作可能仍完成，保留真实回执。
   存在已审撤销 endpoint 时，将凭据移入加密且不能 dispatch 的撤销记录，进行一次有界
   RFC 7009 请求。HTTP 200 表示服务确认 token 撤销，不证明整账户 grant 已删除；随后擦除
   凭据。超时/崩溃留下 `remote_revocation_unknown`，Owner 明确重试时仅用该隔离记录。没有
   endpoint 则本地断开并删除秘密，标记无法远程撤销。两者都不能显示“已远程撤销”；影响更广
   的服务专用撤销须单独、准确地呈现。
7. **重启：** 仅在密钥和 schema 匹配时加载已连接凭据。授权 transaction 故意只放内存，重启
   后失效，Owner 重新发起；持久化刷新 intent 进入需重新授权，未完成撤销继续本地封锁；旧
   调用回执维持设计中的终态/未知状态。这些记录不使文件存储具备多 Server 写入能力。

## 发现和网络策略

首期以预注册 profile 为边界，包含已审 resource、issuer、client 注册信息、精确 Server
callback URL。未配置之前外部服务不可用。通过按操作限制的 fetch 使用 SDK 发现函数，验证
后才缓存。支持安全的 `WWW-Authenticate` metadata 位置和两种 resource well-known 形式；
要求 RFC 8414 或 OIDC metadata，精确 issuer 和 S256。失败后不从 MCP 主机推断 endpoint。
绑定的 endpoint/client/resource 变化必须使缓存失效并重新审查。

metadata/token/revoke 每个 URL 都单独校验：HTTPS、无 userinfo/fragment，URL、JSON、
challenge、DNS 答案和响应体有界，有限期限，DNS 到连接固定，TLS hostname 验证，不跟重定向，
不接受意外压缩。公开 HTTPS 不代表允许把已保存 client secret 发给新公布的主机；每个 issuer
profile 固定已审 endpoint，刷新/撤销不采用恶意 MCP 响应中的新目标。resource bearer 不得
发往 discovery 或 AS。fixture 仅允许自身精确 loopback URL 和随机端口，不允许进程级绕过。

缺少 client 凭据不自动尝试 DCR。恶意 `registration_endpoint` 同时带来 SSRF 和凭据替换风险；
`client_uri`、`logo_uri`、`jwks_uri`、CIMD 文档还可能触发额外请求。后续 DCR 需要按 issuer
保存注册、有界注册/metadata fetch、明确的信任审查。当前缺少预注册信息返回
`client_configuration_required`；issuer/resource 缺失或不匹配返回
`incompatible_authorization_server`，不回退。

## 受控本地 fixture 与验收

复用 SDK 的 `mcpAuthRouter`、`mcpAuthMetadataRouter`、`OAuthServerProvider` 和
Streamable HTTP MCP server。小型合成 provider 只管理预注册 client、一次性 code、轮换
generation 和测试计数，不新增生产 AS。保留 SDK PKCE 校验；fixture 显式加入 `iss` metadata
及成功/错误响应，不能以为 stock router/provider 已提供 OpenBot 生命周期。使用两个独立
绑定的 AS origin 和一个 resource origin，验证 issuer 混淆与资源分离。

通过真实 Server 路由、Owner 会话存储、加密插件存储和生产 connector，使用可丢弃 PostgreSQL，
跟随真实 HTTP 重定向但不访问外部账户。使用合成 scope、确定性读/副作用工具和请求计数，复用
smoke 自有资源清理方法。无需私人 `.env`、真实 API token、付费模型或广泛进程清理。HTTP
测试在 callback 明确不带 Owner cookie，完成时要求 cookie；后续 UI 包还要实测真实浏览器
跨站返回，不同端口本身不构成跨站。

| 验收用例 | 可观察标准 |
| --- | --- |
| 连接与保留 | 一次 authorization-code 交换；state/verifier 不公开；凭据加密；重启保留连接；只有获授权 Bot 能调用已审工具。 |
| 同意与回调拒绝 | 拒绝、state 缺失/错误/重放、重复 code/error、issuer 错误/缺失、错误 callback、过期/退出/其他 Owner 会话、插件删除/revision 改变：零交换、零工具调用。 |
| 发现攻击 | issuer/resource 不符、无 S256、私网/混合 DNS、目标改变、重定向、超大/非 JSON metadata、回退无关 AS：不发送凭据；无关 fixture sink 收到零秘密。 |
| Scope/账户变化 | challenge 不静默扩权；重连需重新审核 grant；已有 bearer 安装可读，无关插件授权保留。 |
| 轮换与并发 | 并发仅一次刷新；新 generation 原子保存；缺失替换 token 遵守 SDK 语义；abort 移除等待者；过期/无效/丢响应/轮换后崩溃均需重新授权、不重复用旧 token。 |
| 断开竞态 | 对排队调用、刷新、迟到回调保持封锁；存储失败可见；重启不使用隔离凭据；远程成功/无 endpoint/丢响应有不同状态。 |
| 不重放 | AS 过期、401/403、一次副作用后丢 MCP 响应，effect attempt 均恰好一次；重连、刷新、重启、回执查看都不增加 attempt。 |
| 秘密与资源清理 | 公开 snapshot/API/error/log 无 token/code/verifier/secret；丢 key、坏加密状态 fail closed；成功/超时/中断均回收所有自有端口、容器、子进程和临时秘密文件。 |

要求保存包含请求计数、故障用例无 skip 的场景报告，并通过现有 plugin/auth 回归。通过后只能
声称受控 fixture 已验证；真实服务还需验证 metadata、scopes、redirect、账户条件和 P1 MCP
profile。本次研究没有运行尚未实现的套件。

## 独立实施工作包

| 工作包 | 建议文件边界 | 完成条件 |
| --- | --- | --- |
| P2a 协议/策略适配 | 新增 `apps/server/src/plugin-oauth-client.ts`、`plugin-oauth-http.ts`、测试及 `apps/server/src/__fixtures__/` fixture；只有保留既有测试语义时才抽出小型传输 helper | SDK 公开 API 加响应/撤销原语，严格 profile/fetch；issuer/resource/SSRF/replay 负例通过。 |
| P2b 生命周期/路由 | 新增 `plugin-oauth-service.ts`、`plugin-oauth-routes.ts`；限定修改 `plugin-store.ts`、`plugin-service.ts`、`plugin-routes.ts`、`owner-auth.ts`、`app.ts`、`packages/protocol/src/plugins.ts` 及测试 | 真实 Owner 流程、加密重启、刷新 intent/singleflight、断开及原 grant/receipt 通过必跑 fixture。 |
| P2c Owner UI/服务验收 | 共享客户端现有插件面板/API、双语 `PLUGINS` 文档、独立服务 profile 测试 | 连接/状态/重新授权/断开及真实跨站浏览器返回正常；仅在取得配置和授权后测试选定外部服务。 |

P2a 与 P2b 合起来才是最小有用的本地 fixture 交付，只有适配器不算功能完成。集成者负责拟新增
依赖的 manifest/lockfile 接线、测试命令/CI 证据、复用台账和路线图。不改 capability lease，
不引入新登录身份，不全量重构传输，不改全局 cookie 策略。

## GitHub 与 Google Drive 的服务边界

**GitHub remote MCP。** [官方 host guide 固定版本
`85598ba6e1256f7ebf4867b95d63b833c4549264`](https://github.com/github/github-mcp-server/blob/85598ba6e1256f7ebf4867b95d63b833c4549264/docs/host-integration.md)
要求 host 获取 GitHub token，且不支持 DCR。应选择部署者拥有的 GitHub App 或 OAuth App，
确认账户/组织可访问范围，使用实际 MCP challenge，不猜测 issuer。这是 GitHub 明确记录的
专用 token 契约，不允许其他 MCP 服务任意透传第三方 token。本地 stdio 服务内置的 OAuth
应用属于另一种接入，不能借作 OpenBot HTTP 插件应用。

[GitHub 当前 OAuth 流程](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
支持 S256 并推荐 state。Server 使用自己的精确注册 callback，关闭 wildcard matching。
client secret 只留在自托管 Server，不打包到 Electron 或公开前端。区分 github.com 和
Enterprise host。[启用过期的 GitHub App user token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
可有 refresh token，不能替普通 OAuth App 响应虚构刷新能力。
[GitHub 撤销接口](https://docs.github.com/en/rest/apps/oauth-applications) 是专用 REST 操作，
删除 grant 影响该用户对应用的授权，不只当前连接；须用服务适配器和准确的 Owner 操作说明，
不能假设存在 RFC 7009 endpoint。

**Google Drive remote MCP。** Google 现已提供官方
[`https://drivemcp.googleapis.com/mcp/v1`](https://developers.google.com/workspace/drive/api/reference/mcp)。
[2026-09-18 更新的配置指南](https://developers.google.com/workspace/drive/api/guides/configure-mcp-server)
仍标为 Developer Preview，要求计划成员资格、Cloud 项目、Drive/Drive MCP API、OAuth consent
配置和 Web application client。例子列出 `drive.readonly` 与 `drive.file`，不能为所有任务
默认请求二者。注册 OpenBot 自己的 Server callback，不复制 Antigravity 或 Claude 回调。
实际服务 challenge/metadata 和 OpenBot 受限 MCP profile 尚未验证。

[Drive scopes 文档](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
区分按文件的 `drive.file` 和受限的整盘只读 scope；“只读”不等于授权范围小。首任务需要明确
是读取选定文件，还是搜索已有 Drive 内容；账户、组织、应用发布/验证条件随之变化。服务还会
[过滤不适用文件](https://developers.google.com/workspace/drive/api/guides/drive-mcp-server-file-eligibility)，
涉及权限、IRM/DLP、上下文访问和加密。登录成功不保证 Drive 网页可见的所有文件都能通过 MCP
使用。

[Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
要求 `access_type=offline` 才有离线刷新，这是服务扩展，不等于 SDK 的 `offline_access`
scope。Google 记录了撤销的项目范围影响，不能标成“仅移除一个插件”。
[External 应用的 Testing 状态](https://developers.google.com/identity/protocols/oauth2) 可使
refresh token 七天过期，基础 profile scopes 有文档规定的例外；账户策略或授权撤销也可能要求
重新同意。

若官方 Drive 预览不可用，采用其他 MCP 运营者须另审其服务和 OAuth/resource 契约；自行开发
Drive API 插件属于另一适配器，其 Google API 凭据不能与 OpenBot 到 MCP 的凭据混为一谈。
本方案不新增该适配器，也不请求 service account/domain-wide delegation。

两种服务默认都使用 Server 端 Web OAuth client 和精确 HTTPS 公网 callback。仅在服务允许时，
本地开发使用明确注册的 loopback callback；远程 Server 无法接收发往用户另一台电脑 loopback
的回调。Desktop 只打开外部浏览器；内嵌公共原生客户端须另立 RFC 8252 profile，不能声称内置
client secret 是秘密。服务若不支持 `iss`，须另审混淆攻击防御，例如 RFC 9700 的独立 issuer
回调；不降低通用 profile 要求。

## 用户最少输入与剩余不确定项

实现受控 fixture 无需用户提供信息。真实接入前仅需先确认：（1）GitHub 或 Google Drive，
以及第一个具体只读任务/账户范围；（2）仅本地或托管 Server 及 callback origin。再检查部署者
是否已有合适的 app/project、组织/预览访问权。安全的 Server 配置入口实现后才请求凭据，不在
聊天收集。注册应用、真实同意及更广范围撤销仍属于明确的外部动作。

远端 metadata/issuer 行为、刷新能力、账户身份、真实回调兼容性、工具 profile 都尚未验证。
本研究不构成这两种服务的生产支持声明。上述状态名和数值上限是设计决定，不是当前实现。

## 源码使用和验证记录

未复制或实质改写上游源码及文档正文。后续通过正常依赖调用公开 API，沿用依赖分发保留 MIT
声明；若复制上游 fixture/example，实施变更应记录精确文件并保留对应版权许可。

本次已完成仓库/源码/发行/测试/issue/许可核查，以及上述已安装 SDK 的合成探针。变更只包含
这份研究及英文原文；未注册 client、安装新依赖、改 CI、迁移状态、访问私人账户，未声称拟议
生命周期已通过验收。

文档验证通过：`npm run docs:check`（361 份 Markdown）、`npm run research:check`（17 项
检查器测试）。非 pull-request 事件下 PR 正文 CLI 按设计未执行。这些检查验证研究交付，不是
OAuth 实现的验收。
