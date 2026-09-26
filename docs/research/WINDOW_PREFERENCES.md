# 窗口偏好与首次说明：最小实施计划

2026-09-25，方案及分阶段实现记录。**分区比例与控制台几何已实现；本文记录时原生待验，首次说明在本阶段接入。未安装插件**。接续 B09（分区/尺寸）、B19/B21（控制台恢复）、B25（首次使用）；当前集成检查、生命周期验收与交付状态见[验证摘要](../VALIDATION.md)。

## 结论与现状

下表是实施前核对的起点，当前落地状态见文末。首轮复用现有 Rust 设置服务和 SQLite，不引入 window-state 插件。只补三个缺口：小窗分区比例跨重启保留，控制台恢复上次普通窗口几何，用户知道关闭后从哪里找回应用。

| 已核对源码 | 当前行为 | 最小接续 |
| --- | --- | --- |
| [EdgePanel.tsx](../../apps/desktop/src/surfaces/edge-panel/EdgePanel.tsx) | `split` 为内存状态，默认 54，范围 30–70；已有分隔条方向键、指针捕获和交互锁 | 分隔条拖动仍只更新页面；操作结束保存一个设置字段 |
| [Settings](../../apps/desktop/src-tauri/src/domain/mod.rs)、[前端校验](../../apps/desktop/src/lib/domain.ts) | 设置在快照内；字段白名单和旧值兼容明确，任务备份恢复保留本机设置 | 仅加 `panelSplit`；一次说明状态修订为 placement 根字段，见阶段三 |
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

新增 `Settings.panelSplit`，整数百分比 30–70，缺省 54。Rust serde、设置白名单与校验，TS 类型/校验/旧预览默认同步补齐；只在正常写入时持久化缺省，不重写原任务。`same_window_layout` 继续只比较原生几何/显隐字段，**panelSplit 不能进入该比较**；usageGuideSeen 不属于 Settings，不参与设置或尺寸会话比较。

- 拖动开始记下已提交值，保持指针捕获与交互锁；move 只更新本地比例。pointerup 最多提交一次；cancel / 捕获丢失 / 卸载释放锁并取消尚未提交的预览。只接受主指针左键，避免重复 pointerup / lostcapture 双提交。
- 方向键仍每次 5%，按键连发在 keyup / 失焦后合并保存；新快照仅在未拖动、无未提交预览时同步本地值。与设置页并发变化按字段核对，失败保留可重试的比例草稿，不覆盖别的设置。
- 比例按两个内容区可分配高度计算，先扣分隔条；保留当前两个 `minmax(76px, …)` 下限。最小窗口、错误条和完成反馈出现时，两个标题与首项基本操作仍可见；虚拟列表跟随实际容器高度重新测量，不重置任务和滚动位置。

## 阶段二：控制台几何

在现有 placement JSON 增加可缺省的 `console` 子对象：普通窗口逻辑 inner width/height、屏幕名称及原位置辅助匹配、相对该屏工作区的逻辑 outer x/y 偏移、最大化偏好。偏移允许负值以表达正常横跨屏幕；不把物理桌面原点截为零。保存的是正常矩形，最小化、全屏和最大化过程的临时矩形不能覆盖它；首轮不恢复全屏、隐藏或焦点状态。

设备记录分开持有 edge 与 console 运行态；在 SQLite 同一个 placement key 中按各自拥有的字段合并。`finish_drag` 及失败回滚只管理 edge，不能用内存整份对象覆盖数据库中更新的 console。Repository 为仅设备几何更新提供事务合并方法：不改 Task、Plan、snapshot revision，不重编码 snapshot；不新增第二份文件存储。便携任务恢复继续保留这些本机配置。若最终选择新 app_state key，则必须同步现有严格 key 白名单和版本迁移，不能直接插入一个旧程序拒绝读取的记录。

恢复次序：

