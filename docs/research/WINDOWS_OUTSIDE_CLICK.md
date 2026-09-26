# Windows 真实外部点击

日期：2026-09-25。对应 B45，实现位于 `apps/desktop/src-tauri/src/platform/windows_pointer.rs`，验证范围见内部验收记录（本地保留，未随公开仓库分发）。

## 行为与事件源

单击模式只因真实 mouse-down 收起；Alt-Tab、程序激活另一窗口或单纯失焦不触发。外点可以隐藏正在输入的小窗，但 WebView 与 QuickTodayAdd 继续存活，重开保留草稿。固定展开、拖动、缩放、退出确认优先，悬停模式继续使用原有延迟和交互锁。

Windows 在独立 `sidetask-pointer` 消息线程安装 `WH_MOUSE_LL`，观察左、右、中、X 键按下；不依赖主键配置，不用按钮轮询，因此短点击不必跨越80ms采样周期。回调无 Tauri 操作、业务锁或数据库写入，只进行原生目标查询和 channel 通知，始终返回 `CallNextHookEx` 的结果，不消费输入。退出在原线程消息循环结束时卸载 Hook，启动安装失败返回可见错误，不悄悄退回失焦收起。

使用事件自带的物理桌面坐标和 `WindowFromPhysicalPoint`，保留负原点；不会读取稍后移动的指针或按主屏缩放换算。目标窗口的 child/root/owner 链区分小窗、把手及其原生子窗；前台 capture 与小窗所属菜单的路由优先，避免菜单选项被当成外点。别的应用覆盖小窗时按实际命中窗口判断，不能仅凭面板矩形说点击在内部。

用事件的系统时间戳换算 `Instant`，包含32位计数回绕；协调器继续检查显示/模式/手势边界，旧排队点击不能关闭后来展开的小窗。输入锁只阻止悬停离开收起，不能挡住显式外点。Mac 事件源与统一草稿/退出/数据协议不变。

## 一手资料、依赖与限制

- [LowLevelMouseProc](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelmouseproc)：独立线程消息循环、迅速返回及调用下一 Hook 的要求。低级 Hook 若超时可能被系统静默卸载，因此回调不做应用逻辑；当前没有声称能检测所有系统卸载情形。
- [MSLLHOOKSTRUCT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-msllhookstruct)：事件坐标、时间戳与其他鼠标键。
- [WindowFromPhysicalPoint](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-windowfromphysicalpoint)、[GetGUIThreadInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getguithreadinfo)：物理命中与原生 capture/menu 路由。
- 直接引用锁文件已有的 `windows-sys = 0.61.2`，源码 `.cargo_vcs_info.json` 固定为 `32c3144490c016fe496a0aed769bce60987a2e9d`；[源码](https://github.com/microsoft/windows-rs/tree/32c3144490c016fe496a0aed769bce60987a2e9d/crates/libs/sys)、[MIT许可](https://github.com/microsoft/windows-rs/blob/32c3144490c016fe496a0aed769bce60987a2e9d/license-mit)。本机 crate 中 MIT/Apache-2.0 声明及 MIT 原文已核对。只调用系统 API，无第三方实现复制，没有新增鼠标驱动或权限配置。

Raw Input 是微软建议的多数后台输入场景替代方案，但普通鼠标 raw event 没有本需求所需的事件时刻绝对命中目标；轮询当前指针也不能代替事件点。本轮选用有物理事件点的低级鼠标通知，不处理键盘，不拦截鼠标。安全桌面、其他登录会话、独占全屏、设备厂商手势不在已验证保证内；混DPI/多屏与真实实体侧键、交换主键必须分别记录，不用函数单测代替真机验收。
