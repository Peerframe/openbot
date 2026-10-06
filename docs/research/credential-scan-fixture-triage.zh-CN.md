# 研究：凭据扫描的历史测试数据精确判定

- 状态：已采纳
- 日期：2026-09-08
- 负责人：@yxflc11
- 对应问题：main `979c989` 的 CI `34207930929` 安全任务失败。
- 验收目标：继续扫描全部 Git 历史，仅放行已核验的一个合成 URL 测试数据；其他命中和扫描错误均阻断 CI。

## 证据与选择

英文[完整研究记录](credential-scan-fixture-triage.md)包含查询、固定版本、候选比较和许可证。
复用现有 TruffleHog `3.97.1` / `20652fbbdefffcdaa493a5bf57ab2ac6b1db715b` 及固定容器摘要，
重新检查其 CLI、Git 扫描、URI 检测器和测试，并参考上游忽略说明与路径排除问题 #420。

仅扫描 main 返回 0；像 CI 一样获取所有远端分支后返回 183。唯一命中位于提交
`9cc73c9e78451e572f57d142d6b9caf62ccb78e2` 的 `apps/server/src/model-web-tools.test.ts` 第 188 行。
该测试故意使用保留域名 `example.com` 上的合成用户名与密码，验证程序拒绝带凭据的 URL。
它不是实际账户凭据。两个候选字段的 SHA-256 均为
`1231625e7e70c4e56347672932d37a1c35eff89051483b37cbd09f7b9c58337e`。

选择通过简短 Node 适配器处理现有扫描器 JSON。原生路径或检测器排除会覆盖其他内容；
修改当前测试或增加行内忽略不能改变已发布的历史；更换 Gitleaks 会改变检测覆盖范围。
固定提交、路径、行号、URI 检测器名称及 ID、未验证状态和两个候选摘要必须全部匹配才能放行。

不新增依赖，不复制或实质改写扫描器源码。外部 AGPL-3.0 扫描器不链接、不随产品分发。
继续保留完整历史、只读挂载、禁用验证和更新、不上传结果的现有边界。
候选内容只留在临时文件中，不写入日志。不改写已发布历史。

## 验证

测试覆盖变更提交、路径、行号、检测器和候选值、已验证结果、混合结果、无效 JSON、过大输出、
扫描错误及退出码不一致；工作流回归检查确保继续扫描并调用适配器，不能忽略失败。
执行 `npm run check` 并重放真实完整历史结果，最终以 GitHub 托管 CI 验证 Linux 运行环境。

## Desktop UI PR 的历史测试样例（2026-09-09）

PR #23、CI `34344341115` 通过生产依赖审计，但精确命中适配器拒绝了两条新增历史样例。使用相同摘要固定的 TruffleHog 镜像，在只读临时检出、禁用网络、验证和更新的条件下重放完整历史，返回 183，仅发现三条 URI 合成测试样例；候选原文没有打印或上传。

新增精确记录：

- `c095669dbb4e241d2999867e3778b1b4408a83fa` 的 `apps/desktop/src/desktop-support-links.test.ts:29`：固定支持链接的负向测试，模拟系统浏览器没有被调用。
- `e8fa933dbd94751ee01974bb16e53158760f1c26` 的 `apps/server/src/native-web-tools.test.ts:99`：模型端点的负向测试，模拟网络请求没有被调用。

两条记录的 Raw 与 RawV2 摘要分别列在[英文研究](credential-scan-fixture-triage.md)中。仅当提交、文件、行号、检测器 17 / URI、未验证状态和两个摘要全部匹配才放行；其他内容和扫描错误继续阻断。当前测试通过 URL 属性构造同样的拒绝输入，避免新增字面量匹配。没有修改工作流、关闭安全检查或引入依赖。

验证：13 项安全契约、20 项支持链接、31 项 native-web-tools 测试通过。包含修复候选的完整离线扫描仅返回同样三条历史样例，适配器通过。临时检出与原始扫描文件已清理。

## 插件准入测试样例（2026-09-10）

PR #29 的离线同版本扫描发现历史插件负向测试中的第四条 URI 匹配。已检查固定提交 `cb057607a100ccc10dd4cec6eece6c9cfc4a5158` 的 `apps/server/src/plugin-service.test.ts:385`：它是拒绝 URL 用户信息的 example.com 合成输入，不发送请求。英文记录保留两份精确摘要；继续按提交、文件、行号、检测器和摘要逐项匹配，并测试任何变更都拒绝。当前测试改用 URL setter 构造相同输入，不跳过历史、文件或检测器，不验证或上传候选值。

## 贡献者 PostgreSQL 拒绝样例（2026-09-23）

PR #85 的 CI `35812975675`、security 任务 `107028356527` 生产依赖审计为零漏洞，
随后精确命中适配器失败。实施前，用原有摘要固定的 TruffleHog 镜像，对所有远端分支的
临时完整克隆进行只读、离线扫描；检出点为 `97745c13412972b2440a5914c20e8fd44f99e7df`，
禁用网络、验证和更新。扫描返回 183，共六条未验证命中：四条已审核 URI 样例，以及
已发布 `codex/collaborative-development` 分支中的两条 PostgreSQL 负向测试。
即使该分支尚未合入，也在完整历史扫描范围内。候选原文与诊断仅存放于权限受限的临时文件。

