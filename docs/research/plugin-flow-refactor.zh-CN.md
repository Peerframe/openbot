# 调研：MCP 生命周期与共享插件契约

- 状态：接受实施
- 日期：2026-09-14
- 负责人：OpenBot contributors
- 关联：独立仓库审查 PP-1、PP-2、PP-3、PP-5
- 验收旅程：真实本机有状态 MCP 服务接受普通 `format` 参数，沿既有授权路径调用一次，关闭后清理会话；错误 Provider 声明在联网前拒绝。
- 权限边界：Server 保留发现策略、地址/DNS/TLS、密钥、授权、审批和审计；共享 Schema 只描述数据。清理不得调用或重试业务工具。

## 检索与候选

2026-09-14 检索 GitHub 的 `repo:modelcontextprotocol/typescript-sdk terminateSession close session`、`repo:json-schema-org/json-schema-spec properties enum const`、`repo:colinhacks/zod safeParse 4.5.4`。已核对复用总表的 MCP、Node 协议校验、Provider SDK 条目及现有调研。完整固定来源链接、许可与测试读取方式见[英文证据](plugin-flow-refactor.md)。

选择既有 MCP 2025-11-25 与官方 SDK **1.30.0 / 2d889f2b329e46680ec9bdd565de4616c497825a**（MIT）。审查发布记录、Client/StreamableHTTP/AJV 源码、MIT LICENSE、上游 DELETE/405 测试和会话过期 issue 1708；测试文件通过 GitHub contents API 成功读取。`close()` 仅做本地关闭，`terminateSession()` 已提供标准 DELETE，清理规范是 SHOULD。无需更换协议或复制实现。

复用 Zod **4.5.4 / e8e206fa33ac5fe7ce20a2beb12d57b1cb3df653**（MIT）及既有 wire schema，核对该版本发布和外部递归 schema 问题 6549；本次不引入递归 Zod schema、不升级依赖。SDK 中 AJV 继续验证参数，但其默认 `strict:false / validateSchema:false` 不替代 OpenBot 禁引用、禁正则以及全数据深度/节点限制。

## 实现边界与取舍

- 用 SDK session termination 和独立至多五秒清理截止时间，精确 endpoint/session，复用 DNS 固定、TLS、拒绝重定向等限制。父调用取消后，只允许必要 DELETE 清理继续；不重试业务调用。
- 把无 Node 运行时依赖的 DTO/data schema 移入 `packages/protocol/src/plugins.ts`，原入口兼容 re-export；加密、digest、发现策略和权限仍留 Server。
- 本地缺口是有界策略遍历：区分 subschema、属性名映射、enum/const/annotation 普通数据；对所有 JSON 数据仍计数深度与节点。它不是另一套 JSON Schema 验证器。
- Provider 启动声明先复用 wire schema，再检查归属与重复。未来 SDK/方言升级必须更新策略中的 Schema 位置并重跑安全/互操作夹具。OAuth、stdio、视图新权限和签名租约不在范围内。

## 源码与许可

没有复制或实质改编上游源码/文档；既有依赖通过 API 复用，MIT notices 保留在已有依赖与 `THIRD_PARTY_NOTICES.md`。共享类型从 OpenBot 自身移动。

## 验证与限制

真实本机 SDK 有状态 HTTP：重复连接与调用清理归零、close 幂等、405、取消、初始化失败、挂起清理有界，工具绝不重放。Schema 测合法业务名、enum/const 数据、嵌套真禁用关键字和全部预算；Provider 测错误版本/约束/名称/平台及内置声明。运行协议、Server、Web 定向测试/类型检查，主维护者执行完整 check。

证据只覆盖本机 Node/HTTP；不访问真实用户数据、不调用付费模型、不推导原生 Provider 支持。远程服务可拒绝或无法收到清理请求，本地必须有界退出，不能承诺远程资源已删除。主维护者同步总表与公共指南。

## 验证结果（2026-09-14）

合并前独立审查又复现了既有方言不一致：SDK **1.30.0 / 2d889f2b329e46680ec9bdd565de4616c497825a** 的
同步 `AjvJsonSchemaValidator` 采用 Ajv draft-07 默认类，配置 `strict:false / validateSchema:false`。
`prefixItems`、`dependentSchemas`、`unevaluatedProperties` 的三组非法输入会被该适配器放行，
而现有 Ajv2020 导出均拒绝。`$async:true` 还会让编译结果返回 Promise，被同步适配器误判为成功，
随后产生未处理的校验异常。探针仅使用合成数据，未调用外部服务。