1. 控制台隐藏创建，恢复操作本身不抢焦点。枚举当前有效工作区及 DPI；优先匹配已保存屏幕，名称重复时结合原位置，再回退主屏/首个有效屏幕。无有效屏幕时保留待恢复状态，不写回无效坐标。
2. 用目标屏当前 scale 将逻辑 inner 尺寸转物理；根据实际 outer / inner 差处理标题栏边框，再恢复相对工作区的位置。普通窗口在现有布局中可操作时保留跨屏位置；若原屏消失或标题栏不可达，调整到有效工作区。不能仅用“一角仍与屏幕相交”判定成功。验收至少要求一块当前工作区内有可抓取标题栏和关闭按钮，内容有可操作的视口。
3. 工作区小于现有 880×620 最小值时，可用空间优先，调整本次原生 minimum 并验证窄布局；不要强迫窗口超出屏幕。应用完成后重读实际几何，确认可达，再按已保存偏好最大化；由明确的启动/托盘/管理任务意图决定显示和聚焦。恢复期间的 move/resize 事件不反写默认值。
4. 普通 move/resize 只合并内存候选，稳定约 400ms 后一次保存；关闭隐藏和已确认退出时补一次未落盘值。主事件回调不等待持有 service/dock 锁的线程，存储锁不跨原生窗口调用。保存失败保留当前可用窗口、显示“本次位置未保存”并可重试，不把移动操作回弹或卡住草稿处理。
5. 重开隐藏控制台、屏幕布局变化及唤醒时重新检查可达性；有效位置不主动重排，不跟随鼠标换屏，不因修复位置调用 set_focus。每次校准有代次，过期结果不能覆盖用户后续移动。恢复模式没有正常 AppState 时使用安全默认几何，不写任务库设备记录。

## 阶段三：首次打开与关闭说明

首次主动打开正常控制台，显示一条可关闭的内联说明：“任务可从屏幕边缘快速查看。关闭这个窗口后，侧笺仍在菜单栏或托盘运行；可从那里重新打开或退出。”配“打开边缘小窗”“知道了”，已有默认停靠可直接使用，不强制逐步配置。设置页保留同一段可再次找到的说明；有已有任务的升级用户也最多看一次，不遮挡任务列表。

`placement.usageGuideSeen` 缺省 false，用户确认后专用 IMMEDIATE 事务只置 true、合并其他元数据；不放 Settings 或 placement.console，不改任务快照原字节、revision、比较基线，schema4及便携任务v2不变。已 true 幂等不写，非法类型返回可重试错误、不覆盖坏记录。任务JSON恢复保留该设备标记，整库恢复可能带回旧标记再展示一次。失败不宣称已记住，下次仍可出现。不靠任务数量判断是否首次。普通关闭仍走既有行为，未保存草稿继续既有保护，不额外弹“是否真的关闭”。关闭后 WebView 已隐藏，在里面发 toast 用户看不到；首轮在关闭前的首次说明解释去向即可，必要时下一次主动重开补一句状态说明。不开系统通知、不请求新权限、不为了显示说明自动展开小窗或重新激活应用。损坏启动恢复页面不显示正常常驻说明。

## 验收与拆分

先做分区比例，再做纯几何计算/元数据合并，最后接原生恢复与首次说明；每步通过后复盘。实现时同步 PRD/UX、数据模型和内部待办；检查证据见内部验收记录（本地保留，未随公开仓库分发）。

| 必须新增/复验 | 通过标准 |
| --- | --- |
| TS/Rust 设置兼容与说明元数据 | panelSplit缺省54、独立usageGuideSeen缺省false；边界和非法值明确；任务、DDL、Plans 不变；设置页其他草稿保留 |
| 分隔条 UI | 拖动、键盘连发、cancel、错误重试、重载保存；一次动作最多一次最终提交；比例变化没有 resize/show/hide/focus 原生命令 |
| 元数据并发与失败 | console 与小窗先后/交错提交都保留彼此字段；几何写入不改变任务快照和 revision；真实写失败可见 |
| 几何纯函数 | 负坐标、相同屏名、断屏、混合 DPI、外框差、极小工作区、最大化/最小化正常矩形；有效跨屏位置不被贴边 |
| Mac / Windows 真机 C05/C12、W01/W05–W07、M04–M08 | 重启尺寸不漂移；断屏/唤醒后标题栏可操作；恢复和悬停不抢焦；关闭仍常驻；取消退出保留草稿。单平台或浏览器通过不能代替另一平台 |
| 首次说明与主题 | 新库、升级、有回收站数据、标记保存失败、恢复模式；关闭/重开入口清楚；四套明暗切换无窗口重建和几何重置 |