重新查阅固定 v3.97.1 / `20652fbbdefffcdaa493a5bf57ab2ac6b1db715b` 的 PostgreSQL 检测器、
测试、CLI 和路径排除议题；[英文记录](credential-scan-fixture-triage.md)保留查询与精确链接。
检测器将 Raw 和 RawV2 规范化为带默认端口的连接地址，摘要取自真实扫描结果。
沿用精确适配器：路径或检测器排除会扩大豁免，修改当前测试无法删除已发布历史，替换扫描器
会改变检测范围。外部 AGPL-3.0 工具、固定镜像与分发边界均不变。

仅新增以下两条不可变记录；两份 Raw 摘要完全相同，完整摘要列在英文表格中：

- `d854e2afa62c90455570fae502f9a1616d320794`、`scripts/smoke-dev-fixture.test.mjs:31`：
  example.com 上的合成目标，用于证明 `validateDatabaseUrl` 拒绝非回环地址；函数只解析和断言。
- `716c2867beac3467be5eebe6b134e343b0523296`、`scripts/verify-retained-upgrade.test.mjs:20`：
  db.example.com 上的合成目标，用于证明 `validateUpgradeTarget` 拒绝非回环地址并隐藏错误中的密码；
  函数只解析和断言，不连接数据库。

每条记录均绑定检测器 ID/名称，因此旧四条只接受 17 / URI，新两条只接受 968 / Postgres；
未验证状态、提交、路径、行号和两个摘要必须全部匹配。禁止按测试文件、示例域名、PostgreSQL
检测器或未验证状态统一豁免。不新增依赖、不复制上游源码、不改变扫描范围、不验证或上传候选。

验证计划：重放六条真实结果，测试逐字段变更以及替换成另一种已允许检测器仍被拒绝，保留扫描错误、
无效与混合输出的拒绝测试；使用 URL setter 构造回归样例，避免新增字面量凭据 URL。
运行安全/工作流聚焦检查，并在包含候选修改的临时提交上再次离线扫描；完整仓库检查与最终托管 CI
仍是合并条件。

验证完成：15 项凭据/工作流契约测试、聚焦 Biome 检查及 `docs:check` 通过，六条真实结果均通过
严格适配器。将四个候选文件放入仅本地临时提交后，再次进行完整历史离线扫描，仍返回 183，
仅有原六条已审核命中，无新增命中，适配器通过。本轮没有提交或推送集成工作树；主集成检查
也已完成 `npm run check` 并通过，最终发布提交的托管 CI 仍是合并门禁。

## TS 契约与私有 peer 样例（2026-10-06）

[Draft PR #200](https://github.com/Peerframe/openbot/pull/200)的准确 head为
`49dac0186fa6a127dffc0b079458fca30ac54352`。
[CI run37470541095](https://github.com/Peerframe/openbot/actions/runs/37470541095)生产依赖审计零命中，
随后精确适配器拒绝五条未登记的历史 URI 负向测试。使用原有固定 TruffleHog3.97.1镜像，在
只读完整历史 clone中关闭网络、验证与更新，实际重现 exit183、23条结果：18条原有精确样例，
以及以下五条新样例。候选原文及诊断只保存在私有临时文件。

重新核对既有固定 URI检测器及每条不可变源码行。Raw是 URL连接地址，RawV2还保留路径；
两份摘要来自实际扫描。五条都以固定回环端口或保留示例域名构造假 userinfo，检查操作配置或
目标输入在转发/联网前拒绝。它们不是账户凭据。继续沿用原有方案比较、扫描器及外部工具
AGPL-3.0边界：改当前测试不能删除已发布历史，按路径或检测器排除会扩大豁免。不改依赖，
不复制或实质改写扫描器，不验证或上传结果。

五条均绑定提交 `a240b810ea08bde29004e947b0ffc0298ad8dd1a`、检测器17 / URI和未验证状态：

- `apps/server-ts/src/app.test.ts:482`：拒绝私有 upstream操作配置中的 userinfo。
- `apps/server-python/scripts/control-contract-fixtures.py:1152`：拒绝模型连接 base URL中的 userinfo。
- `apps/server-python/tests/test_proxy_peer.py:76`：拒绝 public origin操作配置中的 userinfo。
- `packages/contract-tests/src/work.test.ts:268`：拒绝私有 MCP测试目标中的 userinfo。
- `packages/contract-tests/src/work.test.ts:75`：拒绝公共契约目标 origin中的 userinfo。

两份准确摘要见[英文记录](credential-scan-fixture-triage.md#ts-contract-and-private-peer-fixtures-2026-10-06)。
提交、路径、行号、检测器、验证状态及两份摘要必须全部匹配；任一变化、未知/已验证结果或扫描错误
仍阻断。回归集共27条，逐项变更全部字段。当前测试改用 URL setter或分段 URL组件，保持拒绝
输入一致并避免新增字面量命中。26项安全/工作流检查通过，包含未知、已验证、混合、无效结果和
扫描错误拒绝；实际23条结果通过严格适配器。候选再次扫描及最终托管状态记入既有
[迁移检查点](typescript-control-plane-p0.zh-CN.md#当前迁移检查点2026-10-06)，本地回放不冒充 Linux托管门槛。
