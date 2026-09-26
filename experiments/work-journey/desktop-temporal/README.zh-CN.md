# 包内 Desktop Temporal 连接探针

[English](README.md) · [简体中文](README.zh-CN.md)

这个一次性验收工具复用原有 `NativeServerController`、`launchPythonProductServer` 和包内 Python／Temporal SDK，验证未修改的 macOS arm64 Python 候选。不会创建引擎、提交 Task、调用模型、访问 Keychain 或使用真实 Desktop 用户目录。

构建候选后，先核对编译的 `native-server.js` 和 `python-server.js` 与应用 ASAR 中的字节相同。提供一个已运行的可信 mTLS Temporal 服务、现有 namespace 和当前用户拥有的私有配置文件：

```sh
node experiments/work-journey/desktop-temporal/smoke-packaged-temporal.mjs \
  --runtime /absolute/candidate.app/Contents/Resources/native-runtime \
  --desktop-dist /absolute/checkout/apps/desktop/dist \
  --temporal-config /absolute/private/existing-engine.json
```

三个参数必须是绝对路径。配置使用 [Desktop 候选文档](../../../docs/DESKTOP_PYTHON_CANDIDATE.zh-CN.md)中的既有 schema，包含 `temporal_address`、`namespace`、`queue` 与 `tls`。输入文件必须属于当前用户、是私有普通文件、大小为1–16,384字节。探针保留地址、namespace、TLS路径和有界可选项，仅在新的临时私有 `D/temporal.json` 中将 queue 替换为随机队列；不会改原配置、复制私钥内容或注册 namespace。

首次启动与重启均须通过真实 `/health` 和合成 Owner 登录。观察器使用包内 Python `-I -B` 与原 mTLS adapter，只读查询两种 TaskQueue 的 poller：Workflow 与 Activity 必须各有一个新 identity，且二者相同。新鲜度使用该次启动时间，忽略服务端保留的旧 poller，因此宿主与引擎时钟必须一致；不要求停止后旧 poller 立即消失。

合成 channel、bootstrap 和 model-connection key 必须在重启后保留。正常停止以及杀死一次性父进程都必须关闭实际 API、移除 PG PID 和锁文件。私有但无效的配置必须使原启动流程失败，不能退回 API-only，并释放 PG；符号链接 artifact 目录同样必须拒绝。每次结束都会停止原 controller 并删除临时目录。测试中的加密回调仅为合成夹具。

成功输出一条公开 JSON，记录两次连接、poller 数量／身份哈希和生命周期布尔结果；失败只输出固定阶段，避免泄漏私有路径、bootstrap、cookie、Worker 原始身份及子进程日志。该探针验证真实包内连接与生命周期；`fullInferenceVerified`、`workflowReplayVerified` 和 `nativeKeychainVerified` 均保持 false。

2026-09-25 的最新canonical43／63依赖包内实际运行已通过，结果见[公开记录](../evidence/desktop-packaged-temporal.json)。160个Python源文件及ASAR内controller字节与本次仓库一致。探针自身另有9项 Node 输入／文件检查和7项真实 protobuf 配合模拟 RPC 的检查，不能把这些单元检查当作真实服务证据。

在仓库根目录复现探针单元检查：

```sh
node --test experiments/work-journey/desktop-temporal/probe-support.test.mjs
apps/server-python/.worker-venv/bin/python -B -m pytest -q \
  experiments/work-journey/desktop-temporal/test_observe_pollers.py
```


当前探针还写入合法固定 `D/browser.json` 路由／页面范围文件，不登记Node、不发送浏览器动作。
两次包内Worker启动仍须真实连接引擎。保持引擎配置合法时，分别写入内容为`{}`的私有浏览器
和命令配置，必须被真实Python安装解析器拒绝、不产生Owner登录并关闭PG。结果记录
`privateBrowserConfigurationAccepted`及`invalidExecutionConfigurationsRefusedAndPostgresStopped`。
无引擎情况下不允许通过执行配置静默回退API-only，由独立API smoke验证。
