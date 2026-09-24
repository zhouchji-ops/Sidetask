# 窗口偏好与首次说明：最小实施计划

2026-09-25，只读调研与方案，**尚未实现、未安装插件、未进行系统窗口操作**。接续 B09（分区/尺寸）、B19/B21（控制台恢复）、B25（首次使用）；当前生命周期验收与交付状态仍以 STATUS 为准。

## 结论与现状

首轮复用现有 Rust 设置服务和 SQLite，不引入 window-state 插件。只补三个缺口：小窗分区比例跨重启保留，控制台恢复上次普通窗口几何，用户知道关闭后从哪里找回应用。

| 已核对源码 | 当前行为 | 最小接续 |
| --- | --- | --- |
| [EdgePanel.tsx](../../apps/desktop/src/surfaces/edge-panel/EdgePanel.tsx) | `split` 为内存状态，默认 54，范围 30–70；已有分隔条方向键、指针捕获和交互锁 | 分隔条拖动仍只更新页面；操作结束保存一个设置字段 |
| [Settings](../../apps/desktop/src-tauri/src/domain/mod.rs)、[前端校验](../../apps/desktop/src/lib/domain.ts) | 设置在快照内；字段白名单和旧值兼容明确，任务备份恢复保留本机设置 | 加 `panelSplit` 与一次说明的 `usageGuideSeen`，两端默认及验证保持一致 |
| [platform/mod.rs](../../apps/desktop/src-tauri/src/platform/mod.rs) | 控制台启动固定 1180×790、最小 880×620、居中；`open_console` 主动显示并聚焦。小窗已有工作区、缩放、停靠位置与保存逻辑 | 控制台单独保存/恢复；复用屏幕枚举，不复用小窗贴边算法 |
| [Repository](../../apps/desktop/src-tauri/src/infrastructure/mod.rs) | `app_state` 只有 snapshot / placement；`save_placement` 仍重写整份任务快照。Placement 当前只有小窗屏幕与 offset | 扩展现有 placement 设备记录；给控制台增加合并元数据的写入方法，避免窗口移动重写 10k 任务 |
| [Console.tsx](../../apps/desktop/src/surfaces/console/Console.tsx) | 真空库已有菜单栏/托盘恢复说明；没有独立的一次说明状态 | 复用简短内联说明，不做强制向导 |

数据模型中的完整 DevicePreferences 独立 revision 是目标结构，当前源码仍为 Settings + placement。首轮不顺带重构整个设置体系。新增字段须兼容缺省；不得把已有任务、回收站或历史计划误判成首次空库，不能为了显示指引重置数据。

## 一手参考与复用判断