最初只读调研核对了 README、STATUS、HANDOFF、BACKLOG、PRD/UX、架构/数据模型、TEST_PLAN 与上述源码，并通过 GitHub API 核实 tag→commit、许可和实现。当时未跑新的运行时测试；随后阶段一实现证据记录于下节，不能把尚未实施的其余计划当成已完成能力。

## 阶段一实现记录

`Settings.panelSplit` 已接入 Rust/TS，缺省54、只接受30–70整数。旧schema3快照缺字段读取时不重写snapshot，正常设置保存后落盘；当前schema3保持不变。与原有uiStyle一样，这是新程序读取旧数据的单向兼容：较旧的schema3程序因未知设置字段而拒绝，不支持将当前库交给旧App继续写；不通过去掉严格字段校验来假装支持降级。便携任务备份仍排除设备设置，恢复保留当前比例。将来placement结构变化时再统一评估数据库版本迁移。

`usePanelSplit` 单独维护手势预览和待保存比例：只接收左键主指针；move只改本地，up一次保存，cancel/丢失捕获/窗口失焦取消指针预览并释放锁。方向键每次5%、Home/End到边界，连发在keyup或离开焦点合并保存；Escape取消键盘预览。扣除分隔条后计算比例。保存期保留交互锁，重复输入不重复提交；失败保留比例，可重试或恢复已保存值。同字段跨窗改变时立即显示冲突，只有明确“使用此比例”才按当前版本提交，不覆盖其他设置。

比例本身不进入same_window_layout，不发送resize/show/hide/focus原生命令；仅手势与保存过程使用既有interaction锁。隐藏、尺寸、风格和今日/DDL任务逻辑保留。

定向证据：99/99 TS、93/93 Rust（含临时SQLite保存重开与完整任务/计划对比），fmt/clippy通过；5/5 panel-split UI覆盖拖动单次写入、重载/跨窗同步、取消与真实捕获丢失、非主指针、键盘合并、慢保存、失败回退和冲突。另有368×380失败态标题/首项与footer可达检查。最后焦点补丁后完整67UI（1.4分钟、无重试）与Mac构建通过，资源index-B-9KMQ89.js / index-BN07M5pO.css；原生缺口以[验证摘要](../VALIDATION.md)为准，浏览器IPC协议不代表真实系统窗口验证。

## 几何实施前复核（历史计划，当前实现见下节）

独立只读复审确认，不能仅给Placement追加字段后直接保存：finish_drag重建整个Placement，resize及多处失败/解锁回退也会整份覆盖，必须让edge与console字段各自合并。为console元数据提供IMMEDIATE事务patch：只读取/更新placement现有key，不重编码snapshot或改变Task/Plan/revision，也不发任务变更事件；成功/错误状态单独保存，不能复用被tick清除的window_error。

建议console记录普通窗口的逻辑inner尺寸、屏幕名称及物理原点辅助匹配、相对工作区的逻辑outer偏移和maximized。运行态存正常矩形、候选、稳定时间、generation、restoring与错误；最小化/全屏/最大化过渡不能覆盖普通矩形。事件只投递重采样，不在native回调持锁读SQLite；在锁外采样和应用原生调用，过期generation丢弃。关闭前排最终采样/flush；已确认退出时在authorized标志前落盘，释放锁后退出，几何失败不能卡住草稿退出。

几何扩展阶段建议统一schema4迁移：旧schema3 Placement会忽略未知console字段并在小窗整份保存时静默丢弃，和当前panelSplit被旧Settings明确拒绝不同。用原有先备份/保原snapshot和placement字节方式建立版本边界，同时更新恢复版本/候选；不搬任务表。字段坏时只回退对应console偏好，不因整个placement反序列化失败丢掉有效edge数据。复核时尚未作这些改动，当时schema仍3；随后实现见下节。

## 阶段二实际实现与复盘

