# CI 影响范围报告

[English](CI_IMPACT.md)

CI 会在现有验证任务的摘要中增加一份建议性影响报告。所有安全、仓库、跨平台、原生 Worker、数据库和容器检查仍然执行，并且仍是必需检查。报告帮助开发者先选择本地反馈命令，不能批准变更或跳过检查。目前尚未测量加速效果和识别准确率。

## 本地运行

执行 `npm ci` 并提交要比较的改动后，运行：

```sh
node scripts/report-ci-impact.mjs --base origin/main
node scripts/report-ci-impact.mjs --base HEAD~1 --json
```

默认结束点是当前检出的 `HEAD`。只有 `--head` 解析为同一个提交时才接受该参数，因为 Turbo 使用当前工作区的依赖图。存在未提交文件时，报告建议 `npm run check`：这个版本只分析提交区间，不声称完整分析了工作区改动。默认输出 Markdown；`--json` 输出相同的建议数据。找不到引用、历史过浅、缺少 Turbo 或输出不兼容时，也建议全量检查。报告不会自行获取 Git 历史或安装依赖。

CI 中，PR 使用事件中的目标分支 SHA 与当前检出的合并提交，以两者的 merge base 为比较起点。push 使用上一次 SHA。现有 checkout 保留完整历史。首次 push 没有前序提交或事件无效时，回退到全量建议。Fork PR 继续使用相同的 `pull_request` 流程、只读权限、不持久化 checkout 凭据，不增加 secrets、外部 Action、评论 API 或远程缓存。

## 如何理解报告

| 范围 | 含义 | 建议的本地验证 |
| --- | --- | --- |
| `focused` | 每个改动路径均属于已审查的局部源码范围；Turbo 识别模块、依赖它的模块以及需要构建的依赖 | 根目录 lint，加报告中带模块筛选的 Turbo `typecheck test build` 命令 |
| `full` | 广泛影响的路径、未知路径或分析失败使局部建议不成立 | `npm run check` |
| `unchanged` | 选定的提交区间没有变化，Turbo 也给出一致结果 | 交接仍要求 `npm run check`，不会跳过检查 |

报告复用已安装、固定版本的 Turborepo `--affected --dry=json`。它不另建 workspace 依赖图、不执行包脚本，也不信任 Turbo 返回的命令字符串。建议命令保留依赖构建，并将并发限制为二。

只有现有 Web、Desktop、各 Provider、logging、Provider conformance runner 和 office-plugin workspace 内的源码文件可能获得局部建议。这不扩展暂缓的 office 插件。即使在这些目录中，权限相关文件名仍会扩大范围。未知路径、新 workspace、删除的 workspace 和不完整的 Turbo 身份信息均回退到全量。

Server、Node、原生 Worker Host、protocol/domain 契约、policy、数据库及迁移、config、Provider SDK 和凭据保护始终需要全量验证。依赖清单、锁文件、构建或工具配置、CI、脚本和部署输入同样扩大到全量。文档也不会自动归为安全修改：文档可能改变支持声明或契约。这套保守规则只是建议的起点，不能证明所有跨模块影响都已进入 npm 依赖图。

## 验证与后续改进

```sh
node --test scripts/report-ci-impact.test.mjs scripts/check-security-workflow.test.mjs
node scripts/check-security-workflow.mjs
npm run check
```

Fixture 在临时 Git/npm workspace 中运行实际固定版本 Turbo，覆盖反向依赖、重命名和删除、不安全身份、事件和基线选择、未提交或缺失历史、工具缺失以及保守的扩大范围规则。原生平台和真实服务的验证仍由原有 CI 任务提供，这些 fixture 不替代它们。

未来若要使用报告省略检查，必须先收集报告和全量 CI 结果，调查缺失的依赖边并测量实际任务耗时，再单独审查策略变化。当前工作流不会将报告输出用于任务条件或矩阵。

固定版本、源码与复用依据见[研究记录](research/2026-09-22-ci-impact-shadow.md)。
