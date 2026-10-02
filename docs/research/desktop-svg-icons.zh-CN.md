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
`apps/desktop/out/icons/`。源图已交付时，打包及 installer 入口均会重新生成；不会提交二进制图标。
显式生成命令缺少源文件时在覆盖前拒绝，保留上次输出。记录源文件哈希，使用确定性数据验证两次字节一致。

ICNS 覆盖 16–1024px 和 Retina，小尺寸逻辑 16/32pt 使用小图；ICO 为
16/24/32/48/64/128/256px；Linux PNG 为 16/24/32/48/64/128/256/512px，
≤32px 使用圆形裁切小图。Linux 的窗口 PNG 单独保存在 `linux/openbot-icon.png`，Windows 使用主图 PNG，
避免 Windows 窗口意外使用 Linux 圆形图。深色和启动图为 1024px。脚本测试 6 项通过，无跳过；
这不等于批准图形或原生系统显示验收。源文件未提交前 C16 保持未完成，
三个平台截图缺项明确保留，不用模拟系统截图代替。C9/C11 保持不动，不自动合并或发布。

最终三源实现 `9737c1c` 的[托管 validate 已通过](https://github.com/Peerframe/openbot/actions/runs/37042084211/job/110954997244)。
PR：[草稿 #158](https://github.com/Peerframe/openbot/pull/158)。初版打包因批准源图缺失而拒绝，
不能把 validate 通过视为原生显示验收。本文仅补充证据，复用上述检查。

## 打包回归修正

`99a8afb` 的 validate 通过，但三个平台打包、Python Preview 及最终 check 失败，
原因是源图交付前就强制执行生成。现在仅在五个已知 SVG 路径全部缺失时，
打包明确提示 C16 未验收，并沿用仓库现有 `resources/openbot-icon` 资源。
任意源图已出现后，源图不齐、无效或转换失败仍拒绝打包；旧生成输出不能改变选择。
显式 `icons:generate` 命令始终要求完整源图。三份有效源图到位后，两个入口自动切换生成图标，
Linux installer 使用多尺寸 PNG 集合。不改 CI 门禁、不提交新二进制、不改 Web；
批准源图和实际截图仍待交付，#158 保持草稿。转换器、依赖和许可沿用原决定。

修正验证：45 项定向测试通过、无跳过；完整 `npm run check` 通过（18 个构建任务成功，
17 个缓存）；文档门禁 12 项通过、564 个 Markdown 文件。正在同一 PR 复验托管打包。
