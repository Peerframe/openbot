# 第三方 MCP 插件

[English](PLUGINS.md) · [简体中文](PLUGINS.zh-CN.md)

OpenBot 通过 MCP 让 Bot 调用外部服务的工具，例如查询业务数据、转换内容，或经你批准后执行写入。
SKILL.md 提供工作指令，MCP 插件提供工具、资源、提示词和隔离的 HTML 界面。安装是在 Server 登记连接，不会把代码下载到 Desktop，
也不会启动插件子进程。

## 创建独立插件项目

在 OpenBot 源码目录执行 `npm run plugin:create -- ../my-openbot-plugin`，目标必须是尚不存在的目录。
生成器复制已有测试覆盖的 MCP 示例与 MIT 许可，写入固定版本依赖和独立 README，不覆盖原有文件。
进入新目录运行 `npm install`，保留生成的锁文件，再运行 `npm start`。运行时不依赖 OpenBot 工作区导入。
按照下文在 Server 配置精确本机地址白名单，再通过插件管理预览、安装、授权和启用。
示例包含工具、资源、提示词和隔离 App。更新预览会列出新增、删除和改变的声明；应用更新仍会停用插件
并清空授权。示例笔记只保存在进程内存中。

## 使用流程

1. 打开插件管理，填写名称、MCP 地址及需要的独立 bearer token。预览只读取工具目录，不执行工具。
2. 核对地址、说明、参数结构和插件声明，确认后安装。新插件默认停用，没有员工授权。
3. 选择员工及具体工具。写入、发消息、改变外部状态或不确定行为的工具使用 **每次确认**。
   **允许读取** 是对可信观察工具的持续授权，允许员工发送参数并调用，不再每次询问。
   插件的 `readOnlyHint` 只是声明，不能自行获得任何权限。
4. 保存授权并启用，让该员工在频道中使用工具。Agent 只看到分配给自己的目录，所有调用经过 Server。
5. 每次确认的调用会在当前频道显示插件、工具、员工、精确参数和过期时间。60 秒内批准或拒绝；
   一次批准只放行一次调用，拒绝、超时或任务取消不会执行。
6. 停用、移除、修改授权会阻止后续访问并中止待审批/执行中的请求。已发送到第三方的请求可能已经生效，
   OpenBot 不会自动重试结果不明的操作。

调用身份来自真实任务，模型不能改用其他 Bot 或频道。工具声明变化会阻止旧调用，要求重新审核。
目录变化时可预览并应用更新，成功后停用插件并清空所有授权。更换地址或凭据时，移除连接后重新预览安装；移除不会删除第三方保存的数据。

外部服务接收工具参数，不会自动获得整个工作区或其他服务密钥；所选模型接收工具结果。
结果是不可信资料，不能据此批准操作或扩大权限。外部服务可能虚报工具行为，OpenBot 的授权检查不是它的代码沙箱，
应使用你信任的后端和权限有限的服务账号。

## 运行作者示例

源码目录完成 `npm ci` 后启动独立 MCP 服务：

```sh
npx tsx apps/server/src/plugin-example.ts
```

在 OpenBot **服务电脑** 明确配置开发地址并重启：

```dotenv
OPENBOT_PLUGIN_LOCAL_ENDPOINTS=http://127.0.0.1:4318/mcp
```

如果由 Desktop 托管本地 Server，应在应用启动环境中设置后重新打开应用。localhost 指服务电脑，不是远程客户端。
只允许完整名单内的字面 `127.0.0.1` / `::1` 本机地址；外部服务要求公开 HTTPS，所有 DNS 结果必须为公网 IP。
地址中的账号密码、查询字符串、片段和重定向均拒绝。

在插件管理中预览安装该地址。给一名员工授权 `sum_numbers` 为允许读取，`append_note` 为每次确认，
再启用。配置支持工具调用的模型并启用原生 Agent，发送：

```text
用 sum_numbers 计算 13 加 29。
```

然后发送：

```text
用 append_note 保存“已经核对结果：42”。
```

批准前不会写入，批准后只追加一次；其他未授权员工不能调用。笔记是示例服务真实的内存状态，重启清空，
不涉及第三方账户或本地文档。参考[示例源码](../apps/server/src/plugin-example.ts)。

## 作者契约

实现普通 **MCP 2025-11-25 兼容 Streamable HTTP 服务** 即可，可使用其他语言。
OpenBot 固定官方 SDK **1.30.0**，提交 `2d889f2b329e46680ec9bdd565de4616c497825a`，
不要求作者接私有 SDK。见[调研](research/third-party-mcp-plugins.md)。

