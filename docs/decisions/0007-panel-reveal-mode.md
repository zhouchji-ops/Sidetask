# ADR-0007：小窗默认单击与可选悬停

日期：2026-09-25。状态：目标契约采用；Mac 已有真实外点实现，Windows 整合暂保留失焦/输入保护路径，差异及最终原生复验由 B45/B43 跟踪。

## 用户要求与决定

用户要求把原先必用悬停/可设时间改为模式选择：默认单击把手展开，点击其他地方收起；可主动选择悬停，延迟只在该模式显示。`revealMode=click|hover` 属于Settings本机偏好，缺省click，显式保存同步且重启保留。保留原有延迟值，切换不改Task/Plan、风格或其他草稿。

固定展开优先于两种自动收起；显式关闭仍解除固定并收起。单击模式外点只隐藏快速输入，重显保留草稿。拖动/缩放/退出确认优先；hover交互锁继续保护输入法和编辑期间的鼠标离开。外点不弹确认、不吞掉用户对另一应用的点击。

## 原生实现

Mac采用AppKit NSEvent local+global mouse-down monitor（left/right/other）。全局监听只观察其他应用，本地监听按事件目标窗口及parentWindow链识别小窗/把手内部；本地原样返回event，不依赖失焦或轮询按钮采样，因此不漏快速按下释放、也不需屏幕坐标换算。事件只经channel唤醒既有协调线程；回调不拿应用锁，主线程退出清除monitor。时间边界过滤旧显隐/模式/手势产生的排队事件。

[Apple事件监听说明](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/MonitoringEvents/MonitoringEvents.html)说明两类monitor互补、回调在主线程；本实现只注册鼠标，不增加键盘或辅助功能权限。固定依赖 `block2=0.6.2` 原已在锁文件，本次直接引用其RcBlock管理ObjC block。参考[固定GitHub源码](https://github.com/madsmtm/objc2/blob/b4167b582b2f75f9a1be75495c41b765344fd03c/crates/block2/src/rc_block.rs)及[MIT许可](https://github.com/madsmtm/objc2/blob/b4167b582b2f75f9a1be75495c41b765344fd03c/LICENSE.md)；仅API使用，无第三方实现复制。

Windows 分支 `d05684b` 已在单屏原生验证显式展开、外点/失焦关闭和输入保护。本轮整合保留该平台路径：单击模式显式打开时可聚焦，通过原生焦点离开收起，固定、输入与手势保护优先；悬停仍不激活。它可能在没有鼠标点击的焦点切换时收起，输入期间外点也不会隐藏，因此尚未满足本节“只因真实外点收起、可隐藏输入保草稿”的完整目标。

不在本次 Mac 整合中用80ms按钮采样替换 Windows 原生路径（可能漏掉短点击），也不引入未经 Windows 原生验证的新Hook。后续由 Windows 开发机修正并分别验证所有鼠标键、WebView/菜单目标、单纯失焦、输入隐藏草稿与手势，保留当前可用路径和失败证据。B45 保持 In progress；旧分支或浏览器证据不能替代整合版通过。

## 数据兼容

旧程序Settings拒绝未知字段；因此schema5建立明确降级边界。旧schema1–4先创建完整一致性before-schema-5备份，再事务升级marker；不重编码原snapshot/placement。只读内存补click，后续正常成功写入使用新格式。便携任务备份仍v2并保留本机设置，完整SQLite恢复则恢复备份中的偏好。验证与实际平台边界见[STATUS](../delivery/STATUS.md)和[B45](../delivery/BACKLOG.md)。
