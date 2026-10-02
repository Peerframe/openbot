# 应用图标源文件

[English](README.md) · 简体中文

桌面应用图标的矢量源文件。它们按已通过的 [AppIcon 画板](../desktop-ui-2026-10/AppIcon.dc.html)和
[`RobotAvatar`](../../../apps/web/src/components/RobotAvatar.tsx) 里的「圆顶」Bot 头像绘制。
桌面打包会用它们生成 macOS、Windows 和 Linux 的图标（`npm run icons:generate --workspace @openbot/desktop`，C16）。

| 文件 | 用途 | 画法 |
| --- | --- | --- |
| `app-icon.svg` | 32px 以上的所有尺寸 | 浅色底 `#F5F5F2`，边线 `#E3E3E6`；圆顶头像，绿色下巴 `#91CF4B` |
| `app-icon-dark.svg` | 深色 Dock，以及启动画面的备用图 | 底色 `#1D1D1F`，边线 `#2C2C2E`；头像系统的深色版（身体 `#E8EBDD`、眼睛 `#20251F`、下巴 `#ADF16A`） |
| `app-icon-small.svg` | 32px 及以下 | 小尺寸画法：眼睛更大，天线和顶上的圆球更粗；32px 时有 1px 边线 |

## 构造方法

三个文件都是 1024 单位的正方形 viewBox，只包含带填充和描边属性的路径、圆和矩形：
没有样式、文字、图片或外部引用。

- 底板对应画板上 256px、圆角 58px 的图标：放大到 1024 后圆角半径为 230。
- 头像用 96 单位的头像图形，放大到 784 单位（256 里的 196）并居中，所以从 120 开始。
- 天线宽 4 单位（小尺寸画法为 6），顶上圆球半径 4.3（小尺寸画法为 5.6）。

画板上的深色 Dock 示例把一个颜色值传给了头像本该接收 `dark` 的参数，结果用回了浅色画法。
这里的源文件改用头像系统为深色背景定义的深色版，头像在深色 Dock 上才看得清。

没有使用任何其他产品的标志或吉祥物。