| 内容 | 当前范围 |
| --- | --- |
| 传输 | 一个精确地址；每次预览/调用建立新 SDK 客户端，不支持重定向、Cookie、代理、重连重放。返回完成的 JSON 或有界 POST SSE；不打开长期 GET 推送流。 |
| 认证 | 可选独立 bearer token，在 Server 加密保存；未实现 OAuth 和动态凭据发现。 |
| 工具目录 | 每种能力一页完整目录，最多各 32 个工具、资源和提示词，至少一项，合计最多 64 KiB；不接分页或 URI 模板。 |
| 名称与说明 | 名称 1–64 个英文字母、数字、点、下划线或连字符；说明最多 2,000 字符，模型目录使用有界摘要。 |
| 参数结构 | 同步 draft-07 子集；根 object，最多 12 KiB、12 层和 1,000 个 JSON 节点；支持对象、数组、标量、范围、必填、枚举及 draft-07 applicator；拒绝引用、`$id`、正则、format、请求头镜像扩展。见下方方言契约。 |
| 参数与结果 | 参数最多 8 KiB 并校验结构；结果为文本块，可附结构化 JSON，合计最多 12 KiB；不接图片、音频、资源或界面代码，`isError` 会使调用失败。 |
| 时间 | HTTP 最多 30 秒，审批 60 秒，调用 120 秒，同时受父任务截止时间约束。 |
| 数量 | 最多 16 插件；每插件 32 工具、128 个员工授权项；16 并发调用；Agent 目录最多 16 工具和 12 KiB，并标记截断。 |
| 权限 | `call_plugin` 共享原生 Agent 工具次数，不获得额外执行、递归或后台权限。 |

本适配器不提供 sampling、elicitation、roots、stdio、任务扩展、资源订阅、二进制资源或自动执行安装包。建议读写拆成不同工具，在后端再次验证参数与授权，说明真实副作用。
Annotations 帮助审阅但不保证行为。不要把原始账户密码放入模型工具参数，使用 Owner 单独配置的服务 token。

### Schema 方言契约

OpenBot 固定的 SDK 按 draft-07 校验。可省略 `$schema`，或设置为
`http://json-schema.org/draft-07/schema#`（末尾不带 `#` 的同一标识也可）。
其他显式方言包括 2019-09、2020-12 会被拒绝，Server 不会静默换一种规则解释。
工具可选的 `outputSchema` 也遵循这一策略。

支持的约束包括 `properties`、`additionalProperties`、`required`、`dependencies`、标量/数组范围、
`enum`、`const`、`allOf`/`anyOf`/`oneOf`、`not`、`if`/`then`/`else`、`contains` 和
draft-07 `items`/`additionalItems`。例如 tuple 使用
`"items": [{"const": "read"}], "additionalItems": false`，字段依赖使用
`"dependencies": {"source": ["revision"]}`；这些结构仍需置于根 object Schema 内。

较新关键字 `prefixItems`、`dependentRequired`、`dependentSchemas`、`minContains`、`maxContains`、
`unevaluatedProperties`、`unevaluatedItems` 不受支持；`$vocabulary`、
`$anchor`/`$dynamicAnchor`/`$recursiveAnchor`、`contentSchema`、OpenAPI `discriminator` 和
Ajv `$async` 也会被拒绝。错误会指出具体关键字或不支持的方言。同名普通属性及
`enum`/`const`/`default` 数据仍可使用；annotation 不会增加校验规则或权限。

已经安装的插件若使用了上述结构，调用会在连接前停止。请让所用 Schema 库导出受支持子集，
预览变化、应用更新，再审核并恢复授权。不要仅为通过发现而删去必要约束；应使用受支持结构
保留原意，并在插件后端再次验证。

## Owner API

路径前缀 `/api/v1`，需要已有 Owner 会话；写操作还需要可信 Origin。token 只在输入中接收，不从列表或审计返回。