采用 [ADR-0006](../decisions/0006-console-window-preferences.md)。schema4升级前一致性备份，原snapshot/placement字节保留。Repository `save_console_placement`只在IMMEDIATE事务中patch console，不读取、校验或重编码任务快照、不改revision/baseline；edge保存只patch monitorName/monitorPosition/offset，保留其他字段。两个连接交错写、CAS旧任务、写失败回滚、损坏/超限元数据和schema3升级失败均有合成SQLite回归。新增设备状态不进入便携v2任务备份。

`console_geometry`负责显示器匹配、逻辑客户区大小、真实边框、工作区与可达标题栏；恢复失败的应急位置按**当前真实外框宽度**保留关闭端和拖动段，不能假设失败的set_size已经生效。大窗仍可正常跨屏。极小工作区优先于880×620常规最小值；UI在640×480与800×560的极简/暖刊新建、详情、设置链路均可操作，证据见手工记录。这是浏览器布局验证，不是系统窗口验收。

锁定 Tao 0.35.3 与 tauri-runtime-wry 2.11.4 本地依赖源码复查发现，Mac窗口origin按窗口自身scale换算，而每屏origin/workArea按各屏scale换算，混合DPI不能直接相交。`console_coordinates`把各自坐标除以来源scale，统一为全局AppKit逻辑DIP；算法scale=1，原物理屏原点仅作身份提示，原生设置使用LogicalPosition/LogicalSize。Windows保留物理桌面平面及目标scale。整数逻辑转换有至多0.5DIP的单项取整误差，边框与客户区分别取整后外框至多1DIP；恢复确认容忍2单位。不复制上游代码、不增依赖。**同类差异仍存在于旧edge路径，另列[B33](EDGE_COORDINATES.md)，不能因控制台修复宣称整个小窗多屏通过。**

控制台隐藏创建，先恢复并核对普通矩形，再核对最大化，然后由明确启动意图显示；隐藏恢复本身不抢焦点。事件回调只增加代次/投递意图，worker在锁外采样和原生应用，main-thread应用前复核代次。移动稳定400ms后保存，平时每5秒及显式重开检查可达性；不逐帧重写任务。首次恢复有3秒退路，错误保留旧记录并尝试保守显示；关闭取消待显示意图，不在初始化末尾又弹回。关闭隐藏和确认退出补采样/flush，几何失败不阻塞已明确处理草稿的退出。

复审修复了：读取失败后错误解除保存阻断；未采样新位置在“丢弃”后又保存；部分set_position/set_size失败污染旧偏好；最大化失败被当成普通状态保存；flush把未保存误报成功。失败后自动采样不能改旧saved；“重试保存位置”明确保存当前可用位置，“不保存本次位置”记住当前候选并忽略直到下一次移动，均先成功采集再提交运行态切换。反馈独立于edge窗口错误和任务草稿，按钮等待时允许继续编辑，失败焦点归还只在用户没有主动转移焦点时发生。

Windows 092cfa9 CI的午夜断言失败来自运行中的测试时钟跨过初始一秒，产品正确显示到期；按[Playwright官方Clock](https://playwright.dev/docs/api/class-clock#clock-pause-at)改成加载就绪后暂停到指定时刻，再显式推进，注入1.5秒慢加载重复3次通过。新CI仍须验证。

本阶段检查、失败尝试、包和原生限制见内部验收记录（本地保留，未随公开仓库分发）；当前汇总范围见[验证摘要](../VALIDATION.md)。纯状态/故障回归不能当作原生故障注入成功，Mac锁屏及Windows/混DPI真机矩阵仍未闭合。

## 首次说明的固定参考

参考 VS Code 1.105.0 固定提交 `03c265b1adee71ac88f833e065f7bb956b60550a` 的[Getting Started入口](https://github.com/microsoft/vscode/blob/03c265b1adee71ac88f833e065f7bb956b60550a/src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts)和[已读状态处理](https://github.com/microsoft/vscode/blob/03c265b1adee71ac88f833e065f7bb956b60550a/src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.ts)，[MIT许可](https://github.com/microsoft/vscode/blob/03c265b1adee71ac88f833e065f7bb956b60550a/LICENSE.txt)。只借鉴独立说明状态及可再次找到的帮助入口，不复制代码或引入教程框架。SideTask采用正常文档流的一段说明，保留当前任务优先布局。
