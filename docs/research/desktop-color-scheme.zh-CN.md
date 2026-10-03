# 研究：Desktop 外观模式

- 状态：已接受；已实现平台部分，renderer 单独验收
- 日期：2026-10-03
- Owner：OpenBot 维护者
- 验收流程：保存 system/light/dark，在原生窗口首次绘制前应用，有效外观改变时通知 renderer。
- 安全边界：仅本地呈现；复用私有偏好与可信聚焦 IPC，不改 OS 设置或 Server 权威。

## C25 外观模式扩展（2026-10-03）

Owner 于 2026-10-03 批准 system/light/dark 选择。这扩展了此前仅浅色的侧栏决定；原生材质、
无障碍降级和窗口控件边界仍适用。变化只涉及本地持久化的呈现字段和三个可选、固定的 bridge 方法，
不修改 OS 设置或 Server 权威。

定向审核复用仓库已固定的 Electron **44.3.0**，tag 对象
`a5d1c52118831d762385f34c1b3ffbcc4d99de58`，提交
`07e460719c75b2ec5ee4893f7d2192ef31c7b8c2`，MIT。已读取
[发布记录](https://github.com/electron/electron/releases/tag/v44.3.0)、
[固定版实现](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_native_theme.cc)、
[固定版测试](https://github.com/electron/electron/blob/v44.3.0/spec/api-native-theme-spec.ts)、
[MIT 许可](https://github.com/electron/electron/blob/v44.3.0/LICENSE)和安装的类型声明。
[官方 nativeTheme API](https://www.electronjs.org/docs/latest/api/native-theme)提供三种主题来源、
有效深色状态和更新通知。上游测试覆盖强制模式的即时结果以及变化/未变化时的事件。
2026-10-03 GitHub 查询 `repo:electron/electron nativeTheme themeSource is:open`，核对进行中的
[覆盖机制重构 #54595](https://github.com/electron/electron/pull/54595)、
[逐 WebContents 提案 #52438](https://github.com/electron/electron/pull/52438)和历史
[Ubuntu 问题 #28887](https://github.com/electron/electron/issues/28887)。单窗口不需要逐窗口覆盖
或未发布重构；其他 OS 的表现仍需对应检查。

比较仅 renderer 媒体查询（无法控制原生首次绘制和窗口外观）、另建偏好存储（重复持久化与迁移）
和已发布 nativeTheme 配合现有平台偏好存储，选择最后一项：薄的类型化适配、严格值、可信聚焦 IPC
及隔离 preload 的用户手势检查。可选方法兼容 Web 和旧 shell。旧文件默认跟随系统；旧设置提交
保留已保存的外观。持久化为提交点，然后应用原生主题；保存失败保留原生旧值。初始化在构造
BrowserWindow 前应用偏好，实色背景为 `#ffffff` / `#141414`。原生材质和无障碍降级使用同一结果，
不改变保留的透明度偏好。

不新增依赖或版本，不复制或实质改编上游源码；保留已有 Electron MIT 声明。升级沿用已有打包路径，
重验主题和材质；没有并行实现需要退出。自动验收覆盖非法值、真实私有文件持久化、旧文件、启动、
系统变化、IPC/preload 权限以及深色材质降级。隔离的 macOS arm64 Electron 夹具验收原生边界；
renderer 深色样式由 Claude 完成。不为测试改动全局外观或无障碍设置，也不增加其他平台支持声明。
