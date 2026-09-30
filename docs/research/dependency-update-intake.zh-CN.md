# 研究：经过审查的依赖更新流程

[English](dependency-update-intake.md) · [简体中文](dependency-update-intake.zh-CN.md)

- 状态：配置修改前已审查
- 日期：2026-09-15
- 相关 PR：#79、#80、#81、#82、#83
- 目标：为现有五个升级补齐真实研究和完整 CI，暂停普通版本自动提议，保留安全更新入口。
- 边界：保留研究要求、全部测试和分支保护；安全升级同样需要审查，不自动批准或合并。

## 证据与选型

检查主分支 `87987d9d3b47238cf2b1d23fb5e03557d78938ab` 的研究检查、贡献指南、复用记录和 Dependabot 配置。五个 PR 都因正文缺少 `Open-source research` 而失败；另外八项任务已通过，最终汇总按规则失败。主分支 CI 正常。#78 中的配置变更在 UTC 12:31:21 触发了新扫描，随后创建五个 npm PR。

搜索 `site:docs.github.com dependabot disable version updates open-pull-requests-limit 0 security`，查阅官方触发规则、配置选项与安全更新说明。固定配置协议 v2、GitHub REST API 2022-11-28，托管服务文档审查日期为 2026-09-15，无需引入本地依赖。

| 候选 | 判断 |
| --- | --- |
| 官方 `open-pull-requests-limit: 0` | 选用：暂停相应生态的普通版本 PR，安全更新不受此上限约束 |
| 调低频率、分组或上限改成一 | 只能减量，仍会创建缺少研究的提议；修改配置还会即时扫描 |
| 对机器人跳过研究或自动声称已审查 | 拒绝：自动发布说明不能证明已完成源码、许可、风险和兼容性检查 |
| 关闭漏洞扫描和安全更新 | 拒绝：会丢失漏洞信号 |

## 实施约束

npm、GitHub Actions 和 Docker 的普通版本 PR 上限设为零，保留生态声明、React 分组、默认主分支与 Docker Node 主版本限制。现有 PR 经过真实审查、保留提交历史并通过完整检查后再合并，不通过关闭 PR 隐藏失败。

贡献指南明确：先选择有限批次，核对已有复用记录和精确上游版本，记录研究，再修改依赖和精确锁文件，填写 PR 七项研究字段，完成干净安装和完整 CI。待有持续维护的审查流程后再恢复普通自动提议，并说明配置修改会即时扫描、上限指同时开放数量。

仓库 API 显示漏洞提醒及安全自动修复此前关闭。应分别启用并核实，这与普通版本上限为零独立；不改其他安全扫描设置、不增加高权限工作流。安全 PR 仍须完成研究和 CI。

随后已启用这两个开关，安全自动修复 API 返回 `enabled: true`、`paused: false`。初始提醒清单仅有一条既有开发依赖 esbuild 的中等风险 `GHSA-67mh-4wv8-2f99`，此前基线已存在。本流程变更不声称修复该漏洞；生产依赖审计与既有开发工具限制仍需独立核验。

## 验证与来源

未复制或实质改写上游源码，仅采用 GitHub 官方托管配置。核实三个零上限、既有分组与忽略规则、安全开关、正文研究检查及 `npm run check`，并等待最终 PR 和主分支完整云端检查。不增加平台支持或产品权限声明。

主源：[触发行为](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-pull-requests)、[PR 上限与安全更新豁免](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#open-pull-requests-limit)、[安全更新配置](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-security-updates)。

## 清理任务的漏洞核查（2026-09-29，PR104）

`8b5c4d3` 完整审计的五项 moderate 是两条漏洞链：四项为 Drizzle 旧 loader 的 esbuild
提示，一项覆盖三处 undici。生产审计干净不等于开发和测试无风险。已读实际依赖链、锁定条目、
消费源码及上游修复，逐项依据见[英文核查表](dependency-update-intake.md#cleanup-advisory-review-2026-09-29-pr104)。

- esbuild0.18.20 的服务接口存在跨源读取风险，绑定回环也不能消除；实际 core-utils3.3.2
  只调用 transform/transformSync。Drizzle0.31.10 的实际 CLI/API 已使用 tsx，不再导入
  esm-loader2.6.5，但发布的依赖声明仍安装它。
  当前 Vite/tsx/oracle 使用0.28.2，Drizzle 直接依赖为0.25.12。四个提示保留明确限制，
  不跨0.x版本强制覆盖，也不接受 npm 建议的 Drizzle0.18.1 回退。后续应由兼容上游版本或
  验收后的 CLI 替代退出旧 loader；迁移命令和 SQL 历史保留。
- jsdom30.0.1 确实向测试页面提供 undici WebSocket，恶意压缩帧可能导致进程退出，不能因其
  是开发依赖便忽略。Electron 下载者使用 HTTP/proxy，产品 Node 使用独立 ws。选择现有父依赖
  范围内的 undici8.10.2/7.29.1 补丁；不增加直接依赖、全局 override 或改变运行时要求。
  已读精确发布提交、MIT 许可、inflater 修复和畸形帧回归。锁文件修复不更新 Node 自带的 undici。

安装、回归和最终审计结果绑定提交记在 PR104；不把路径分析或上游自报当作实测通过。
官方0.31.10发布说明与已安装源码一致；核对的0.31.11发布清单仍声明旧 loader，单纯升级
该补丁不能清除漏洞。[上游问题5145](https://github.com/drizzle-team/drizzle-orm/issues/5145)
标记 fixed-in-beta，不代表稳定版已兼容修复。需一起验证真正发布的依赖闭包与迁移消费者。
