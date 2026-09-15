# 调研：React DOM 类型与 Zod 更新

[English](dependency-types-zod-september15.md) · [简体中文](dependency-types-zod-september15.zh-CN.md)

- 日期：2026-09-15
- 状态：已审查；合并前仍需组合安装及 CI 验证
- 范围：[#79](https://github.com/Peerframe/openbot/pull/79)、[#80](https://github.com/Peerframe/openbot/pull/80)
- 验收：编译 Web/Desktop，继续拒绝无效配置、协议消息及 Server 输入。Zod 是生产解析器，React DOM 类型仅用于开发。

## 来源与精确选择

先阅读[复用账本](../OPEN_SOURCE_REUSE.zh-CN.md)中 Node 协议输入校验及 macOS Worker Host 配置；历史版本保留为带日期的审查基线。

| 发布依赖 | 审查源码 | 许可证 | 决定 |
| --- | --- | --- | --- |
| `@types/react-dom` 19.3.0 | DefinitelyTyped [`de5e8f01d01a14ae4ae502283d3d09f042f1ad89`](https://github.com/DefinitelyTyped/DefinitelyTyped/commit/de5e8f01d01a14ae4ae502283d3d09f042f1ad89)，[PR #75429](https://github.com/DefinitelyTyped/DefinitelyTyped/pull/75429) | MIT | 采用：peer `@types/react ^19.3.0` 匹配已有类型 19.3.0 和 React/React DOM 19.3.0 运行时。 |
| Zod 4.6.2 | [`e359f7378fe56d695134701cda1e9055a08892dc`](https://github.com/colinhacks/zod/tree/e359f7378fe56d695134701cda1e9055a08892dc) | MIT | 以组合检查通过为条件采用：保留 Zod 4 API 和 ESM/CJS 包，无声明的生产依赖。 |

阅读声明差异与测试、精确 tag 的 Zod 解析器和 prefault 回归测试、许可证、Zod
[4.6.0](https://github.com/colinhacks/zod/releases/tag/v4.6.0)、[4.6.1](https://github.com/colinhacks/zod/releases/tag/v4.6.1)、[4.6.2](https://github.com/colinhacks/zod/releases/tag/v4.6.2)及[兼容指南](https://zod.dev/v4/changelog)。对照 npm 精确版本元数据与 PR 锁文件；registry DNS 不可用时使用缓存，另通过 GitHub API 核对 Zod tag。研究期间未运行上游测试套件。

发布锁定标识：

- `@types/react-dom@19.3.0`：`sha512-ZI7bU42mZXXKHn/qNLEw2IrbiINU7X5+vfgdixBHkCNpYWXjKgfQ/P+uyGb5CjOLB9UcnTeg3rylQtV2hym44Q==`。
- `zod@4.6.2`：`sha512-lh5RCAGFa1Cm2hjtNwLQhSs/AsqdWnTQaBER9fEwN/88pSh7KOtJavtBx/0VlkN/uFd61SwYmljLMDAsHlvzBQ==`。

## 兼容、维护与问题审查

9 月 9 日 DefinitelyTyped 更新加入 stable 浏览器渲染声明；已阅读的[测试](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/de5e8f01d01a14ae4ae502283d3d09f042f1ad89/types/react-dom/test/react-dom-tests.tsx)覆盖 root 创建、Server 渲染、表单及 `act`。OpenBot 使用 `createRoot(...).render(...)`，此次不增加运行功能。查询 `repo:DefinitelyTyped/DefinitelyTyped is:issue is:open react-dom` 包含[版本对应问题 #43962](https://github.com/DefinitelyTyped/DefinitelyTyped/issues/43962)及旧第三方类型问题，未发现适用的 19.3.0 阻塞，也不能证明没有缺陷。

Zod 4.6 包含递归解析内存清理及 JSON Schema 约束修复；4.6.1 修复带默认值的 discriminator 和递归推断，9 月 10 日发布的 4.6.2 修复 undefined prefault 输出和对象键。已阅读[解析器](https://github.com/colinhacks/zod/blob/e359f7378fe56d695134701cda1e9055a08892dc/packages/zod/src/v4/core/parse.ts)保留同步/异步解析与错误构造；[prefault 测试](https://github.com/colinhacks/zod/blob/e359f7378fe56d695134701cda1e9055a08892dc/packages/zod/src/v4/classic/tests/prefault.test.ts)覆盖转换后的 undefined、对象键与同步/异步路径。

项目搜索发现 `parse`/`safeParse`、严格对象、transform、refinement 和边界；未直接使用 `prefault`、`compile`、`withParser`、`fromJSONSchema`、`toJSONSchema`。依赖内部仍可能转换 schema，故 Server plugin 集成仍需验证。查询包括 `site:github.com/colinhacks/zod "v4.6.2"` 及 `repo:colinhacks/zod is:issue is:open 4.6.2`（后者无匹配）。更广的问题审查包含 compiled async/lazy 行为 #6574、[自动 mock #6486](https://github.com/colinhacks/zod/issues/6486)及递归类型深度 #6015。OpenBot 未启用 compiled parser，也不自动 mock Zod。依赖审查人员同时筛查 4.6.3–4.6.5，properties API 与 URL 性能改动未表明当前调用存在阻塞；本决定不预先批准后续版本。

## 复用决定与安全边界

复用已有发布依赖。标准不提供 React 声明或现有 Zod 实现的直接替代，无证据要求 adapter、fork 或本地解析器。保留类型 19.2.7 会落后于运行时，保留 Zod 4.5.4 会缺少已审查的维护修复；相关回归时仍可回退。

OpenBot 缺口仅为精确 manifest/lock 同步与证据。保留 integrity、peer、严格类型和拒绝输入测试；身份、授权、路由、审批及审计仍由 Server 负责。不强制转换绕过失败，不跳过解析。不增加能力，不复制或实质改写上游源码，不引入 vendored 文件。保留随包分发的 [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/de5e8f01d01a14ae4ae502283d3d09f042f1ad89/LICENSE) 和 [Zod](https://github.com/colinhacks/zod/blob/v4.6.2/LICENSE) MIT 许可证。

## 必须完成的验证

对最终组合运行干净的 `npm ci`，检查 `npm ls @types/react @types/react-dom zod`，完成 `npm run check`。保留 config/protocol 拒绝输入、Server route/plugin、Web 部件及 Web/Desktop 构建测试；继续要求托管 Linux/macOS/Windows 检查。实际结果和测试提交记录在集成 PR，阅读源码不等于运行验证，也不增加平台或安全支持声明。
