# Chromium/runsc 边界实验

**固定镜像的 Linux/runsc CDP 组件于2026-09-25实测通过。** 已授权的单次测试取得合成页面真实DOM与PNG、同profile重开、内层沙箱诊断及原生期限／清理证据，见[有界实测记录](REAL_CDP_RESULT.json)。这不启用产品浏览器能力，也不代表egress、Employee profile权限或人工接管通过。见[研究](../../docs/research/browser-cdp-qualification.zh-CN.md)及[此前b2失败记录](../linux-execution/REAL_BROWSER_CHROOT_ATTEMPT.json)。

## 从干净检出运行边界测试

需要仓库支持的 Node 版本（内建 zlib CRC32）和 Python3.9+。不需要 npm 依赖、凭据、浏览器下载、Docker、SSH 或 root：

```sh
npm run test:browser:boundary
```

命令运行15项 Node 合成 CDP/产物测试、35项 Python 命令/权限/预算/策略测试，现有 Python/Linux CI 使用同一入口。它不调用 wrapper 可执行入口，也不启动浏览器或容器。

wrapper 优先使用显式远端包中的完整同级 `reviewed/`；仅在该目录不存在时使用准确兄弟目录 `../linux-execution`。已存在但残缺的 `reviewed/` 直接拒绝，不搜索任意目录。三份 helper 没有复制进来，仍检查原已审 hash。`fixtures/v3-construction.json` 是从旧 OpenBot MIT wrapper 的纯构造函数生成的数据，带原源码与 hash 来源；它取代临时包中重复的历史可执行代码，保留原命令/配置边界回归。

## 真实出口代理策略

严格配置编译器与 Debian Squid7.7-1 在一次性 Linux amd64 `network=none` 容器中通过20项实测：IPv4／IPv6 HTTP 和 CONNECT 成功到达合成目标；17类来源、域名、端口、协议、数字主机名和禁止地址请求均返回403，目标收到零请求。测试先证明私网、元数据、管理地址及IPv6目标实际可达。解析告警或静默改写算失败；代理正常退出，容器已清理。见[安全结果](REAL_EGRESS_RESULT.json)及[研究](../../docs/research/browser-egress-policy.md)。

这只验收代理策略。直接连接、DNS重绑定、实际宿主包过滤和已有隧道撤销仍需独立验证；产品浏览器范围不扩大。干净检出可使用Docker及构建时联网复现，无需凭据：

```sh
docker build --platform linux/amd64 -f experiments/browser-execution/egress-fixture.Dockerfile \
  -t openbot-egress-fixture:local experiments/browser-execution
python3 -B experiments/browser-execution/qualify_egress.py \
  --fixture-image "$(docker image inspect openbot-egress-fixture:local --format '{{.Id}}')" \
  --output /tmp/openbot-egress-result
```

选择未存在的输出目录。执行最多150秒，随后有界清理；NET_ADMIN仅用于测试容器自己的断网空间，给loopback配置合成目标，不发布端口，不修改本机／VPS网络。必需CI独立运行此代理测试，不串在浏览器恢复后面。镜像保留Squid／Debian和Node许可证；它不是生产浏览器或Host镜像。

## 原生内核路由与已有连接撤销

提供的Ubuntu24.04／nftables1.0.9宿主已通过23项转发检查及客户端到代理端口的连接／撤销。所有目标在过滤前可达；过滤后禁止路径收到零请求，撤销准入后已建立的连接也无法继续送达。原150秒systemd单元及子进程已关闭；现有9个容器、防火墙语义和宿主转发设置未变。见[安全结果](REAL_KERNEL_NETWORK_RESULT.json)。目标使用TCP／UDP回显，不冒充代理；与真实Squid、Chromium/runsc和产品授权的组合仍需验收。

必需egress CI在一次性Ubuntu24.04 systemd runner中复现，依赖nft／iproute2／iptables及仅读取状态的Docker CLI。将 `native-network/` 三份文件复制到探针声明的固定、一次性root私有目录，再运行 `run_probe.py --docker /usr/bin/docker`。此原生检查不创建Docker容器或外部路由；不得覆盖旧结果目录或重用已消费单元。准确参数在launcher与CI中。探针修改链路／规则前必须确认自己属于原单元，且不在PID1的网络命名空间。

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

## 原生浏览器产品组合

独立600秒组合已通过真实 HTTPS Chromium／runsc／Squid、产品审批、报告／回放、
私有档案容器替换和已建立 TLS 连接撤销，原生期限自动结束，生产状态未变。见
[配对证据](../work-journey/evidence/product-browser-linux.json)及[夹具与范围](composition/README.zh-CN.md)。
此前组件结果保留原范围；不据此宣称通用公网出口或生产 Host 安装器通过。