| 请求 | 输入/输出 |
| --- | --- |
| `GET /plugins` | `{ plugins, pendingCalls }` |
| `POST /plugins/preview` | `{ name, endpoint, token? }` → `{ name, endpoint, tools, resources?, prompts?, digest }` |
| `POST /plugins` | `{ name, endpoint, token?, reviewedDigest }` → `201 { plugin }` |
| `PATCH /plugins/:id` | `{ revision, enabled }` → `{ plugin }` |
| `PUT /plugins/:id/grants/:botId` | `{ revision, tools: [{ name, mode: "read" 或 "confirm" }], resources?: [uri], prompts?: [name] }` → `{ plugin }`；全部为空时撤销 |
| `POST /plugins/:id/update/preview` | `{ revision }` → `{ currentDigest, revision, changed, manifest }`，不修改安装 |
| `POST /plugins/:id/update` | `{ revision, reviewedDigest }` → `{ plugin }`，停用并清空全部授权 |
| `GET /channels/:channelId/bots/:botId/plugin-content` | 已有频道成员和该 Bot 的内容授权 → `{ items, truncated }`，无需先启动任务 |
| `POST /channels/:channelId/bots/:botId/plugin-content` | `{ pluginId, revision, kind: "resource" 或 "prompt", name, arguments? }` → 不可信文本/界面资料 |
| `DELETE /plugins/:id` | `{ revision }` → `{ deleted: true }` |
| `POST /plugin-calls/:id/decision` | `{ decision: "approve" 或 "reject" }` → `{ decided: true }` |

配置/授权旧 revision 返回 `409`。审批 ID 只在原任务等待时有效，重启不重放审批。
审批接口成功仅表示决定被接收，外部操作是否完成仍需查看任务结果。

## 数据与验证

加密配置及最近 500 条无内容审计保存在 `<OPENBOT_OBJECT_STORE_PATH>/plugins/state.json`，
独立密钥为 `state.json.key`，备份时同时保留。已有数据缺失或不匹配密钥会拒绝读取。
原子写入及 revision 比较通过单 Server 队列串行处理，不支持多进程共享。审计不保存参数、结果或 token；
待审参数仅在等待期间存于内存，供 Owner 检查。

`plugin-service.test.ts` 使用真实本机 HTTP MCP 服务和官方 SDK 验证发现、精确审核、安装、员工授权、计算、
批准前不写入、批准只消费一次、停用。反例覆盖错误员工、版本/目录变化、参数、超时、取消、撤销、加密存储和
不影响邻接 API 的请求大小限制。这是本机协议闭环，不代表所有第三方服务和模型账号已经实测。


## 资源、提示词与隔离界面

使用标准 `resources/list` / `resources/read` 和 `prompts/list` / `prompts/get`。为每名 Bot 单独勾选资源 URI、提示词名称；工具授权不会自动授权其关联界面。资源 URI 只交给原 MCP 服务，绝不当作 OpenBot 本地文件或任意网址打开。读取前与返回前都检查完整声明摘要、Bot/频道成员身份和当前授权；取消、停用或撤销授权后丢弃晚到的结果。

普通资源和提示词结果最多 12 KiB。资源必须返回与请求 URI 一致的文本。提示词支持最多 16 个命名字符串参数、16 条 user/assistant 文本消息；缺失必填或包含未知参数时不发送请求。提示词应由 Owner 主动选择，始终是不可信资料，不能提升为系统指令。

HTML 界面使用 `ui://` 资源和 `text/html;profile=mcp-app` MIME，完整响应最多 160 KiB，单个 HTML 字符串最多 128 KiB。工具可声明 `_meta.ui.resourceUri`，关联关系计入审核摘要。Server 只返回不可信 HTML 数据，不执行代码；宿主负责 MCP Apps 生命周期及与应用源隔离。CSP/网络/设备声明不会自行获得授权，初始宿主策略禁止外部网络与设备访问；使用可选 Apps 能力前请核对宿主支持范围。

运行示例还提供 `notes://current`、用户主动选择的 `review_note(note)` 和 `ui://notebook/view.html`。资源和提示词测试使用真实本机 MCP SDK HTTP 服务，证明传输与授权链路，并不代表所有第三方应用都已兼容。

## 更新插件

更新从已安装的精确地址重新读取声明，不下载程序，也不自动更新第三方服务器。预览展示替换后的目录及摘要是否变化；应用时必须提供该摘要和安装 revision。成功后清空全部 Bot 授权并停用，即使声明版本未变化也需要重新授权启用。并发修改或预览后目录变化返回 `409`，保留旧安装。凭据保留但绝不回传。

当前界面宿主使用官方 MCP Apps 1.7.5 AppBridge：双层隔离 iframe，支持本地交互与已授权资源读取；不开放工具调用、发消息、模型上下文修改或外部网络/设备。

MCP 会话通过 SDK 向相同受校验端点发送终止请求，最多等待 5 秒并兼容 HTTP 405；清理结束前保留并发名额。清理失败不会重放业务调用，也不能证明远端已删除会话。Schema 关键字限制只作用于对应位置，普通字段名如 `format` 可以使用。公开数据契约与界面共享，授权仍由 Server 决定。见[研究](research/plugin-flow-refactor.zh-CN.md)。
