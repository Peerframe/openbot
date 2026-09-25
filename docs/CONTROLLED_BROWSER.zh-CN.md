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
   拒绝、过期、取消、按钮重名、画面变化或人工接管都会阻止点击。
4. 结果包含操作后画面与 PNG 文件，接口必须确认同一引用和 URL。
   响应不确定时不重试；再次提交任务前先检查浏览器，因为上次点击可能已经发生。

## 边界与证据

允许站点列表不等于网络出口隔离。截图一致不能证明 JavaScript 行为，也不能阻止按钮触发跳转。
浏览器侧出口限制完成前，只使用行为已知、仅影响本地显示的可信测试页面。
尚未增加输入文字、Shell、任意代码、模型选择动作、自动重试、签名单次执行凭据、全局独占控制，
也不代表原生 macOS/Windows/Linux 桌面控制已支持。上游人工接管状态可以否决操作，不能授予 Server 权限。
同一 Bot 的操作串行限制仅作用于单个 Provider 实例。

固定依赖、实际验证与后续平台门槛见 [研究记录](research/controlled-browser-click.md)
和 [Provider 验证](PROVIDER_CONFORMANCE.zh-CN.md)。

## Python 迁移候选：浏览器会话身份

独立的 Python 候选将每个浏览器视图绑定到原 Worker 注册身份和当前连接，并在 Server 重启后保留宿主身份。
同一 Worker 重连后可以新建视图；设备重新注册，即使沿用相同 Node ID，也不会自动获得原浏览器或登录状态。
缺少已验证身份绑定的旧浏览器记录会被拒绝。本候选尚不提供浏览器重新绑定或登录数据迁移。

输入前、实际发送时及展示结果前，都会核对身份是否撤销或替换。不确定的输入不会重试；交还控制失败时，
持久化暂停状态继续保留。会话权限失效后，客户端会清除旧画面和未发送文本。这些检查使用真实 PostgreSQL、
HTTP/WebSocket 和合成画面，不证明实体浏览器资料持久化或网络出口隔离。完整 Work 浏览器执行链路接入前，
Python 默认配置仍关闭人工接管。详见[身份绑定研究](research/browser-host-binding.md)。


## Python 候选：审批后的 Work 截图

Python 产品候选可从频道任务截取员工原有浏览器的当前画面。Owner 在现有任务 Action 界面逐次
批准截图；通过结果审核并完成任务后，才能下载原始 PNG。模型只收到文件信息，不收到画面内容，
因此此配置不能解释网页，也不能点击或输入。

该功能默认关闭，需显式配置。使用固定版本的 Worker 环境、迁移至 `0043_work_browser_profiles`
的规范数据库、私有对象与产物目录，以及现有 Temporal 产品配置。Node 在已有私有电脑地址和令牌
配置之外，设置 `OPENBOT_DOCKER_BROWSER_SESSIONS=true`。这只声明会话传输能力，不授予 Work
执行权限；仍须遵守上文的宿主与网络限制。

将 `OPENBOT_CONTROL_BROWSER_CONFIG_PATH` 指向绝对路径、非符号链接、仅当前所有者可读写
（`0600`）的 JSON 文件。它指定 1–32 个精确员工 ID 及各自已登记的原始 Node ID：

```json
{
  "version": 1,
  "routes": {
    "00000000-0000-4000-8000-000000000001": "your-enrolled-node-id"
  }
}
```

用实际 ID 替换两个示例值。员工须使用 `docker-linux` 并已配置模型连接。创建频道任务前，先以
Owner 身份打开一次该员工的浏览器视图，以建立原始宿主绑定。随后可请求：“将当前浏览器截成
PNG 文件，不解释画面内容。”被配置员工的新任务只获得截图能力；已有命令任务不会被转换。
原生任务与其他员工保留既有能力。

每份待审批请求固定当前连接与人工控制版本。连接重建、身份替换、任务取消、权限撤销、执行租约
过期或人工接管后归还，都会阻止旧请求发送。每个任务最多尝试四次，纠正任务不重置额度。
回执确认丢失时只读取原先保存的截图；证据缺失保持未解决，不重截一张替代原记录。
已接收的 PNG 保留原始内容。

系统核对 PNG 文件头、尺寸、大小和摘要；模型及结果审核只看到文件信息。截图成功不能证明网页
含义或外部操作成功。公网出口、页面交互、宿主资料迁移和默认人工接管仍不属于此候选范围。
详见[实现与验证记录](research/work-browser-capture.md)。
