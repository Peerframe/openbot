# Chromium/runsc 边界实验

**固定镜像的 Linux/runsc CDP 组件于2026-09-25实测通过。** 已授权的单次测试取得合成页面真实DOM与PNG、同profile重开、内层沙箱诊断及原生期限／清理证据，见[有界实测记录](REAL_CDP_RESULT.json)。这不启用产品浏览器能力，也不代表egress、Employee profile权限或人工接管通过。见[研究](../../docs/research/browser-cdp-qualification.zh-CN.md)及[此前b2失败记录](../linux-execution/REAL_BROWSER_CHROOT_ATTEMPT.json)。

## 从干净检出运行边界测试

需要仓库支持的 Node 版本（内建 zlib CRC32）和 Python3.9+。不需要 npm 依赖、凭据、浏览器下载、Docker、SSH 或 root：

```sh
npm run test:browser:boundary
```

命令运行15项 Node 合成 CDP/产物测试、25项 Python 命令/权限/预算测试，现有 Python/Linux CI 使用同一入口。它不调用 wrapper 可执行入口，也不启动浏览器或容器。

wrapper 优先使用显式远端包中的完整同级 `reviewed/`；仅在该目录不存在时使用准确兄弟目录 `../linux-execution`。已存在但残缺的 `reviewed/` 直接拒绝，不搜索任意目录。三份 helper 没有复制进来，仍检查原已审 hash。`fixtures/v3-construction.json` 是从旧 OpenBot MIT wrapper 的纯构造函数生成的数据，带原源码与 hash 来源；它取代临时包中重复的历史可执行代码，保留原命令/配置边界回归。

## 候选约束

使用固定 Playwright1.62.1 noble linux/amd64 镜像、Chromium151.0.7922.34 和之前实际观测到的 Node24.18.1；详见 [PINS.json](PINS.json)。最终镜像已移除临时 Playwright SDK，本探针使用 Chromium 的既有 CDP ASCII-NUL 管道及 Node 内建流，不新装 SDK、不开放调试 TCP、不另造协议。

合成页面只在 network-none guest 中，验证加法25、中文、cookie 和 localStorage。首轮须得到实际 DOM、1280×800 PNG、内部 namespace/PID/NET/seccomp 诊断，并正常关闭，才可第二次启动确认同 profile 持久化。任何失败/未知均不重发超时请求、不进入第二次启动；内部诊断用首轮的新 target。

保留 UID/GID1001、drop-all、NNP、只读根、私有 IPC、network=none、资源/日志限制、systrap 及**实际** OCIseccomp=true 核验。profile 仍为已审实验 clone3/chroot 派生版本，SHA256 `d00ad84f5a67031fe2bb64de8d77a5ad9c06adb82935ebdb3c18b5f7ba60a5d0`。它相对官方 profile 增加 guest syscall 权限，未获生产采纳；CDP 候选不继续增权。见[修改声明](DERIVATIVE_NOTICE.md)。

原生 unit 硬期限仍180秒。唯一 start 前至少剩85秒：10秒启动、65秒 guest、10秒最终核验。主流程共用58秒绝对期限，失败取证截至62秒，watchdog65秒。时间不足拒绝启动，不续期、不换身份。wrapper 始终核验原 Invocation 的到期和清理。

## 实际证据与限制

之前 b2 观测到15个 Chrome 进程 NNP1/Seccomp2、无关闭沙箱参数，但首轮 CLI 被25秒计时器杀掉，未保留 DOM/PNG，未通过渲染验收。源码表明 CLI 在整个虚拟时间/截图流程结束后才输出 DOM；这是取证缺口，不足以认定 b2 根因。独立 Mac CDP 实测收到前置方法直到 viewport 的响应，但 localhost 导航超时，DOM/PNG/profile 重开未通过；Mac 显示错误不能当 Linux 原因。

新记录为 `openbot-browser-runsc-compatibility-CDP`、version1，安全投影器须识别新版，不能沿用旧三轮 CLI 索引。`stages[]` 记录真实单调起止/耗时和错误码；`runs[]` 至多0/1，含退出/关闭和有限进程观测，不含全 argv。`artifacts.page`、`.sandbox` 将实际 DOM/PNG、尝试标记、字节/hash 在取得时保存，后续失败不丢弃，缺证仍缺证。`screenshot` 只有元数据，`sandboxText` 来自实际内部诊断；进程 seccomp 不代替内层沙箱证明。host 回执记录真实命令耗时及相对确认启动的偏移，启动前为 null，不反推 b2 缺失历史。

上限：DOM16KiB、PNG192KiB（CRC及有界像素解压）、单 CDP frame384KiB、每浏览器 wire2MiB、stderr尾8KiB、子进程输出128KiB、最终 JSON512KiB。越界拒绝；记录过大时移除正文、留元数据/hash 并拒绝通过。远端只能导出另行批准的安全字段，不导出 raw stderr、完整 argv、凭据或生产内容。

## 真实执行是单独门槛

这些文件不部署宿主，也不授予执行授权。wrapper 保留已审资格测试站点的固定路径、单次身份和 reservation，不是通用安装器。真实验证须另行具备授权宿主、精确镜像/archive/binary、root-owned 输入、独占窗口、余量、生产 before/after、原 Invocation/cgroup 清理。未知不能换名字重试或放宽沙箱。npm/CI 不含远程命令。

CDP framing 窄适配自 Playwright1.62.1；保留 [Apache许可](playwright-LICENSE)、[NOTICE](playwright-NOTICE)、[修改声明](DERIVATIVE_NOTICE.md)和[上游来源hash](UPSTREAM_SOURCES.json)。OpenBot 编排与测试沿用仓库 MIT。
