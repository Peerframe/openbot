# 研究：Vite 8.3 锁文件一致性

[English](vite-8.3-lock-coherence.md) · [简体中文](vite-8.3-lock-coherence.zh-CN.md)

- 日期：2026-09-15
- 状态：修复锁文件前已研究，合并前仍须完整 CI
- 关联 PR：#77
- 目标：干净安装后，配置与 React 插件解析同一份 Vite 类型，保留严格类型、开发 CSP、Desktop 与沙箱测试。

## 根因与证据

[原 CI](https://github.com/Peerframe/openbot/actions/runs/34935951572) 在三平台的 vite.config.ts:49 报 TS2321、TS2769，本地干净安装复现。配置读取 apps/web/node_modules/vite 8.3.0，根 React 插件读取 node_modules/vite 8.2.2；跨版本递归 Plugin 类型比较失败。锁文件还保留了与精确清单不同的范围声明。

核对既有[复用账本](../OPEN_SOURCE_REUSE.zh-CN.md)、[CSP 研究](web-dev-csp-nonce.zh-CN.md)、Vite 官方发布/标签/plugin.ts、npm 10.9.9 官方去重说明和实际 peer 范围。版本与 stack depth 的定向问题搜索无匹配，不代表没有上游缺陷。

## 选择与验证

继续使用 Vite 8.3.0，固定源码 434e8e9495436a60789f2b588a04a6a24a3d1661，MIT；复用 npm 10.9.9（Artistic-2.0）重新解析锁文件。plugin-react 6.1.1、vitest 5.0.0 和 mocker 的 peer 范围均接受 Vite 8.3.0，无需新增依赖或 override。

npm 10.9.9 的 update/dedupe 在处理 Vitest 可选 peer 时出现 Arborist null edgesOut 内部错误。将已锁定的 Vite 8.3.0、PostCSS 8.5.28 记录整理到根层，保留发布地址与完整性校验值，再用 npm install --package-lock-only 和干净 npm ci 校验。修正精确声明，保留无关版本及锁元数据。不增加类型断言、不放松严格检查、不修改 CSP 或应用逻辑。兼容性失败时回退完整升级。

验证两处实际解析路径、干净安装、typecheck、完整 npm run check，以及已有真实开发服务 nonce/并发和生产/Desktop 构建测试。当前提交须通过 Linux、macOS、Windows CI，不增加支持声明。

没有复制或实质改写上游源码，保留 Vite MIT 与既有依赖许可。官方来源及版本比较见英文页。

