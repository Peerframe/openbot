# OpenBot Python harness

[English](README.md) · 简体中文

这里是唯一活跃的 `openbot-agent-runtime` 包，保留 `openbot_agent_runtime` 导入名、现有有界
Pydantic AI 循环与可选 Temporal 组装。Python 控制层仍独占身份、权限、路由、审批、根预算、
事实及产物发布。普通 Python 进程不是操作系统沙箱，不新增恢复或授权系统。

## 开始与验证

在仓库根目录使用 Python 3.12+：

```sh
packages/harness/scripts/bootstrap.sh
npm run harness:check
packages/harness/scripts/check.sh -k catalog
npm run harness:wheel
```

bootstrap 把锁定外部依赖和本地 wheel 装入 `.venv`；构建工具单独放在 `.build-venv`。
`check.sh` 先重建并安装 wheel，再测试，避免旧安装物冒充新源码验证。`harness:wheel` 在仓库外
临时环境中安装运行闭包和 wheel，不设置源码 PYTHONPATH，运行确定性扩展范例并检查真实模块路径。
无需模型账户。`scripts/bootstrap-build.sh` 准备工具后，`scripts/build.sh` 可离线构建。

产物为 `dist/openbot_agent_runtime-0.1.0-py3-none-any.whl`，仅含包、`py.typed`、元数据与许可证。
开发 skills、测试、范例、控制层和构建工具不进入 wheel。未发布 PyPI；editable 可用于探索，
不能替代安装物及产品载荷验收。

| 环境 | 外部闭包 | 本地包 |
| --- | --- | --- |
| 基础运行 | `requirements-runtime.lock` | 精确 `distribution.lock` |
| 核心测试 | `requirements.lock` | 同一个 wheel |
| 构建／质量 | `requirements-build.lock`／`requirements-quality.lock` | 不进入产品 |
| 控制 Worker 测试 | `apps/server-python/requirements-worker.lock` | 同一个 wheel |
| 容器／Desktop 产品 | `apps/server-python/requirements-product.lock` | 同一个 wheel |

`verify_environment.py --profile dev|runtime|auto|build|quality` 比较实际安装元数据；auto 只选择
完整 dev/runtime 配置。锁仍是严格精确版本，未知格式、漂移、额外包或缺失本地包都会失败。
保留原有 pip/setuptools/wheel 解释器工具豁免。控制层用 `--worker`／`--product` 分开校验；
`derive-product-lock.py --check` 从已审阅 Worker 元数据复核生产闭包。

## 扩展入口

从包根导入公开契约、`execute_runtime`、`ToolCatalog`、`RunGuard`、`PortModel`、`PortToolset`。
沿[契约](src/openbot_agent_runtime/contracts.py)和[实际控制适配器](../../apps/server-python/src/openbot_server/work_runtime_ports.py)
阅读；worker/profile/wire 内部辅助函数不是公共扩展接口。

[只读范例](examples/read_note.py)通过现有端口读取固定合成笔记，由宿主裁决并返回规范结果，
从同一值生成模型与 UI 摘要；成功、错误和取消都清理资源。未知结果保持未知，不重试或发布。
`scripts/check.sh -k extension_example` 运行[六项回归](tests/test_extension_example.py)；不注册默认产品工具。

`openbot_agent_runtime.temporal_agent.build_temporal_agent` 是显式可选 Worker 接口；普通包导入
不加载 Temporal。Activity 工厂、固定工具标识与 replay 身份不变。普通管道子进程与可恢复 Activity
生命周期不同；前者用 `python -I -u scripts/run-worker.py` 加载安装物，后者按[仓库地图](../../docs/REPOSITORY_MAP.zh-CN.md)
准备 Worker 环境并进行真实引擎／历史 replay 验收。

## 质量与证据

```sh
packages/harness/scripts/bootstrap-quality.sh
OPENBOT_CONTROL_PYTHON=python3.12 sh apps/server-python/scripts/bootstrap-worker.sh
packages/harness/scripts/quality.sh
```

仅一个 Ruff lint/format 入口和一个 mypy 入口，覆盖核心、范例与真实控制适配器；可选 SDK 类型
由 Worker 解释器提供，不混入基础运行依赖。依赖检查拒绝控制／DB／Provider 反向导入和消费者
使用内部模块。新 Python 模块评审阈值 400 行、契约 300 行；四个现有生命周期／wire 模块在
pyproject 单列原因和固定上限，不自动刷新 baseline 接受新违规。

版本依据见[现有研究](RESEARCH.md#10-c2-installed-harness-and-contributor-tools-2026-09-27)，
当前完成度及未验证平台见[唯一交接](../../docs/REPOSITORY_UPGRADE_PLAN.md)。wheel 成功不等于
产品、原生平台或发行资格已全部通过。
