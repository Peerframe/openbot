# 调研：频道成员菜单布局

- 状态：允许实施
- 日期：2026-09-13
- 负责人：OpenBot contributors
- 来源：Owner 反馈桌面成员菜单显示错误
- 验收流程：打开成员菜单，读清 Bot 身份，分别打开档案或移除，再添加可用 Bot；控件不互相遮挡。
- 安全边界：仅调整呈现。Server 的成员、取消、历史保留及私聊限制继续生效。

## 调研证据与版本

修改前检查开源复用清单与[频道交互调研](channel-interactions.md)。已安装 alpha.8 与用户截图均出现浏览器默认按钮和被截断的身份文字。组件新增了包住档案与移除按钮的行，但旧 CSS 仍只匹配列表的直接按钮子元素。

2026-09-13 搜索 `repo:w3c/csswg-drafts flexbox automatic minimum size button overflow`，阅读 CSSWG [8502](https://github.com/w3c/csswg-drafts/issues/8502)、[6794](https://github.com/w3c/csswg-drafts/issues/6794) 已关闭问题，以及规范关联的 [Web Platform Tests](https://wpt.fyi/results/css/css-flexbox)。采用 [CSS Flexbox Level 1 的 2025-10-14 CRD 快照](https://www.w3.org/TR/2025/CRD-css-flexbox-1-20251014/)（W3C 宽松文档许可），明确文字可收缩，头像与独立操作不收缩。继续使用 React 19.2.8 / `1dd4ecbdabf826f527fc9a58c05ea70375b7d170`（MIT）和[稳定列表身份](https://react.dev/learn/rendering-lists)。

## 复用决定

原生按钮和 Flexbox 是首个可行标准方案，无需新增菜单库。使用明确的档案、身份、移除样式类，把成员样式归到组件自身，避免散落在消息与回应样式中。保留现有状态、精确 Bot ID 回调、焦点、Escape、外部关闭和窄屏定位。长名称及角色可省略显示，完整内容仍保留在可访问名称或原生提示中。

实际渲染还发现：桌面侧栏收起时，原有右对齐弹窗会越过窗口左边缘。桌面宽窗口改为与频道标题左侧对齐，窄窗口保留固定边距。

未复制或实质改编任何上游源码，没有新增依赖或许可声明。Grok 的可观察设计建议另行咨询，不声称了解其内部源码或已完成逐像素对照。

## 验证计划与边界

运行现有移除失败、私聊限制测试，并检查档案回调、Escape 焦点。使用真实组件及应用样式检查长名称、长角色、空列表、多成员、桌面及窄窗口的头像、文字、焦点与独立按钮。完成 `npm run check`，集成发布后从已安装桌面入口复验。合成预览不替代原生安装版本验收。
