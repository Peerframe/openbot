# C16：从 SVG 源文件生成 Desktop 图标

2026-10-03 的候选生成管线；批准图形源文件和三个平台实际截图仍待交付。
精确版本、源码／测试／问题检查、替代方案和许可见[英文证据](desktop-svg-icons.md)。
复用现有 electron-builder 26.16.1 的 icons@1.2.3，工具归档按 SHA256 验证，不新增依赖。
小尺寸替换成单独的小图画法，不复制上游代码。

Claude 在 `docs/design/app-icon/` 导出 `app-icon.svg`、`app-icon-dark.svg`、
`app-icon-small.svg` 三份源图即可生成平台图标。可选的 `app-icon-linux.svg`、
`app-icon-splash.svg` 分别覆盖默认圆形裁切和深色图标素材；没有单独启动图时，
输出只提供深色图标素材，不代表已还原完整启动画面。SVG 使用正方形 viewBox、内嵌路径和颜色，
不依赖字体、外部图片或脚本。启动画面布局仍由 Claude 完成，PNG 只提供图形。

执行 `npm run icons:generate --workspace @openbot/desktop`，输出在忽略目录
`apps/desktop/out/icons/`。打包及 installer 入口均会重新生成；不会提交二进制图标。
缺少源文件时在覆盖前拒绝，保留上次输出。记录源文件哈希，使用确定性数据验证两次字节一致。

ICNS 覆盖 16–1024px 和 Retina，小尺寸逻辑 16/32pt 使用小图；ICO 为
16/24/32/48/64/128/256px；Linux PNG 为 16/24/32/48/64/128/256/512px，
≤32px 使用圆形裁切小图。Linux 的窗口 PNG 单独保存在 `linux/openbot-icon.png`，Windows 使用主图 PNG，
避免 Windows 窗口意外使用 Linux 圆形图。深色和启动图为 1024px。脚本测试 6 项通过，无跳过；
这不等于批准图形或原生系统显示验收。源文件未提交前 C16 保持未完成，
三个平台截图缺项明确保留，不用模拟系统截图代替。C9/C11 保持不动，不自动合并或发布。

最终三源实现 `9737c1c` 的[托管 validate 已通过](https://github.com/Peerframe/openbot/actions/runs/37042084211/job/110954997244)。
PR：[草稿 #158](https://github.com/Peerframe/openbot/pull/158)。打包仍因批准源图缺失而拒绝，
不能把 validate 通过视为原生显示验收。本文仅补充证据，复用上述检查。
