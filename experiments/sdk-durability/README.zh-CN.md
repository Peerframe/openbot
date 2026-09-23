# 官方 SDK 与持久引擎组合验收

[English](README.md) · [简体中文](README.zh-CN.md)

本实验固定 Pydantic AI **2.47.0**、DBOS **3.0.0**、Temporal Python **1.33.0**，调用官方
`DBOSDurability` / `TemporalDurability`，使用确定性模型、真实杀进程重启、一次性 PostgreSQL
和父进程独立计数的本地服务。复用已有引擎实验夹具，没有接入产品派发器。

## 运行

需要 Python 3.12+、Docker、POSIX，以及[引擎实验](../durable-execution/README.zh-CN.md)中
校验过的官方 Temporal CLI1.9.1。只在独立虚拟环境安装：

```sh
python3 -m venv /tmp/openbot-sdk-probe-venv
/tmp/openbot-sdk-probe-venv/bin/python -m pip install -r experiments/sdk-durability/requirements.txt
/tmp/openbot-sdk-probe-venv/bin/python -B experiments/sdk-durability/probe.py --temporal-cli /path/to/verified/temporal
```

`--engine dbos` 不需要 Temporal 程序；`--engine temporal` 只运行对应实验。
`--keep` 保留合成日志、配置和结果以便核对，但仍销毁自己创建的进程与容器，临时数据库凭据随之失效。
默认同时删除临时文件。父进程遭 SIGKILL 可能跳过清理；只能清理明确属于此实验的资源。

## 检查范围

| 场景 | 必须观察到的结果 |
| --- | --- |
| DBOS 普通函数，在下一次模型结果保存前崩溃 | 读取执行两次，作为负例 |
| DBOS 显式持久步骤，同一崩溃点 | 读取一次，已保存的首个模型请求一次 |
| Temporal 普通函数，同一崩溃点 | 官方活动包装使读取只执行一次 |
| 两种引擎在 SDK 延后执行边界退出 Worker | 无 Worker 时提交的决定可恢复，写入一次 |
| 两种引擎恢复前撤权 | 无写入，无最终模型调用 |
| DBOS portable 工作流 | 工作流采用 portable JSON，当前 SDK 模型步骤仍为原生 pickle |
| 每个成功案例重复使用已完成引擎 ID | 返回已有结果，不增加模型或工具操作 |

在模型结果尚未保存时崩溃，实际观察到 **四次请求尝试**，而 SDK 只计 **三次已完成请求**。
这不等于只产生三次账单；共享预算与未知费用仍须由控制层维护。

父进程不会仅凭 waiting 文件断言进入持久等待：DBOS 另查等待步骤已提交，Temporal 查询工作流等待状态。
DBOS 证明的是持久延后执行边界，不是定位到 `recv` 内部某条指令。
Temporal 编码检查只覆盖 **activity 返回值**，没有声称覆盖所有历史、输入或标记。

## 限制与下一步

策略与受信工作流同进程，尚未接上现有 Runtime 的 stdin/stdout 进程协议。DBOS 原生 pickle 只用于本实验
合成可信历史，不是已批准的产品检查点格式。Temporal 服务仍使用开发 SQLite，领域夹具使用 PostgreSQL，
不构成生产存储同条件比较。

实验决定没有完整内容绑定与期限，读权限后发送也不能解决并发撤权。尚无产品权限、共享预算、派发桥、
未知写入核对、Artifact 发布、真实模型、浏览器或执行隔离；没有选定生产引擎。

下一次以 Temporal 官方适配器与受信工作流策略模块完成参考流程，接现有控制层 Task/Run/Action、模型/工具
权限和产物发布。重点证明提交到派发之间的故障，以及丢失回执后通过真实查询核对假服务写入。
DBOS 加官方 deferred/JSON 分段接口继续保留为候选。见[研究与决定](../../docs/research/sdk-durability-integration.md)。
