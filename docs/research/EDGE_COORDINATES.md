# B33：边缘小窗坐标平面复核

2026-09-25。只读发现与实施计划，**尚未修改edge实现、尚未原生验证**。本轮控制台适配不代表小窗坐标已修复。重点是正常使用中的定位、输入命中和接缝，不扩大安全范围。

## 已确认的锁定依赖事实

| 来源 | Mac真实语义 |
| --- | --- |
| Tao 0.35.3 [`util::cursor_position`](https://github.com/tauri-apps/tao/blob/5a14e624c81b7a799728129417e9218be25f17d9/src/platform_impl/macos/util/mod.rs#L101-L106) | 全局NSEvent鼠标逻辑坐标翻Y后乘**主屏scale**。Tauri WebviewWindow调用最终转到AppHandle/event-loop，不使用指针所在屏或调用窗口scale。 |
| 同版 [`window.rs`](https://github.com/tauri-apps/tao/blob/5a14e624c81b7a799728129417e9218be25f17d9/src/platform_impl/macos/window.rs#L706-L760) | window outer origin/size及inner size按**窗口自身scale**转换。Physical setter再除调用时的window scale，不能把目标屏physical坐标直接用于跨屏窗口。 |
| 同版 [`monitor.rs`](https://github.com/tauri-apps/tao/blob/5a14e624c81b7a799728129417e9218be25f17d9/src/platform_impl/macos/monitor.rs#L215-L240)；tauri-runtime-wry 2.11.4 [`work area`](https://github.com/tauri-apps/tauri/blob/ca90b46b2e2cbbc981dae1b809f4af4343fe0558/crates/tauri-runtime-wry/src/monitor/macos.rs) | 各屏position/size/visibleFrame按**该屏scale**编码。 |
| [Windows窗口](https://github.com/tauri-apps/tao/blob/5a14e624c81b7a799728129417e9218be25f17d9/src/platform_impl/windows/window.rs#L213-L277)、[Windows工作区](https://github.com/tauri-apps/tauri/blob/ca90b46b2e2cbbc981dae1b809f4af4343fe0558/crates/tauri-runtime-wry/src/monitor/windows.rs) | GetCursorPos、窗口矩形、rcWork处于物理桌面平面；Physical setter不再缩放，应保持现有行为。 |

本地安装源码/许可与以上固定commit文件逐字节核对一致；Tao的`.cargo_vcs_info`虽有dirty标记，不用该标记推断具体代码差异。Tao为[Apache-2.0](https://github.com/tauri-apps/tao/blob/5a14e624c81b7a799728129417e9218be25f17d9/LICENSE)；tauri-runtime-wry为[MIT](https://github.com/tauri-apps/tauri/blob/ca90b46b2e2cbbc981dae1b809f4af4343fe0558/LICENSE_MIT) OR [Apache-2.0](https://github.com/tauri-apps/tauri/blob/ca90b46b2e2cbbc981dae1b809f4af4343fe0558/LICENSE_APACHE-2.0)。只参考语义，没有复制第三方代码。

## 当前SideTask切点

`apps/desktop/src-tauri/src/platform/mod.rs`的tick/finish_drag直接比较这些不同来源的physical值，Mac混DPI会有假空隙/重叠和错误命中。需要同时处理：

- work_area、apply_geometry_inner：桌面工作区归一化，保留真实目标DPI参与缓存。
- apply_rect/apply_rect_live：Mac用Logical setter；实时缩放比较尺寸前先消除各自来源scale。
- tick：鼠标与panel/handle命中统一平面。
- finish_drag：选屏、左右边、源窗口中心、目标高度、offset在同一平面。
- resize_panel、Resize.top：顶部锚点单位明确，不再用旧i32全局physical混减。
- DockRuntime.geometry：区分桌面命中矩形与严格局部像素矩形。

choose_monitor/saved_monitor_index的原始position只作身份提示，get_monitors继续返回真实scale。前端EdgePanel尺寸IPC仍是逻辑宽高，不补乘devicePixelRatio；WKWebView实际screenX/Y跨屏拖动需要真机检查。

## 最小实施方向

新增独立edge_coordinates。Mac全局逻辑点/矩形用f64，来源分别除primary/window/monitor scale；现有dock_geometry继续使用**目标屏局部backing pixels和真实scale**计算客户区、8 DIP边距、18×92 DIP把手，再映射为逻辑矩形交原生setter。Windows仍physical。不能直接套控制台整数DIP/scale1，否则边缘严格像素约束可能泄漏一个backing pixel。保留无系统阴影、CSS内阴影与裁剪。

不需要数据库迁移，不修改任务/计划/设置字段。可分纯adapter、runtime入口、前端尺寸IPC/取消复审三个独立工作包；全库与原生验收由root串接。

## 验收

纯测试覆盖主屏2×/窗口1×/目标1.5×归一化、负坐标/上下排列/接缝半开区间、setter不受源window scale影响、真实DPI下像素边距和极小工作区内含、resize锚点和drag中心/offset、Windows结果不变及DPI变化缓存失效。

实际Mac混DPI输入命中、系统异步定位、拖动接缝/屏幕拔插/睡眠/Spaces与Windows矩阵仍须分别验证。数学和浏览器不能替代。状态与顺序见[BACKLOG](../delivery/BACKLOG.md)和[ROADMAP](../delivery/ROADMAP.md)。
