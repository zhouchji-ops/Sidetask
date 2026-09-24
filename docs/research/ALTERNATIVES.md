# 同类项目与复用评估

调研日期：2026-09-24。范围：官方产品页、公开 GitHub README、发布记录和关键源码。**没有安装或运行这些应用，也没有做多屏实测。**「未确认」不代表产品一定没有该功能；源码风险不代表已复现缺陷。

## 结论

有非常接近的产品，不需要以「完全没人做过」为前提立项。但尚未核实有一个现成项目同时满足：Mac + Windows、悬停展开/离开收起、全过程不越屏、自由调整宽高、今日计划与独立 DDL 同源完成。

Todobar 最适合双平台对照评估；Peekaboo 最适合研究原生 Mac 的悬停交互。建议先做固定版本的复用评估，再决定改造 Todobar 还是自建。基于所读源码，核心差异涉及窗口生命周期和数据模型，不能预计只是改几个样式。

## 产品对照

| 项目 | 官方信息/源码确认的接近点 | 关键差距与待核实项 | 建议用途 |
| --- | --- | --- | --- |
| [Todobar](https://github.com/Leonxlnx/todobar) | macOS / Windows；Tauri 2 + React；边缘面板、Today、Calendar、优先级、可调宽度 | hover 只显露把手；收起窗口移出工作区；未见独立 DDL 与每日计划模型；高度主要随工作区 | 最接近的双平台复用候选 |
| [Peekaboo](https://github.com/Emanuele-web04/Peekaboo) | Mac 角落悬停展开、离开延迟隐藏；多屏识别；优先级 | 无 Windows；没有 DDL/计划日期；宽 410 pt，非自由缩放；向外淡出动画需检查边界 | Mac 交互/窗口实现参考 |
| [Glance](https://glanceapp.de/) | 官网宣称边缘呼出/离开隐藏，集成 Apple Reminders 等任务工具 | 官网的 App Store 链接仍含 `id__APP_ID__` 占位，GitHub 链接本次返回 404；可安装性与功能未核实 | 产品方向参考，暂不当作可直接使用的推荐 |
| [TickTick / 滴答清单](https://ticktick.com/windows) | Windows 官方页提供任务桌面便笺和小组件；已有任务管理体系 | 本次官方证据未确认所需的边缘悬停收起与多屏隔离；上下双区布局不一定可定制 | 如果常驻便笺也能解决痛点，可作为现成替代方案 |
| [Unclutter](https://unclutterapp.com/features/) | Mac 顶部呼出，面板可调尺寸，官方称支持多屏 | 核心是剪贴板/文件/笔记；默认顶部移动后滚动展开；没有本需求的完整任务/DDL模型 | 交互参考 |

上表都是证据范围内的对照，不是逐台设备测评；不对当前价格、未来免费政策或第三方兼容性作承诺。

## Todobar：固定源码版本的发现

审查版本：`809b0d5857b03b3fec946f227ddaffb70cbe2789`，主分支最新提交日期本次查得为 2026-05-18。[提交记录](https://github.com/Leonxlnx/todobar/commit/809b0d5857b03b3fec946f227ddaffb70cbe2789)

- `syncHitTest` 改变 `edgeRevealVisible`，使把手可见；面板的 `isOpen` 由点击、快捷键等路径改变。因此不能把介绍中的 hover 模式写成「悬停即展开任务」。
- `closedX` 把原生窗口移到工作区以外；相邻屏可能就在该区域。是否实际露出内容/接收点击必须真机验证。
- 自定义清单已有引用到 Today 的机制，一些视图操作会回写来源；但任务类型中的 `reminderAt` 是提醒时间，不能当成独立截止日期。现有 Today/month/list 组织方式仍需对照本项目模型评估。

证据：[App.tsx](https://github.com/Leonxlnx/todobar/blob/809b0d5857b03b3fec946f227ddaffb70cbe2789/src/App.tsx)、[任务类型](https://github.com/Leonxlnx/todobar/blob/809b0d5857b03b3fec946f227ddaffb70cbe2789/src/tasks.ts)、[样式](https://github.com/Leonxlnx/todobar/blob/809b0d5857b03b3fec946f227ddaffb70cbe2789/src/App.css)。这些是源码判断，未运行验证。

本次查得最新正式发布为 [v0.1.14](https://github.com/Leonxlnx/todobar/releases/tag/v0.1.14)，发布于 2026-05-14，提供 Mac Apple Silicon / Intel 与 Windows 安装包。发布说明注明尚未签名/公证；README 仍列出物理 Mac QA 工作。安装包版本早于上述主分支提交，试用结果必须注明实际版本，不能混用代码与安装包证据。

项目 [LICENSE](https://github.com/Leonxlnx/todobar/blob/809b0d5857b03b3fec946f227ddaffb70cbe2789/LICENSE) 和 README 声明 Apache-2.0，但 LICENSE 文件是简短授权头，GitHub API 自动识别为 Other / NOASSERTION。复用前确认完整授权文本与依赖声明，保留相应归属信息；本阶段未复制源码。

## Peekaboo：固定源码版本的发现

审查版本：`54c23bf5a64e722a630c33554c759994ca119818`，本次查得主分支最新提交为 2026-09-07。[提交记录](https://github.com/Emanuele-web04/Peekaboo/commit/54c23bf5a64e722a630c33554c759994ca119818)

悬停展开、离开收起和交互保护有明确状态机。但它只做 Apple 平台；TaskItem 没有 DDL / 每日计划字段；宽度固定为 410 pt。默认 inset 12 pt，隐藏几何向外移动 18 pt，淡出结束才隐藏窗口；数学上可能超出可用区域 6 pt，是否可见跨入邻屏尚未实测，不能据此宣称发生了实际泄漏。

证据：[状态机](https://github.com/Emanuele-web04/Peekaboo/blob/54c23bf5a64e722a630c33554c759994ca119818/Peekaboo/Services/CornerHoverStateMachine.swift)、[PanelGeometry](https://github.com/Emanuele-web04/Peekaboo/blob/54c23bf5a64e722a630c33554c759994ca119818/Peekaboo/Services/PanelGeometry.swift)、[控制器](https://github.com/Emanuele-web04/Peekaboo/blob/54c23bf5a64e722a630c33554c759994ca119818/Peekaboo/Window/PeekPanelController.swift)、[TaskItem](https://github.com/Emanuele-web04/Peekaboo/blob/54c23bf5a64e722a630c33554c759994ca119818/Peekaboo/Models/TaskItem.swift)。

[许可证为 MIT](https://github.com/Emanuele-web04/Peekaboo/blob/54c23bf5a64e722a630c33554c759994ca119818/LICENSE)。本次查看 [Releases](https://github.com/Emanuele-web04/Peekaboo/releases) 无正式发布；[构建说明](https://github.com/Emanuele-web04/Peekaboo#build-and-run) 要求 macOS 14+、Xcode 16+，需配置签名团队与 bundle identifier。可参考原理，但不能当成已提供 Windows 安装包的解决方案。

## Glance 的证据限制

[官网](https://glanceapp.de/)描述与痛点很接近，但本次点击的 [App Store 地址](https://apps.apple.com/app/glance/id__APP_ID__) 含占位 ID，[GitHub 地址](https://github.com/dominikkeller/glance) 返回 404。这只能说明本次无法核实分发入口，不能推出项目不存在。后续找到有效发布源再补测，不建议现在依赖它作为马上可用的工具。

## 下一步复用评估：有退出条件

1. 固定 Todobar 源码 SHA / 安装包版本，记录构建、启动、依赖及许可证状态。
2. 使用 [验收计划](../delivery/TEST_PLAN.md) 在两平台测试边缘、双屏接缝和焦点；每项标通过/失败/未测。
3. 画出复用/替换边界：窗口服务、任务存储、视图、设置、打包，估计改动与持续合并上游的成本。
4. 如果主要只需扩展且关键行为能通过，可 fork；如果窗口和数据核心都需大幅替换，则优先自建精简版本。
5. 在 [ADR-0001](../decisions/0001-platform-and-reuse.md) 记录证据与结论，再进入实现。

不存在「Star 多就一定可靠」或「没有完全一样就必须从零做」的决定规则。评估目的在于尽快得到可用工具，而不是为了自建而自建。
