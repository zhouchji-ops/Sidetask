# UI 设计 skill 调研

核对日期：2026-09-25。来源为作者仓库的实际 SKILL.md、参考文件和许可，不仅依赖聚合站介绍。

前一轮用户要求查找设计 skill，因而只做只读调研，没有安装或执行第三方程序。随后用户明确要求下载两个 skill 并改进当前 UI；本轮已安装 Impeccable 和 Anthropic frontend-design，并将其用于 SideTask 的界面精简。两次工作的授权与结果分别记录，不能把“前轮未安装”继续当作当前状态。

| 候选 | 核对结果与适用范围 | 结论 |
| --- | --- | --- |
| [Impeccable](https://github.com/pbakaus/impeccable/tree/e0881d2de397d5e9761d7b35ff5017d8f5ebf69b/.agents/skills/impeccable) | 当前v4.3.1，Apache-2.0，提供Codex版本。其Operate指导面向工作中的工具界面：易扫读、熟悉的控件、克制强调色、一致的状态；critique / quieter / distill / polish可用于分轮评审。 | 最适合SideTask控制台与小窗；不把营销页视觉规则套在任务工具上。 |
| [Anthropic frontend-design](https://github.com/anthropics/skills/blob/33375500bcea98d610eb30ce10ac4e59b89c390d/skills/frontend-design/SKILL.md) | Apache-2.0，指令文件。要求先从真实产品与内容制定颜色/字体/布局，再检查是否只是通用模板，最后截图自评。当前版也把奶油赤陶等流行组合列为可能的模板。 | 适合轻量设计审查。颜色须有使用目的，不能把换一种流行色当成完成“去AI味”。 |
| [Taste Skill](https://github.com/Leonxlnx/taste-skill/blob/c184364c58658b2f131b4ae8bd3d206cabb3deee/skills/taste-skill/SKILL.md) | MIT，作者标记v2 experimental。当前正文聚焦landing page/portfolio/redesign，并明确排除dashboard、data table及复杂产品流程。 | 可评估用于以后官网；不作为当前桌面控制台的主规则。 |

## 本项目的取舍

优先参考 [Impeccable Operate](https://github.com/pbakaus/impeccable/blob/e0881d2de397d5e9761d7b35ff5017d8f5ebf69b/.agents/skills/impeccable/reference/operate.md)：学习时一瞥能看清任务、状态与DDL，比营造惊艳的首屏更重要。保留系统字体、熟悉操作与适当密度；状态颜色用于动作、选择和错误，装饰不能抢走任务层级。不同风格应建立在同一任务行为上。

霜序在前轮已按用户反馈移除灰蓝调，改成暖石灰、炭黑与低饱和酒红；本轮保留该色盘以及四套可切换风格，主要调整信息层级、布局与文字。奶油色、衬线字或酒红色本身都不能保证独特性，也不能作为“去 AI 味”已经完成的证据。

## 安装形态记录

| 已安装 skill | 固定来源 | 本机位置与许可 |
| --- | --- | --- |
| Impeccable v4.3.1 | `pbakaus/impeccable`，commit `e0881d2de397d5e9761d7b35ff5017d8f5ebf69b`，目录 `.agents/skills/impeccable/` | `~/.codex/skills/impeccable/`；Apache-2.0。仓库根 LICENSE 已补入本地 skill 目录，保留启动器与参考文件。 |
| Anthropic frontend-design | `anthropics/skills`，commit `33375500bcea98d610eb30ce10ac4e59b89c390d`，目录 `skills/frontend-design/` | `~/.codex/skills/frontend-design/`；Apache-2.0，保留目录内 `LICENSE.txt`。 |

Impeccable 并非仅一个 Markdown 指令文件：其启动器首次运行下载了固定版本 `0.1.5` 引擎，并通过启动器的 SHA-256 校验；引擎位于 `~/.impeccable/bin/0.1.5/`。本轮在项目目录执行 `context` 一次并成功；没有安装 hooks，没有运行项目自动修复或把远端规则写成新的仓库强制指令。Anthropic frontend-design 使用本地指令及许可文件。

两个本机 skill 目录均有 `INSTALL_RECEIPT.json`，记录仓库、commit、源目录、安装时间、SKILL.md 的 SHA-256 和许可，便于以后核对版本。Impeccable 引擎探测返回 `impeccable-engine 0.1.5`。

已读取两份实际 SKILL.md，并针对任务工具读取 Impeccable 的 `distill`、`operate` 与 `craft-floor`。项目已有 [PRD](../product/PRD.md)、[UX](../product/UX.md) 和 [设计系统](../../design/DESIGN_SYSTEM.md) 提供真实上下文，沿用这些文件，不创建内容重复的 PRODUCT.md / DESIGN.md。技能保存在本机的全局 skill 目录，不是 SideTask 的运行时依赖，也不随 App 打包。

## 本轮设计计划与取舍

设计模式采用 Operate：学习时快速判断下一项任务、期限和状态。结构调整采用 distill；frontend-design 用来复核色彩、字体、布局与措辞是否服务这个真实场景。

1. 保留任务主内容，去掉页面标题上方的装饰标签、励志口号、彩色句点和完成圆环。今日日期继续显示，完成数合并到列表标题一行。
2. 侧栏保留任务视图、设置和普通“打开小窗”入口，移除宣传卡与重复存储状态。霜序改用连续分组任务列表，减少每一行重复的边框、阴影和外间距。
3. 控制台标题缩至 26–30 px；正文和操作继续使用系统字体。暖刊只在页面主标题使用宋体，日期、数量、表单和小窗不使用展示字体。
4. 小窗保留紧凑日期与今日 / DDL 双区，移除口号和装饰太阳。设置中的浅色、深色、跟随系统改为三个紧凑按钮；四套界面风格入口继续保留。
5. 新建、空状态与完成反馈写明状态、结果或下一步动作，保留撤销和错误恢复信息。

选择依据是任务查阅路径和重复信息：同一条任务要比容器显眼，完成数无需占据独立图形区域，边缘小窗的垂直空间应留给任务。色盘延续用户选择，只在语义明确的操作、选中和状态处强调。本轮因此包含信息与结构的调整，不能仅以换成另一套流行配色作为交付。

上述为本轮设计与实现依据；当前测试、构建和原生验证范围见[验证摘要](../VALIDATION.md)，原始截图与执行证据见内部验收记录（本地保留，未随公开仓库分发）；本调研记录不代替验证。

技能只能辅助设计判断；Tauri原生窗口焦点、多屏边界、Windows兼容和真实学习场景可用性仍需各自验证。
