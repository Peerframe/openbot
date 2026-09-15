# 调研：等待跨平台 CI 全部完成后才允许合并

- 状态：批准实施
- 日期：2026-09-15
- 负责人：OpenBot 维护者
- 关联：PR #71 验收复查、PR #72 后续修复
- 验收：只有全部必要任务成功（包括 Windows 安装），受保护的 `check` 才成功。
- 边界：保留只读 CI，不增加发布、秘密、特权触发器或失败豁免。

## 实施前依据

2026-09-15 搜索 `actions runner needs result matrix failure skipped`，查阅 runner 问题 [#2205](https://github.com/actions/runner/issues/2205)、[#1540](https://github.com/actions/runner/issues/1540)、[#3041](https://github.com/actions/runner/issues/3041)，以及 GitHub 官方[必要检查排错](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)、[任务依赖](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds)、[needs 上下文](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#needs-context)。文档仓库固定到 [`90b9608d97646e302f555f3183e36708bad7a3fb`](https://github.com/github/docs/tree/90b9608d97646e302f555f3183e36708bad7a3fb)。复核现有复用账本、跨平台 CI 调研及工作流检查器；原 `check` 只包含 Linux 基础校验，可能早于 Windows 完成。

## 候选和决定

优先复用 GitHub Actions 原生 `needs`、`always()` 和明确的结果检查，不新增 action 或依赖。官方文档采用 CC-BY-4.0、示例代码采用 MIT，服务有持续维护和公开问题记录。沿用已审查的 checkout `3d3c42e5aac5ba805825da76410c181273ba90b1` 和 setup-node `820762786026740c76f36085b0efc47a31fe5020`（均为 MIT）；汇总任务不需要 checkout 或安装。也可以把每个平台的显示名称单独设为分支保护条件，但那会让仓库设置与矩阵名称重复维护，故选择稳定的单一汇总名称。

原 `check` 改名为 `validate`。新增最终 `check`，依赖 `security`、`validate`、`portable`、`windows-worker-host`、`database`、`server-container` 六个定义，即已有九次执行。使用 `if: always()`；只接受每项结果为 `success`，失败、取消、跳过、缺失和未知结果均失败。保留矩阵完整执行和禁止忽略错误的要求。

本地差集仅是任务清单和成功断言。现有校验器检查所有非汇总任务都进入依赖清单，测试执行工作流中的真实 shell 片段。未来新增任务须加入清单；上游故障不能变成成功。分支保护须另查实际仓库设置，修改 YAML 不等于修改远程设置。

## 来源与验证

未复制或实质改编上游源码，无新增分发声明。测试覆盖全成功以及逐项失败、取消、跳过、缺失和未知状态，并拒绝遗漏任务、删除 `always()`、允许忽略错误等改动。运行现有检查器与完整仓库检查；合并前须观察 PR 最后一次提交的所有远程任务和最终 `check`，不能用本地测试冒充 Windows 安装或远程调度验收。贡献说明中英文同步，不新增平台支持声明。

现有 Server 容器校验器假设其任务是最后一个 YAML 任务。新增汇总任务后，后者的 `ubuntu-latest` 被误认成容器运行器。提取范围应止于下一个同级任务；测试证明相邻内容既不会误触容器限制，也不能冒充容器内缺失的必要步骤，原限制全部保留。
