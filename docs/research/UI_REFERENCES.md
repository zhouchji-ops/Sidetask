# UI 参考与 SideTask 的设计转化

调研日期：2026-09-24。用户指定 Mobbin、Dribbble、Behance；第二个原链接拼接了两个站点，已分别访问。此处记录公开可见界面的观察与本项目取舍，不推断作品的内部架构，也没有复制素材或第三方代码。

| 来源 | 实际查看的内容 | SideTask 采用的原则 | 适用边界 |
| --- | --- | --- | --- |
| [Mobbin · iOS apps](https://mobbin.com/discover/apps/ios/latest) | 未登录页面显示介绍及登录/注册入口 | 保留为后续真实产品流程研究入口 | 本次没有看到库内流程，不声称依据其内部截图完成设计 |
| [Task detail desktop app · Jakub Antalik](https://dribbble.com/shots/14794406-Task-detail-desktop-app) | 桌面详情白色面板、属性分组、便笺区与完成行 | 标题优先；日期/重要程度集中为属性组；说明文字降低视觉权重 | 不引入作品中的子任务、附件等超出首版的功能 |
| [TaskFlow · Shantikumar](https://dribbble.com/shots/27246986-TaskFlow-Task-Management-App-Mobile-UI-UX) | 任务列表、方形勾选、次级优先级/时间标签、完成划线 | 明确区分任务标题和元信息；状态不用颜色单独表达；完成反馈克制 | 这是移动端概念；桌面交互按鼠标、键盘和窗口尺寸设计 |
| [TaskFlow · Muhammad Subhan](https://www.behance.net/gallery/244125653/TaskFlow-Minimal-Task-Management-App-UIUX) | 公开案例封面、字体说明、品牌与任务优先级的设计说明 | 字阶、间距、图标和状态需形成统一系统 | 渐变、波浪装饰与大型统计面板不适合本项目小窗密度；未据此证明可用性 |
| [Todoist Foundations · Doist](https://dribbble.com/shots/8233549-Todoist-Foundations-Task-view) | 公开任务详情交互说明 | 从任务行进入一个集中详情入口 | 仅核对文字说明；不复制子任务和团队功能 |

## 本项目的视觉方向

侧笺像放在屏幕边的一张整洁便笺：纸白底、深墨文字、鼠尾草绿强调，日期和逾期使用有明确含义的辅助色。以任务内容为第一层，以安排与截止日期为第二层，以窗口控制为第三层。主界面使用桌面侧栏、任务列表和任务详情；小窗保留今日/DDL 两区，两者使用同一任务行语言。

审美创新落在组合和细节：窄边缘书签把手、简短今日开场、安静的状态色、内侧缩放角和可调分区。具体变量与组件样式见 [样式源码](../../apps/desktop/src/styles/)。

## 实现验收

对新建、编辑、完成、撤销、移出今日、设置、错误、空状态进行实际操作检查；检查明暗主题、长标题、300×380 最小小窗和宽面板。截图只作为布局证据。hover 焦点、多屏接缝、透明区域命中、跨 DPI 拖动要在两平台原生窗口测试，不能通过设计稿或浏览器推断。

## 多风格补充调研（2026-09-24～25）

本轮继续搜索并用浏览器查看以下公开作品图像，提取层级与排版原则；没有下载复用素材。作品展示不等于可用性或生产架构验证。

| 来源 | 实际观察 | 本项目的转化 |
| --- | --- | --- |
| [Dona · Light / Dark / Black mode — Jakub Antalik](https://dribbble.com/shots/15015786-Light-Dark-Black-mode) | 并列的白、炭灰、近黑详情；属性与备注用不同表面区分 | 四套风格各自设计明暗 token，保持文字与表面层级，避免简单反色 |
| [Task Manager App · Minimal & Productive UI — Ksenia Mizgina](https://dribbble.com/shots/25601101-Task-Manager-App-Minimal-Productive-UI) | 灰色画布、白色任务卡、明确标题，列表与详情独立 | 霜序最初使用深导航与冷色画布（9月25日按用户反馈改为暖石灰/炭黑/酒红），列表卡片和详情保持同一套语言；不加入大型倒计时、子任务和统计 |
| [taskr. App — Jonathan Antoine](https://www.behance.net/gallery/79340557/taskr-App) | 深色平面任务列表、按天分节、紧凑对齐、局部强调 | 极简强调连续行、方形勾选、对齐和高密度；不照搬移动导航和番茄钟 |
| [Mello — James Toone](https://jamestoone.design/work/mello) | 设计师公开案例页与展示图上部，精简导航和清楚的任务区 | 共同保留任务第一层、明确操作入口；未把作者案例统计或其内部架构作为本项目证据 |

暖刊是基于纸面排版的原创组合：奶油纸面、赤陶强调、宋体标题与横线分区；正文继续使用系统无衬线字体。纸笺保留最初的纸白与绿色。选择器也呈现每套排版差异，避免用户只看到四个色块。

2026-09-25补充：[UI设计skill核对记录](DESIGN_SKILLS.md)。Impeccable Operate最贴近学习任务工具；本轮仅核对与评估，未安装。
