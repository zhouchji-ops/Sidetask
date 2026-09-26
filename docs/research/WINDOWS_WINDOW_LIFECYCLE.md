# Windows 边缘窗口首显与 WebView2 退出

更新：2026-09-25。对应 WIN-01 / B39，说明 Windows 专用实现、锁定依赖依据和本轮原生证据。共同起点为 `909a7344618c88151dacd4803ab2f6a92fc2d394`；以下修复在本轮工作区构建验证，最终产品提交、构建与证据索引由内部验收记录（本地保留，未随公开仓库分发）登记。不能把起点 SHA 当作包含修复的版本，也不据此关闭多屏和双平台验收。

## 首显为什么会扩宽

Windows 11 x64、单屏150%（DPI144）实测：把手隐藏时已经确认27×138物理像素，第一次显示仍可能变为202×138。错误发生在原生窗口框，不能由 CSS 宽度或最终 `status.error=null` 判断已经消失。

锁定 Tao 0.35.3 的调用链解释了触发条件：

1. `Window::new` 先执行包含 `CreateWindowExW` 的初始化，再安装处理 `WM_GETMINMAXINFO` 的窗口子类。SideTask 的 `min_inner_size(1,1)` 因而不能覆盖最早的 HWND 创建消息；本机隐藏创建框已观察到202px宽。
2. 无边框顶层窗口的 Tao 原生样式仍包含 `WS_CAPTION`，外观由非客户区处理实现；不能据 `decorations(false)` 假定创建时不存在普通窗口最小尺寸行为。
3. `focused(false)` 对应的显示分支调用 `SW_SHOWNOACTIVATE`。Win32 将它定义为按最近的尺寸/位置显示；`SW_SHOWNA` 则保持当前尺寸/位置。两种显示路径在本机首次显示时有不同结果。[Tao 窗口创建](https://github.com/tauri-apps/tao/blob/5a14e624c81b7a799728129417e9218be25f17d9/src/platform_impl/windows/window.rs)、[Tao 显示分支](https://github.com/tauri-apps/tao/blob/5a14e624c81b7a799728129417e9218be25f17d9/src/platform_impl/windows/window_state.rs)、[ShowWindow 官方语义](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-showwindow)

本轮诊断在显示前读到的 `rcNormalPosition` **已经是27×138**，并非简单地保存着202px旧框。因此修复不描述成“同步恢复矩形”；可以确认的是，避开首次 `SW_SHOWNOACTIVATE` 的恢复处理后，同条件没有再观察到扩宽。Win32 未公开的内部状态不作进一步确定性推断。

## 显示实现与取消边界

[windows_visibility.rs](../../apps/desktop/src-tauri/src/platform/windows_visibility.rs) 在同一个主线程调用中执行 `SW_SHOWNA → window.show()`。第一步保持已经确认的当前框；第二步同步 Tao 的 `VISIBLE`，使后续普通 `window.hide()` 继续有效。仅调用原生 show 会造成 OS 与 Tao 可见状态分离，因此不能省略同步。该桥接只供 `edge-panel` 和 `edge-handle` 使用，Mac 显示路径不变。

锁定 runtime-wry 的主线程 dispatcher 直接执行 `window.show()`，Tao 在窗口所属线程也立即执行，不需要等待另一个事件循环轮次。调用中不持有事务状态锁跨越原生 API。[runtime-wry dispatcher](https://github.com/tauri-apps/tauri/blob/ca90b46b2e2cbbc981dae1b809f4af4343fe0558/crates/tauri-runtime-wry/src/lib.rs)、[Tao 线程执行器](https://github.com/tauri-apps/tao/blob/5a14e624c81b7a799728129417e9218be25f17d9/src/platform_impl/windows/event_loop.rs)

每次显示有独立事务与2秒截止，防止仅让调用者超时、旧回调随后仍显示窗口：

- 排队回调若已取消或超过截止，不开始显示。
- 执行中在原生 show 前后及最终提交时检查有效性；失效时先原生隐藏，再同步 Tao hide，补偿在同一个主线程回调内完成。
- 完成与等待超时争用同一状态；已经完成的结果保留，避免因为唤醒消息稍晚就误判超时。
- 同步 Win32 调用不能安全抢占。若调用本身跨过截止，返回后补偿隐藏；这不是整个窗口请求或系统调用的硬2秒完成保证。后续恢复排在旧回调之后，避免旧补偿覆盖新的重试。

[platform/mod.rs](../../apps/desktop/src-tauri/src/platform/mod.rs) 仍在 show 后两次检查实际框、DPI和工作区；不匹配时先隐藏、确认隐藏、重新应用矩形，最多重试一次，仍失败则报告错误。这个检查继续防御 DPI 和系统异步变化，不能因为首显 A/B 通过而删除。坐标与严格边界契约见 [EDGE_COORDINATES](EDGE_COORDINATES.md)。

`WINDOWPLACEMENT` 仅用于本轮只读诊断，不写入修复路径。普通顶层窗口的 placement 使用工作区坐标，而 `GetWindowRect` 使用屏幕坐标；Tao `skip_taskbar` 通过任务栏接口删除按钮，不等于设置 `WS_EX_TOOLWINDOW`。不能直接把两个矩形互写。[WINDOWPLACEMENT 坐标说明](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-windowplacement)

## 1412 为什么在最终退出时处理

`Failed to unregister class Chrome_WidgetWin_0. Error = 1412` 来自 Chromium 窗口类注销路径。错误码1412表示注销时该类仍有窗口；固定 Chromium126源码在退出回调中执行 `UnregisterClass` 并输出这一错误。它与首显宽框是两个问题，不能把日志直接归为无害噪声。[Chromium 注销源码](https://github.com/chromium/chromium/blob/126.0.6478.127/ui/gfx/win/window_impl.cc)、[Windows 错误码](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--1300-1699-)

Tauri 2.11.6 的正常 `App::run` 最终直接退出进程；其 `cleanup_before_exit` 清资源表并隐藏 Windows 窗口，没有显式关闭所有 WebView2 controller。wry 的 `InnerWebView::Drop` 虽然会调用 controller.Close，但仍存活的 WebView 不能依赖进程退出时运行 Rust Drop。[Tauri 生命周期](https://github.com/tauri-apps/tauri/blob/9452ddee5ebefd9b678a94ff003521379df6c9ae/crates/tauri/src/app.rs)、[wry WebView2 释放](https://github.com/tauri-apps/wry/blob/a5bf203a1c8dbb3583588382538d6521655222a8/src/webview2/mod.rs)

[lib.rs](../../apps/desktop/src-tauri/src/lib.rs) 仅在 Windows 的最终 `RunEvent::Exit` 调用 [windows_webview_shutdown.rs](../../apps/desktop/src-tauri/src/platform/windows_webview_shutdown.rs)。Tauri 在这一事件中先调用产品回调、随后才执行自己的 cleanup，因此 controller 仍可在所属主线程经公开 `with_webview` API 同步关闭。helper 再次检查现有退出授权，逐窗记录 Close 成功或 HRESULT/dispatch失败；清理错误不 panic，也不阻止已经确认的退出。

官方建议显式 Close；该方法同步释放 WebView及事件引用，不触发 beforeunload，也不关闭父 HWND。它在 SideTask 草稿握手完成之后调用，不承担保存草稿的职责。[ICoreWebView2Controller::Close](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller?view=webview2-1.0.3537.50#close)

取消退出、普通控制台关闭/隐藏和 `ExitRequested` 都不会关闭 controller。恢复模式也复用此授权：`RecoveryGate::restart` 只允许 Recovered→Exiting，释放锁后才 `request_restart`；恢复进行中收到退出请求，会等恢复结束并转为Exiting才退出。`exit::is_authorized` 查询对应恢复状态，因此正常恢复后的重启能进入同一清理路径。本轮全量12项恢复原生案例已通过，其中恢复后的重启通过真实WebView2的CDP页面按钮触发，并核对重启后的数据与窗口状态；这覆盖恢复重启清理路径，不等于物理鼠标输入或恢复瞬间强杀验收。

成功日志每次最终退出仅包含现存窗口label和Close耗时，可用于区分“回调实际执行”和“只成功发送消息”；它不包含任务内容，也不能证明浏览器子进程已在同一时刻全部退出。

## 本轮实际证据

原生执行和 Cargo 由根任务完成；本说明作者只读复核日志、JSON和固定源码。环境为 Windows11 x64、150%单屏、WebView2 `126.0.2592.102`。证据位于本地工作区的 `artifacts/windows-next/`，生成物和合成数据库不入库。

| 检查 | 实际结果 | 本地证据 |
| --- | --- | --- |
| baseline 首显 | 1393ms隐藏框27×138；1438ms可见框202×138；1485ms恢复27×138，探针观察宽框约47ms | `baseline-startup/frames.json` |
| show A/B | 1476ms首次可见把手27×138；显示前、SW_SHOWNA后、Tao show后的actual和normal框均保持27×138 | `show-experiment/startup/frames.json`、`stderr.log` |
| Tao显隐同步 | pinned=true下5轮实际IPC展开/收起，加Win32只读采样；panel552×915和handle27×138正确交替显隐 | `show-experiment/cycles-pinned.json` |
| 草稿取消退出 | 草稿保留，console/edge-panel/edge-handle三个WebView仍存活，stderr为空 | `combined-experiment/cancel.json` |
| 保存并退出 | console/handle/panel的Close分别记录30/8/9ms成功，无1412；刚退出时尚有浏览器子进程，后续复查已全部清退 | `combined-experiment/startup/stderr.log`、`processes-after-quit.json`、`processes-after-settle.json` |
| 恢复及重启退出 | 全量12项恢复案例通过，包含恢复后真实重启；共19次App启动/退出、41条Close成功，耗时7–25ms；12份stderr中1412与Chrome_WidgetWin_0匹配数均为0 | `recovery/native-2026-09-25T08-35-41-654Z-6cac9948/report.json`、同目录`stderr-summary.json` |
| Rust检查 | fmt、clippy通过；153项测试通过，包括新增5项显示事务取消/截止/完成竞态契约 | `rust-fmt.log`、`rust-clippy.log`、`rust-tests.log` |

采样毫秒数是各次探针相对时间，不作启动性能对比，也不声称合成器连续每帧都无闪烁。Close日志是调用耗时，子进程由后续离散检查确认清退，未测精确退出时长。恢复与退出日志只证明本机这一轮未复现1412，不保证所有退出路径、压力或其他环境均无此错误。Rust测试日志含链接器创建库/对象的提示；153项测试结果仍为通过，不把它描述成完全无输出。

尚未由这些证据覆盖：真实多屏、负坐标、混合DPI、拔插/睡眠、物理鼠标悬停与外部应用连续输入焦点、透明区域完整命中、所有真实拖动/缩放/IME路径及持续使用。IPC显隐与最终矩形正确不能替代这些矩阵，也不能关闭B39/B41或双平台父项。

## 固定来源、许可与复核

依赖保持锁定：Tao0.35.3、Tauri2.11.6、runtime-wry2.11.4、wry0.55.1、webview2-com0.38.2。实现只使用现有公开API和自主Win32桥接，没有升级依赖、复制上游实现或引入新第三方组件。

| 来源 | 固定版本/提交 | 许可 |
| --- | --- | --- |
| Tao | `5a14e624c81b7a799728129417e9218be25f17d9` | [Apache-2.0](https://github.com/tauri-apps/tao/blob/5a14e624c81b7a799728129417e9218be25f17d9/LICENSE) |
| Tauri | `9452ddee5ebefd9b678a94ff003521379df6c9ae` | [MIT](https://github.com/tauri-apps/tauri/blob/9452ddee5ebefd9b678a94ff003521379df6c9ae/LICENSE_MIT) OR [Apache-2.0](https://github.com/tauri-apps/tauri/blob/9452ddee5ebefd9b678a94ff003521379df6c9ae/LICENSE_APACHE-2.0) |
| tauri-runtime-wry | `ca90b46b2e2cbbc981dae1b809f4af4343fe0558` | [MIT](https://github.com/tauri-apps/tauri/blob/ca90b46b2e2cbbc981dae1b809f4af4343fe0558/LICENSE_MIT) OR [Apache-2.0](https://github.com/tauri-apps/tauri/blob/ca90b46b2e2cbbc981dae1b809f4af4343fe0558/LICENSE_APACHE-2.0) |
| wry | `a5bf203a1c8dbb3583588382538d6521655222a8` | [MIT](https://github.com/tauri-apps/wry/blob/a5bf203a1c8dbb3583588382538d6521655222a8/LICENSE-MIT) OR [Apache-2.0](https://github.com/tauri-apps/wry/blob/a5bf203a1c8dbb3583588382538d6521655222a8/LICENSE-APACHE) |
| Chromium日志机制参考 | tag `126.0.6478.127` | [BSD三条款](https://github.com/chromium/chromium/blob/126.0.6478.127/LICENSE)；不是把该tag当作本机Edge运行时的逐字节源码 |

本说明作者读取锁定crate及许可证，并从上述固定提交下载后逐文件比较SHA256，**8/8一致**：Tao的window.rs/window_state.rs/LICENSE，wry的webview2/mod.rs/LICENSE-MIT，Tauri的app.rs/LICENSE_MIT，runtime-wry的lib.rs。记录在本机 `references/source-comparison.json` 和 `references/exit-source-comparison.json`。Tao/wry源码的dirty元数据不替代逐文件比较；本轮没有将该标记当成差异证据。检查到的Tao、wry、runtime-wry发布源码未带独立NOTICE，现有LICENSE/SPDX记录保留。

Win32/WebView2官文用于确认API语义；WebView2文档固定view为`webview2-1.0.3537.50`，基础Close方法早于本机运行时已提供。文档和源码分析只支撑实现选择，原生行为结论以上述本机记录为限。
