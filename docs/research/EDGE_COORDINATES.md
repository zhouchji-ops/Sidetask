# B33：边缘小窗坐标适配与缩放会话

2026-09-25。本文记录边缘小窗的坐标适配、原生矩形确认和显式缩放会话，以及对应算法与集成检查。范围包括定位、输入命中和缩放取消。

## 已确认的锁定依赖事实

| 固定来源 | 核实语义 |
| --- | --- |
| Tao 0.35.3 [`util::cursor_position`](https://github.com/tauri-apps/tao/blob/5a14e624c81b7a799728129417e9218be25f17d9/src/platform_impl/macos/util/mod.rs#L101-L106) | 全局NSEvent鼠标逻辑坐标翻Y后乘**主屏scale**。Tauri WebviewWindow调用最终转到AppHandle/event-loop，不使用指针所在屏或调用窗口scale。 |
| 同版 [`window.rs`](https://github.com/tauri-apps/tao/blob/5a14e624c81b7a799728129417e9218be25f17d9/src/platform_impl/macos/window.rs#L706-L760) | window outer origin/size及inner size按**窗口自身scale**转换。Physical setter再除调用时的window scale，不能把目标屏physical坐标直接用于跨屏窗口。 |
| 同版 [`monitor.rs`](https://github.com/tauri-apps/tao/blob/5a14e624c81b7a799728129417e9218be25f17d9/src/platform_impl/macos/monitor.rs#L215-L240)；tauri-runtime-wry 2.11.4 [`work area`](https://github.com/tauri-apps/tauri/blob/ca90b46b2e2cbbc981dae1b809f4af4343fe0558/crates/tauri-runtime-wry/src/monitor/macos.rs) | 各屏position/size/visibleFrame按**该屏scale**编码。 |
| [Windows窗口](https://github.com/tauri-apps/tao/blob/5a14e624c81b7a799728129417e9218be25f17d9/src/platform_impl/windows/window.rs#L213-L277)、[Windows工作区](https://github.com/tauri-apps/tauri/blob/ca90b46b2e2cbbc981dae1b809f4af4343fe0558/crates/tauri-runtime-wry/src/monitor/windows.rs) | GetCursorPos、窗口矩形、rcWork处于物理桌面平面；Physical setter不再缩放，应保持现有行为。 |
| 同版 Tao [Windows `WM_DPICHANGED`](https://github.com/tauri-apps/tao/blob/5a14e624c81b7a799728129417e9218be25f17d9/src/platform_impl/windows/event_loop.rs#L1887-L2130)；[Tauri 事件映射](https://github.com/tauri-apps/tauri/blob/ca90b46b2e2cbbc981dae1b809f4af4343fe0558/crates/tauri-runtime-wry/src/lib.rs#L515-L521) | DPI 回调仍可能再次改尺寸/位置。Tao 的 `allow_resize` 排除全屏和最大化，不以 `resizable(false)` 为禁用条件。Windows 10 使用按旧/新 scale 重算的矩形，Windows 11 使用系统建议矩形，最后再次 `SetWindowPos`。Tauri 将尺寸复制到通知，普通 `WindowEvent` 回调不能修改 Tao 那个可变引用来阻止此次调整。 |

本地安装源码/许可与以上固定commit文件逐字节核对一致；Tao的`.cargo_vcs_info`虽有dirty标记，不用该标记推断具体代码差异。Tao为[Apache-2.0](https://github.com/tauri-apps/tao/blob/5a14e624c81b7a799728129417e9218be25f17d9/LICENSE)；tauri-runtime-wry为[MIT](https://github.com/tauri-apps/tauri/blob/ca90b46b2e2cbbc981dae1b809f4af4343fe0558/LICENSE_MIT) OR [Apache-2.0](https://github.com/tauri-apps/tauri/blob/ca90b46b2e2cbbc981dae1b809f4af4343fe0558/LICENSE_APACHE-2.0)。只参考语义，没有复制第三方代码。

Windows `event_loop.rs` 也已与上述固定 commit 逐字节核对。由此可知，先设置目标物理尺寸、再跨屏定位，不能保证最终尺寸保持；这是本轮加入隐藏过渡与实际矩形确认的依据，不是 Windows 真机通过记录。

## 已实现的坐标边界

[edge_coordinates.rs](../../apps/desktop/src-tauri/src/platform/edge_coordinates.rs) 是不调用窗口、不访问数据库的纯模块。`CoordinateSpace` 明确区分 Mac 全局逻辑坐标和 Windows 物理桌面坐标；`Point` / `Rect` 使用 `f64`，不套用控制台的整数 DIP 算法。

- `cursor_point` / `window_rect` / `monitor_geometry` 分别用主屏、窗口自身、目标屏 scale 处理 Mac 输入；Windows 输入不除目标屏 scale。无效、零或负 scale 返回错误，不能降级为 1。
- `dock_layout` 先用目标屏**局部 backing pixels 和真实 DPI**调用原有 `dock_geometry`，计算面板、8 DIP 边距和18×92 DIP把手，再映射成桌面矩形。整数计算不加全局原点，避免负坐标及桌面上下界的 `i32` 加法溢出。
- Monitor 的原始工作区必须在同源原始屏幕范围内，以 `i64` 检查端点后才转换。空尺寸、非有限数、溢出、缩放过小使把手舍入为零像素等环境均拒绝。
- 屏幕命中采用半开区间。转换使用共同端点，避免小数 scale 下分别除原点/宽度产生一次浮点舍入的接缝重叠。原生投影只把可能向外的一个可表示数值间隔向内调整，不把整个矩形舍入到整数 DIP；偏好尺寸和像素边界仍按真实 DPI 计算。
- `resize_offset` / `drag_offset` 从已经按工作区钳制的实际像素面板反算顶部或中心偏移，小工作区不沿用未钳制的偏好高度。Windows 的 `Rect::physical_rect` 严格检查整数及范围，不静默截断。

[platform/mod.rs](../../apps/desktop/src-tauri/src/platform/mod.rs) 已将工作区、鼠标、原生窗口框、悬停命中、拖动选屏/左右边判断与缩放顶部锚点接到此模块。`Resize.top` 为明确平面的 `f64`，`DockRuntime.geometry` 缓存确认后的 `DockLayout`。屏幕签名保留真实 scale 与原始工作区；逻辑范围相同但 DPI 改变也会失效。原始 monitor position 继续只作同名屏幕身份提示，`get_monitors` 继续返回真实 scale。

## 原生应用与失败行为

Mac 使用 `LogicalPosition` / `LogicalSize`；Windows 使用严格转换后的 Physical setter。采样原生窗口时核对读取前后 scale 一致；变化中的窗口不作为可提交的稳定框。实时缩放先将旧、新尺寸放在同一平面，再执行收小→移动→扩大的顺序，保持原有无系统阴影、CSS 内阴影和裁剪。

隐藏迁移中，若窗口和目标屏 DPI 不同，先缩到临时小矩形并定位，等待窗口进入目标 DPI，再设置最终尺寸/位置。随后有界重复采样，要求连续两次实际框匹配目标、scale 相同且仍在工作区内；隐藏期间允许重设以修正 Windows 的 `WM_DPICHANGED` 后续调整。定位完成后再次核对屏幕签名，确认后才缓存几何并显示所需面板或把手。

实际框比较允许 `1e-6` 坐标单位的数值误差，不容忍一个整物理像素的越界或旧 DPI 尺寸。超时、原生调用失败、工作区无效或屏幕改变均清除“已应用”缓存并尝试隐藏辅助窗口，经既有错误/状态入口提示失败；不能把 setter 返回成功直接显示为生效。上述流程已接线，但操作系统异步时序和合成器表现仍须真机确认。

## 缩放会话与前端坐标

`resizePanel` 现为显式协议：`phase=start` 携带独立 `session` 和 `expectedSettings`；只有 start 能建立会话。`preview` / `commit` / `cancel` 必须携带对应 session，滞后预览或提交不能重开已取消的会话，旧 cancel 也不能结束较新的会话。

预览只修改运行态，不逐帧写 SQLite。明确 commit 再核对设置基线和屏幕签名，以同一事务保存宽高偏好与 edge placement；失败保留数据库旧值，恢复最新已提交设置和原 placement。取消不提交草稿；设置、DPI、工作区变化或 Escape 会结束原生会话。若恢复窗口本身也失败，显示原失败及恢复失败，不伪装成功。没有数据库迁移，没有增加 Task/Plan/Settings 字段，console 元数据继续沿用现有合并保存。

[usePanelResize.ts](../../apps/desktop/src/lib/usePanelResize.ts) 对应主指针、捕获和键盘手势：合并预览，只在结束且尺寸改变时提交；提交尚未发出时，pointercancel、捕获丢失、窗口失焦、卸载和 Escape 取消手势。已经发送的 commit 等待其结果，不把后到的取消描述成撤销已提交数据。无移动点击不把屏幕钳小后的实际尺寸存回偏好。交互锁有独立 owner，结束尺寸调整不解除仍在使用的分区锁；慢命令、失败和迟到快照由同一会话顺序处理。[native.ts](../../apps/desktop/src/lib/native.ts) 提供浏览器预览对应实现，不以模拟 IPC 代替原生行为。

前端尺寸和 `screenX/Y` 位移继续按 CSS 逻辑像素处理，不补乘 `devicePixelRatio`。所参考的固定官方规范如下；规范单位不能证明 WKWebView/WebView2 在跨屏时的实际事件时序。

| 固定参考 | 本轮采用的语义 |
| --- | --- |
| W3C CSSOM View，commit `c4def7738dfa46433a522ca362888bb2fd1b26df`：[坐标单位](https://github.com/w3c/csswg-drafts/blob/c4def7738dfa46433a522ca362888bb2fd1b26df/cssom-view-1/Overview.bs#L326)、[MouseEvent screen/client 坐标](https://github.com/w3c/csswg-drafts/blob/c4def7738dfa46433a522ca362888bb2fd1b26df/cssom-view-1/Overview.bs#L2072-L2100) | 默认单位为 CSS pixels；screenX/Y 相对暴露给 Web 的屏幕区域，clientX/Y 相对 viewport，不能混用或当成原生 physical 坐标。 |
| W3C Pointer Events，commit `49c398264c8d129aff141cd261b4b4c4fcb3d126`：[lostpointercapture](https://github.com/w3c/pointerevents/blob/49c398264c8d129aff141cd261b4b4c4fcb3d126/index.html#L1374) | 释放捕获会产生独立的捕获丢失通知。正常 pointerup 进入结束状态后，释放捕获产生的后续通知不能再把同一次提交取消或重复提交。 |

已核对 [CSSWG LICENSE](https://github.com/w3c/csswg-drafts/blob/c4def7738dfa46433a522ca362888bb2fd1b26df/LICENSE.md) 与 [Pointer Events LICENSE](https://github.com/w3c/pointerevents/blob/49c398264c8d129aff141cd261b4b4c4fcb3d126/LICENSE.md)，均为 W3C Software and Document License。只参考 API/交互语义，没有复制规范文本或样例代码，也没有新增第三方依赖。

## 算法与集成检查记录

| 证据层 | 本阶段记录 |
| --- | --- |
| 独立纯模块 | 系统临时目录使用 `rustc --test` wrapper，edge_coordinates 的13项与既有 geometry 的2项全部通过，合计15/15；本人文件 rustfmt 通过。覆盖主屏2×/窗口1×/目标1.5×、负坐标/上下排列/半开接缝、小数像素、极小工作区、零把手拒绝、work 内含、尺寸/坐标溢出、Windows 结果不变、拖放/缩放锚点及 DPI 签名变化。 |
| Rust 中间集成 | 主任务本轮检查138/138通过，clippy `-D warnings` 通过。新增运行态回归覆盖取消与旧会话拒绝、设置/DPI 失效、显式请求协议、实际矩形确认拒绝旧尺寸和整像素越界。后续集成仍可能调整，当前汇总结果见内部验证记录（本地保留，不随公开仓库分发）。 |
| 前端回归范围 | [panel-resize.spec.ts](../../apps/desktop/tests/panel-resize.spec.ts) 已覆盖取消/捕获丢失/失焦/卸载、无移动点击、键盘连发、慢提交/迟到快照、start/commit 失败、跨窗设置变化、锁 owner 与浏览器零写入取消。 |

原生观察记录窗口外框、输入区域及可见结果；算法与浏览器检查对应各自的测试环境。

## Mac原生点网格修正（2026-09-25，mac分支）

e844fcd在macOS26.4.1 / 内屏2×实测：期望y=125.5逻辑点，AppKit回读y=126，其他坐标和368×610尺寸一致；原严格差值比较反复失败并暂停小窗。此结果不是混合DPI或动画越界证据，而是单屏真实setter量化差异。

保留局部物理像素算法和分数工作区；仅Mac在输出原生调用前通过`mac_native_rect`投影到整逻辑点：尺寸向下取整且不超过工作区可用整数范围，位置就近取整后限制在ceil(工作区起点)到floor(终点)-尺寸之间。偏好值不因投影被写回，严格边界、scale匹配、两次实际矩形采样继续保留，不以放大容差接受越屏。缓存仍使用实际确认框。Windows原生设置路径不变。

纯回归覆盖观察到的125.5→126、下边界向内校准、负坐标/分数工作区、幂等和不足1点拒绝。当前最终原生与自动化证据见内部验收记录（本地保留，未随公开仓库分发），不能沿用先前未实测结论。
