# Python 控制层记忆与技能选择接口

[English](SELECTION_PORT.md) · [简体中文](SELECTION_PORT.zh-CN.md)

状态：已实现独立参考接口，尚未注册到产品。沿用已验收提交 `5d838b5` 的检索、生命周期、
作用域与来源逻辑，保留 Hermes Agent 对审核学习和来源追踪方向的启发。
英文文档记录了实现前的复用研究、固定版本与主线只读核对。

## 调用契约

异步 `SelectionPort` 提供 `select(task_id, run_id, query)` 和
`revalidate(task_id, run_id, query, receipt)`。每次调用均通过控制层提供的异步加载器，
读取当前 Task/Run 身份、修订号、有效状态和作用域。构造接口不会调用加载器。
调用参数不接受模型填写的 scope、角色或权限。

结果为不可变记忆内容和技能 Markdown，以及绑定以下信息的选择凭据：

- 目标 Task/Run/修订号与 Owner/Bot/workspace/task kind；
- 查询 SHA-256；
- 记忆 ID/修订号/内容摘要，以及来源 Task/Run/Artifact/纠正；
- 技能 ID/版本/分配修订号/内容摘要/精确审核摘要，以及相同的来源信息。

记忆修订号就是其版本；技能审核摘要沿用原实验整体摘要，与 SKILL.md 内容摘要分别记录。
选择凭据仅描述已选内容，不产生权限，也不能证明模型实际消费了内容。
它含有内容摘要，若保存在检查点应限于控制层，不能写入原有不含内容的生命周期审计。

重新校验会加载当前目标状态并再次选择；只有凭据全部一致才返回新的内容。
暂停、撤销、删除、关闭记忆共享、来源损坏或不可用、内容/来源/版本/审核变化，
以及 Task 修订号、作用域或查询变化，都会拒绝旧结果复用。恢复后也必须取得新引用。
排序变化可能保守地使旧凭据失效；调用者需要重新构建上下文，不能在异常后沿用缓存。

记忆共享与技能审核仍是独立决定：关闭记忆共享会移除记忆项并使旧组合凭据失效，
但单独通过审核的技能仍可能在新一次选择中返回。暂停或撤销技能也会阻止其衍生记忆返回。
写入端必须在停用、重新启用时持续增加修订号；读取端无法发现未被记录的中间状态。

最多返回 4 条记忆和 1 个技能，序列化结果不超过 32 KiB；原有查询 512 字节、
记忆 2000 字节、技能 12 KiB、来源 CSV 4096 字节上限继续适用。
凭据是 Python 进程内类型，不是新的 HTTP 或签名检查点格式；任意 JSON 会被拒绝。
`Selection.to_dict()` 仅返回独立副本，便于检查或受控保存。

## 来源与接入边界

适配器复用现有选择规则，将已选来源与夹具中当前已完成任务事实及产物字节核对。
这是单一合成来源解析器；产品替代实现必须在当前访问检查下解析权威来源。
此前已经返回的内容无法收回；调用者强制执行重新校验，才能阻止后续使用。

只读核对了主线 `6f69be91185a08350ca52964c3f0543ef51f0020` 的 Task/Run/Artifact 模型、
认证路由和受信完成发布。主线已有这些基础能力，但 work 完成接口仍没有专属知识引用参数，
workspace/task kind 也还不是其公开字段。主线及其无关改动均未修改。

主控接入时仍需提供：认证后的目标加载器、真实作用域/来源读取、单调修订号，
以及上下文使用和最终发布前的串行化重新校验。“检查后再执行”本身不构成原子授权。
当前适配器属于受信单进程夹具，没有添加产品 hook、SQL、引擎 Activity、Runtime 工具、
权限、全局注册或默认服务。本工作包未提供已授权的真实模型配置，因此没有运行真实模型。

## 复现与调用

模块位于实验目录，不需要安装包。CLI 使用异步合成控制加载器和原留出数据：

```sh
python3.12 -B -m unittest discover -s experiments/s5-memory-skills -p 'test_selection_port.py' -v
python3.12 -B experiments/s5-memory-skills/selection_probe.py
```

Python 控制层将此目录加入自己的模块搜索路径后，可按以下方式调用：

```python
from selection_port import OfflineSelectionPort, SelectionPort

port: SelectionPort = OfflineSelectionPort(existing_fixture_control, trusted_async_target_loader)
selected = await port.select(task_id, run_id, query)
current = await port.revalidate(task_id, run_id, query, selected.receipt)
# 控制层检查通过后，仅将 current.memories/current.skills 作为不受信上下文。
```

加载器必须返回 `TaskBinding`，包含当前已认证范围和有效状态。
产品适配器及事务归属由主控确认；不能直接把夹具注册为生产服务，也不能从任意请求文本推断授权范围。

## 实际验证与交接

macOS / Python 3.12.13 下，15 项新增异步契约测试通过。
实际 `selection_probe.py` 经选择和重新校验后通过原有 3 项留出案例；
10 次调用均读取目标加载器，选择操作不新增审计事件，模拟权限仍为原来的两项，
且暂停、恢复、终态撤销、删除均使旧凭据失效。
完整合成结果见[接口证据](evidence/selection-port-result.json)。

原 `study.py`、`probe.py`、训练/留出数据及 16 项测试的验收内容保持原样。
按并行工作要求，本轮没有重跑未受影响的旧单元测试或产品大套件，保留先前证据。
真实模型未运行。`npm run docs:check` 检查 405 个 Markdown 文件通过；
`node_modules/.bin/biome check experiments/s5-memory-skills` 检查其支持的 4 个 JSON 文件通过；
`git diff --check` 通过。Python 行为由上述定向测试验证，Biome 不检查 Python。

剩余依赖为认证后的目标/来源读取、生命周期修订号、正式范围字段，
以及上下文组装与发布中的串行化检查。本交付提供可调用接口和反例，不代表产品接入或 S5 完成。
