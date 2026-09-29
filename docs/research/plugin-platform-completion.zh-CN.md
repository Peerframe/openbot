
## 正式构建 CSP 修复（2026-09-11）

真实 Web 构建验收发现 data URL 代理继承了宿主的严格 CSP，内联桥接脚本无法初始化；
此前的模拟开发页面验收没有覆盖正式 CSP。复查已锁定的 ext-apps 1.7.5、
[W3C CSP3 2026-08-13 继承规则](https://www.w3.org/TR/2026/WD-CSP3-20260813/#security-inherit-csp)
和 HTML sandbox 规范后，复用现有 Vite 8.2.2 构建资产/开发中间件接口，将固定代理作为独立文档提供。
外层和内层均只设置 `allow-scripts`，不设置 `allow-same-origin`，保持不透明来源。
插件 HTML 只进入内层；宿主仍为 `script-src 'self'`，仅固定代理允许内联脚本。
不开放网络、表单、弹窗、设备、顶层导航或宿主权限；没有新增依赖或复制上游代码。
验收必须覆盖真实 MCP 插件和正式构建的 CSP，不能只凭字符串单测宣称浏览器隔离可用。

正式构建浏览器验收：真实 Server/Postgres 工作区安装独立脚手架生成的 MCP 示例后，
完成 AppBridge 初始化、点击计数与已授权资源读取。临时恶意界面探针访问宿主 DOM、
Cookie 和直接 fetch 均被阻止；撤销内容权限后关闭现有界面；工具声明改变可在更新预览中看到，
应用更新后插件停用、权限清空。以上为浏览器实测，不等同原生 Desktop 或 Windows 验收。

补充原生回归：使用现有 Electron 44.2.0、独立隐藏文件页面和实际构建的代理/CSP，
macOS 已通过初始化、宿主/代理 DOM 与 Cookie 隔离；真实监听的网络探针收到零请求。
`apps/desktop/scripts/check-plugin-sandbox.ts` 已加入 macOS/Windows CI 构建后检查。
这证明渲染器边界，不代表已安装应用的钥匙串流程或签名发行已验收。