| 固定来源 | 核对结果与采用范围 |
| --- | --- |
| Tauri 官方 window-state **2.4.1**，commit [`e7a68fa63755603b9fa12d28e077eea645551d24`](https://github.com/tauri-apps/plugins-workspace/tree/e7a68fa63755603b9fa12d28e077eea645551d24/plugins/window-state)；[实现](https://github.com/tauri-apps/plugins-workspace/blob/e7a68fa63755603b9fa12d28e077eea645551d24/plugins/window-state/src/lib.rs) | 参考普通几何缓存、排除最小化/最大化的尺寸、恢复期间抑制回调写入。默认 StateFlags 为 ALL，包含 VISIBLE；恢复可调用 show + set_focus。保存为独立 `.window-state.json`，移动/缩放回调更新内存，退出或显式命令写文件。屏幕判断用显示器完整范围内的任一窗口角点，不保证标题栏位于工作区；保存物理像素，不提供本项目需要的当前 DPI 逻辑尺寸策略。以上来自该版本源码，不将旧 issue 当现有故障证据。 |
| 现有锁定 Tauri **2.11.6**，commit [`9452ddee5ebefd9b678a94ff003521379df6c9ae`](https://github.com/tauri-apps/tauri/tree/9452ddee5ebefd9b678a94ff003521379df6c9ae)；[Window / Monitor 接口](https://github.com/tauri-apps/tauri/blob/9452ddee5ebefd9b678a94ff003521379df6c9ae/crates/tauri/src/window/mod.rs) | 已有 `work_area`、`scale_factor`、`inner_size`、`outer_size`、`outer_position`、位置/尺寸设置足够实施。inner size 不含标题栏和边框，outer size 包含；不能把 outer size 写回 inner size，导致每次重开变大。 |

两项许可均为 **Apache-2.0 OR MIT**；已核对插件 [Cargo workspace](https://github.com/tauri-apps/plugins-workspace/blob/e7a68fa63755603b9fa12d28e077eea645551d24/Cargo.toml)、[MIT](https://github.com/tauri-apps/plugins-workspace/blob/e7a68fa63755603b9fa12d28e077eea645551d24/LICENSE_MIT)、[Apache-2.0](https://github.com/tauri-apps/plugins-workspace/blob/e7a68fa63755603b9fa12d28e077eea645551d24/LICENSE_APACHE-2.0)，以及本地锁定 Tauri 包清单。本次仅参考设计，没有复制代码。若以后使用插件，应只管理 console，显式限制 SIZE / POSITION / MAXIMIZED，并由 SideTask 校准后显示；不能让它管理 edge-panel / edge-handle 或恢复 VISIBLE。它仍需自定义工作区、失败反馈与保存时机，当前不能减少足够的集成工作，因此暂不加依赖。

## 阶段一：小窗分区比例

新增 `Settings.panelSplit`，整数百分比 30–70，缺省 54。Rust serde、设置白名单与校验，TS 类型/校验/旧预览默认同步补齐；只在正常写入时持久化缺省，不重写原任务。`same_window_layout` 继续只比较原生几何/显隐字段，**panelSplit 与 usageGuideSeen 都不能进入该比较**；成功应用这些字段只需已有 WebView 重新布局。

- 拖动开始记下已提交值，保持指针捕获与交互锁；move 只更新本地比例。pointerup 最多提交一次；cancel / 捕获丢失 / 卸载释放锁并取消尚未提交的预览。只接受主指针左键，避免重复 pointerup / lostcapture 双提交。
- 方向键仍每次 5%，按键连发在 keyup / 失焦后合并保存；新快照仅在未拖动、无未提交预览时同步本地值。与设置页并发变化按字段核对，失败保留可重试的比例草稿，不覆盖别的设置。
- 比例按两个内容区可分配高度计算，先扣分隔条；保留当前两个 `minmax(76px, …)` 下限。最小窗口、错误条和完成反馈出现时，两个标题与首项基本操作仍可见；虚拟列表跟随实际容器高度重新测量，不重置任务和滚动位置。

## 阶段二：控制台几何

在现有 placement JSON 增加可缺省的 `console` 子对象：普通窗口逻辑 inner width/height、屏幕名称及原位置辅助匹配、相对该屏工作区的逻辑 outer x/y 偏移、最大化偏好。偏移允许负值以表达正常横跨屏幕；不把物理桌面原点截为零。保存的是正常矩形，最小化、全屏和最大化过程的临时矩形不能覆盖它；首轮不恢复全屏、隐藏或焦点状态。

设备记录由一个运行态持有；小窗拖动/缩放与控制台保存均合并最新字段。尤其当前 `finish_drag` 会构造完整 Placement，扩展后必须保留 console，控制台保存也不能覆盖刚更新的小窗位置。Repository 为仅设备几何更新提供事务合并方法：不改 Task、Plan、snapshot revision，不重编码 snapshot；不新增第二份文件存储。便携任务恢复继续保留这些本机配置。若最终选择新 app_state key，则必须同步现有严格 key 白名单和版本迁移，不能直接插入一个旧程序拒绝读取的记录。

恢复次序：

1. 控制台隐藏创建，恢复操作本身不抢焦点。枚举当前有效工作区及 DPI；优先匹配已保存屏幕，名称重复时结合原位置，再回退主屏/首个有效屏幕。无有效屏幕时保留待恢复状态，不写回无效坐标。
2. 用目标屏当前 scale 将逻辑 inner 尺寸转物理；根据实际 outer / inner 差处理标题栏边框，再恢复相对工作区的位置。普通窗口在现有布局中可操作时保留跨屏位置；若原屏消失或标题栏不可达，调整到有效工作区。不能仅用“一角仍与屏幕相交”判定成功。验收至少要求一块当前工作区内有可抓取标题栏和关闭按钮，内容有可操作的视口。
3. 工作区小于现有 880×620 最小值时，可用空间优先，调整本次原生 minimum 并验证窄布局；不要强迫窗口超出屏幕。应用完成后重读实际几何，确认可达，再按已保存偏好最大化；由明确的启动/托盘/管理任务意图决定显示和聚焦。恢复期间的 move/resize 事件不反写默认值。
4. 普通 move/resize 只合并内存候选，稳定约 400ms 后一次保存；关闭隐藏和已确认退出时补一次未落盘值。主事件回调不等待持有 service/dock 锁的线程，存储锁不跨原生窗口调用。保存失败保留当前可用窗口、显示“本次位置未保存”并可重试，不把移动操作回弹或卡住草稿处理。
5. 重开隐藏控制台、屏幕布局变化及唤醒时重新检查可达性；有效位置不主动重排，不跟随鼠标换屏，不因修复位置调用 set_focus。每次校准有代次，过期结果不能覆盖用户后续移动。恢复模式没有正常 AppState 时使用安全默认几何，不写任务库设备记录。

## 阶段三：首次打开与关闭说明

首次主动打开正常控制台，显示一条可关闭的内联说明：“任务可从屏幕边缘快速查看。关闭这个窗口后，侧笺仍在菜单栏或托盘运行；可从那里重新打开或退出。”配“打开边缘小窗”“知道了”，已有默认停靠可直接使用，不强制逐步配置。设置页保留同一段可再次找到的说明；有已有任务的升级用户也最多看一次，不遮挡任务列表。

`Settings.usageGuideSeen` 缺省 false，用户确认后一次保存；失败不宣称已记住，下次仍可出现。不靠任务数量判断是否首次。普通关闭仍走既有行为，未保存草稿继续既有保护，不额外弹“是否真的关闭”。关闭后 WebView 已隐藏，在里面发 toast 用户看不到；首轮在关闭前的首次说明解释去向即可，必要时下一次主动重开补一句状态说明。不开系统通知、不请求新权限、不为了显示说明自动展开小窗或重新激活应用。损坏启动恢复页面不显示正常常驻说明。

## 验收与拆分

先做分区比例，再做纯几何计算/元数据合并，最后接原生恢复与首次说明；每步通过后复盘。实现时同步 PRD/UX、数据模型和 BACKLOG，本次不修改这些交付文件。

| 必须新增/复验 | 通过标准 |
| --- | --- |
| TS/Rust 设置兼容与过滤 | 缺字段得到 54/false；边界和非法值明确；任务、DDL、Plans 不变；设置页其他草稿保留 |
| 分隔条 UI | 拖动、键盘连发、cancel、错误重试、重载保存；一次动作最多一次最终提交；比例变化没有 resize/show/hide/focus 原生命令 |
| 元数据并发与失败 | console 与小窗先后/交错提交都保留彼此字段；几何写入不改变任务快照和 revision；真实写失败可见 |
| 几何纯函数 | 负坐标、相同屏名、断屏、混合 DPI、外框差、极小工作区、最大化/最小化正常矩形；有效跨屏位置不被贴边 |
| Mac / Windows 真机 C05/C12、W01/W05–W07、M04–M08 | 重启尺寸不漂移；断屏/唤醒后标题栏可操作；恢复和悬停不抢焦；关闭仍常驻；取消退出保留草稿。单平台或浏览器通过不能代替另一平台 |
| 首次说明与主题 | 新库、升级、有回收站数据、标记保存失败、恢复模式；关闭/重开入口清楚；四套明暗切换无窗口重建和几何重置 |

调研只读核对了 README、STATUS、HANDOFF、BACKLOG、PRD/UX、架构/数据模型、TEST_PLAN 与上述源码，并通过 GitHub API 核实 tag→commit、许可和实现。未跑新的运行时测试；实施后的证据应另记录，不能把本计划当成已完成能力。
