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

## 验证与来源

未复制或实质改写上游源码，仅采用 GitHub 官方托管配置。核实三个零上限、既有分组与忽略规则、安全开关、正文研究检查及 `npm run check`，并等待最终 PR 和主分支完整云端检查。不增加平台支持或产品权限声明。

主源：[触发行为](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-pull-requests)、[PR 上限与安全更新豁免](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#open-pull-requests-limit)、[安全更新配置](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-security-updates)。