修复前已对照[固定 SDK 源码](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/2d889f2b329e46680ec9bdd565de4616c497825a/src/validation/ajv-provider.ts)、
现有锁定 Ajv **8.20.0** 的[发布](https://github.com/ajv-validator/ajv/releases/tag/v8.20.0)、
[默认类源码](https://github.com/ajv-validator/ajv/blob/v8.20.0/lib/ajv.ts)与安装包的 draft7/core/applicator/validation 词汇表；
两项依赖均为 MIT。官方[方言/关键字说明](https://ajv.js.org/json-schema.html)、
[异步校验说明](https://ajv.js.org/guide/async-validation.html)以及
[draft-07](https://json-schema.org/draft-07)、[2020-12](https://json-schema.org/draft/2020-12)支持上述判断。
GitHub 检索 `repo:modelcontextprotocol/typescript-sdk AjvJsonSchemaValidator async` 还找到上游 v2
迁移说明中的方言变化；未固定的 v2 分支只用于理解背景，不作为本次实现来源。

决定继续使用现有 SDK/编译器，在编译前明确限制为同步 draft-07 子集：省略方言时使用已公布子集，
显式声明仅接受 draft-07；在真正 Schema 位置拒绝较新约束、未支持的词汇/anchor/content schema 声明和
`$async`，保留同名业务字段以及 enum/const/default 普通数据。已安装插件的旧参数 Schema 也必须在
编译参数、连接服务前通过同一策略；现有 SDK output-schema 钩子已使用这套策略。保持既有预算和
draft-07 applicator，不新增验证器、不升级依赖、不复制上游源码、不声称完整支持 2020-12。
反例覆盖忽略约束、嵌套位置、旧安装，兼容测试覆盖原有约束及普通字段名。

四个新增测试文件共 25 项通过，真实 SDK 有状态本机夹具覆盖三次会话清理归零、普通关键字同名参数发现/调用、取消后不重放、初始化失败后的已知会话清理、405、重定向拒绝及挂起清理上限。八个既有插件/Provider/UI 测试文件共 58 项通过；增加“清理期间仍占用并发名额”的回归后，service/content 两套 22 项通过，合计执行文件含 84 个不同测试。Server、Web、Provider SDK 类型检查、限定文件 Biome 与 diff 空白检查通过；公共 DTO 只在协议文件定义。

首次本机端口测试受到沙箱 EPERM 限制，经自动执行审批放行后同一夹具成功；没有访问外部服务或模型。全仓库 check 由协调维护者执行。

补充方言/异步边界修复后，plugin policy、service 和真实 MCP transport 三套共 57 项通过；
7 项展示固定 SDK 原本会忽略的约束，5 项旧目录反例在连接、审批和 dispatch 前拒绝。
Server 类型检查、限定文件 Biome 和 302 份文档检查通过，完整仓库验证仍由协调维护者执行。

## Windows CI 补充：直接等待 cleanup 事件

PR #71 首轮 Windows 仅 cleanup 并发测试失败：`vi.waitFor` 在默认 1 秒内只看到 16 次 `close()`
中的 14 次，之后 finally 的全部调用收尾完成。该测试的 Windows ACL 已使用 no-op 夹具，不能归因于
PowerShell ACL 失败；它仍执行真实加密文件读取、原子审计写入及异步调度。原测试把这些操作的
1 秒吞吐量误当成并发契约。

修改前核对复用总表的固定 **Vitest 5.0.0 / f441c6fab25e579c5b7dd3dd50538416f415fbae**（MIT）、
安装包 `waitFor` 源码的 50 ms 轮询/1,000 ms 默认时限，以及官方
[vi.waitFor](https://vitest.dev/api/vi.html#vi-waitfor)、
[异步测试与时限](https://vitest.dev/api/test.html#timeout)。也查看现有
`task-attachment-references.integration.test.ts` 的 Promise 事件屏障和有界 `abortPluginOperation`。
固定[上游目录](https://github.com/vitest-dev/vitest/tree/f441c6fab25e579c5b7dd3dd50538416f415fbae/packages/vitest/src/integrations)
中单文件网页未能由读取器取回，默认值以已安装精确版本源码复核。

使用夹具拥有的事件表示全部 16 个调用进入被阻塞的 cleanup，并与提前结束的调用、10 秒取消时限竞争；
启动后立即注册 allSettled，避免未处理拒绝。finally 始终解除屏障、取消未完调用，并在独立 10 秒内
完成收尾；单测试预算 30 秒。仍断言 16 次业务成功、屏障未释放时第 17 次被拒绝、释放后新调用恢复。
只调整测试同步与测试时限，不改变生产并发上限或权限，不添加重试、sleep 同步、依赖或复制上游源码。
Windows 是否成功仍以实际下一轮 CI 为准。

修复后本机目标用例通过，随后整个 `plugin-service.test.ts` 18/18 通过；Server 类型、限定文件 Biome
和文档检查通过。另一名 Agent 只读复核了事件/失败竞争、有界收尾、容量拒绝和恢复接纳断言。
本机结果不替代真实 Windows CI。
