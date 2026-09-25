# 研究：固定镜像 CDP 浏览器验收

- 状态：离线边界候选；Linux 浏览器验收未完成
- 日期：2026-09-25；负责人：OpenBot contributors
- 关联：[Linux 浏览器研究](linux-browser-qualification.md)、[会话迁移](python-browser-sessions.md)、[复用台账](../OPEN_SOURCE_REUSE.zh-CN.md)
- 验收：另行授权的一次180秒原生窗口内取得合成 DOM/PNG、profile关闭重开、内部 namespace/seccomp 诊断，再确认原 Invocation 清理及生产不变。
- 安全：Server 权限不变，不信任模型/网页/浏览器/Worker输出，不启用产品能力，不增加 syscall/capability/network 权限或关闭沙箱。

## 搜索证据

研究先于临时包实现，本次整合固定成果。[上游索引](../../experiments/browser-execution/UPSTREAM_SOURCES.json) 保留 URL/字节/SHA；一次猜测测试路径404明确不作证据。2026-09-25 查阅 gVisor Chromium hang、Playwright dump-dom screenshot 的 GitHub 结果及固定 Chromium command/CDP、Playwright镜像/transport/launch/tests、Node zlib 和已有台账。

[Chromium JS](https://github.com/chromium/chromium/blob/151.0.7922.34/components/headless/command_handler/headless_command.js#L315) 的 timeout 只竞争页面加载，另等虚拟时间再处理 DOM/截图；[C++](https://github.com/chromium/chromium/blob/151.0.7922.34/components/headless/command_handler/headless_command_handler.cc#L384) 等完整 Promise 后才输出 DOM。这是取证缺口，不证明 b2 根因。

[最终镜像](https://github.com/microsoft/playwright/blob/v1.62.1/utils/docker/Dockerfile.noble) 移除临时 SDK。固定 [pipe选择](https://github.com/microsoft/playwright/blob/v1.62.1/packages/playwright-core/src/server/browserType.ts#L278)、[framing](https://github.com/microsoft/playwright/blob/v1.62.1/packages/playwright-core/src/server/pipeTransport.ts)、[Chromium pipe](https://github.com/chromium/chromium/blob/151.0.7922.34/content/browser/devtools/devtools_pipe_handler.cc)、PDL/类型/tests确认 stdio3/4 ASCII-NUL CDP，未复制关闭沙箱的默认 flags。

已读 [gVisor7416](https://github.com/google/gvisor/issues/7416)、[14408](https://github.com/google/gvisor/issues/14408)、[Playwright41532](https://github.com/microsoft/playwright/issues/41532) 和固定 systrap 源码；它们不证明本组合不兼容或截图必成功。b2 无 syscall/stack归因。已见 netlink 错误会走 `AbortAndForceOnline()` 返回，不能据此放宽网络。

## 候选比较与复用决定

选 Chromium151.0.7922.34 已发布 CDP 标准接口加薄适配。Playwright1.62.1（Apache-2.0）持续维护、有测试，但镜像不保留临时 SDK，因此只复用 framing，不另装 SDK。CLI 聚合输出不适合此次诊断，不代表参数无效。runsc release-20260914.0／95eb5d5930b0e7736826cc2cb949ba9d2c4d5d29 和镜像 Node24.18.1 保留。

probe限定方法、真实session/frame/loader、绝对预算和大小，未知不重发；原实验 clone3/chroot profile 字节不变并区别官方版本。helper只允许同级完整 `reviewed/` 或准确兄弟 `linux-execution`；残缺拒绝、不搜索、不复制。V3旧wrapper改为带来源/hash的MIT构造数据，不留第二份执行实现。40项测试复用Node内建/Python unittest，经独立npm及已有Python/Linux CI步骤，不增依赖/lockfile。

升级须另审固定版本和实际Linux证据；正式产品/SDK具备同等取证后可删除本临时探针，不作为产品API。helper/hash不符、协议失败、预算不足、start未知、证据不全均拒绝，不换身份重发。

## 源码与许可证

CDP framing窄适配Playwright1.62.1 `pipeTransport.ts`，保留Google2018/Microsoft Apache声明、LICENSE、NOTICE、修改说明；seccomp派生策略沿用相同许可。Chromium（BSD）、gVisor（Apache）、Node只读研究，不复制实现。native helper/V3 fixture来自OpenBot MIT；不分发新二进制或包。

固定 [Node zlib](https://github.com/nodejs/node/blob/v24.18.1/doc/api/zlib.md#L1152) 提供CRC32和有界inflate，用于有限1280×800像素检查，无需新PNG库，不宣称通用图像清洗。

## 验证与未决项

`npm run test:browser:boundary` 为15项Node合成流和25项Python边界测试，不启动浏览器/容器/SSH；覆盖错误帧/上限、session、无重发、生命周期、PNG失败保留DOM、诊断session、CRC/像素、固定配置/helper、Unix路径、残缺加载和真实耗时记录。中英README明确证据等级。

b2到达Chrome，但25秒CLI被杀、渲染未通过；独立Mac到viewport后导航超时，不代表Linux兼容。缺失历史不补推。实际Linux/runsc的CDP、DOM/PNG、profile重开和内层沙箱尚未通过；egress、产品权限/profile与接管另验。仓库整合不隐含上传或执行授权。
