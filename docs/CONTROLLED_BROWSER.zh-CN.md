# 审核后点击一次浏览器按钮

OpenBot 可通过现有 Docker/browser Provider，执行任务明确指定的一次按钮点击，并经过 Server
审批、回传操作前后截图。这是默认关闭、仅面向可信测试站点的实验流程，尚未实现原生桌面输入或通用浏览代理。

## 配置与任务

按 [Node 登记](NODE_ENROLLMENT.zh-CN.md) 配对 Worker，另行运行固定版本的
[agent-computer 257c1280](https://github.com/CopilotKit/openbot/tree/257c1280d684089be9adb0b35cce262efc7064bf/agent-computer)。
保持服务地址私有、令牌保密，使用独立浏览器资料，不接入个人账号。每个电脑服务只连接一个 Worker。
本地测试页面可使用以下 Worker 配置：

```dotenv
OPENBOT_DOCKER_COMPUTER_URL=http://127.0.0.1:4198
OPENBOT_DOCKER_ALLOW_PRIVATE_HOSTS=true
OPENBOT_DOCKER_INPUT_ORIGINS=http://127.0.0.1:4197
```

通过已有秘密配置另行提供 `OPENBOT_DOCKER_COMPUTER_TOKEN`，修改后重启 Worker。
选择执行配置为 `docker-linux` 的员工。例如，在 4197 端口准备一个属于本次测试的页面，
其中 `Show preview` 按钮只改变本地显示，然后发送：

```text
打开 http://127.0.0.1:4197/ 并点击按钮“Show preview”
```

也支持 `Open http://127.0.0.1:4197/ and click button "Show preview"`。
任务必须包含一个 URL 和一个带引号的准确按钮名称。允许站点配置使用完整 origin，不带路径或末尾斜杠，
逗号分隔、最多十项，仅接受 HTTPS 或 HTTP `127.0.0.1`。允许私网仅用于隔离本地测试。
未配置允许站点时，Worker 不声明 `browser.input@1` 能力。

## 审批与结果

1. Worker 打开页面，展示当前画面，识别唯一且可用的同名按钮。
2. Server 核对任务网址、按钮名、执行身份及 `browser.click` 高权限策略。
   打开待审批任务详情查看执行画面，检查网址和按钮，在两分钟内批准或拒绝。
3. 批准后，Worker 再核对浏览器控制权、截图和 URL，使用原始元素引用及快照版本只尝试点击一次。
   拒绝、过期、取消、按钮重名、画面变化或人工接管会阻止尚未派发的点击。
4. 结果包含操作后画面与 PNG 文件，接口必须确认同一引用和 URL。
   响应不确定时不重试；再次提交任务前先检查浏览器，因为上次点击可能已经发生。

## 停止电脑任务

queued、assigned、running、waiting_approval 的电脑任务详情支持**停止任务**。
沿用仅 Owner 可调用的 `POST /api/v1/runs/:runId/cancel`，要求受信任的变更 Origin 和严格的 `{}`。
只有取消审计与待定审批失效提交成功后，接口才返回 `{ run }`。重复取消返回同一终态，
不重复写取消事件。任务不存在返回 404；已完成、失败或阻塞的任务返回 409，保留原有结果和产物。
原生任务仍保持既有的子任务取消语义。

待定审批改为 `expired`，审计记固定原因；已经批准的决定仍保留 approved 历史。
旧审批决定返回 409，不能恢复任务。Node 断线或 Server 启动恢复时，中断的 running 和
waiting 任务直接失败，待定审批在同一事务中过期。此单 Server 恢复不自动重试或续跑。

取消先撤销接收后续进度、完成结果和产物的权威，再请求 Node abort。Provider 清理完成前
继续占用本机 Node 容量；清理结束会唤醒排队任务。外部动作如果已经发送，可能已经发生，
也可能继续完成。running/waiting 取消在审计中记录 `externalOutcome: unknown`。
取消响应只证明 Server 已决定停止，不能证明远端回滚或收到取消确认。
再次创建任务前先检查外部系统；未增加 Worker 重试按钮或自动重派发。

## 边界与证据

允许站点列表不等于网络出口隔离。截图一致不能证明 JavaScript 行为，也不能阻止按钮触发跳转。
浏览器侧出口限制完成前，只使用行为已知、仅影响本地显示的可信测试页面。
尚未增加输入文字、Shell、任意代码、模型选择动作、自动重试、签名单次执行凭据、全局独占控制，
也不代表原生 macOS/Windows/Linux 桌面控制已支持。上游人工接管状态可以否决操作，不能授予 Server 权限。
同一 Bot 的操作串行限制仅作用于单个 Provider 实例。

固定依赖、实际验证与后续平台门槛见 [研究记录](research/controlled-browser-click.md)
和 [Provider 验证](PROVIDER_CONFORMANCE.zh-CN.md)。
