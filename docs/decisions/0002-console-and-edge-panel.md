# ADR-0002：独立大任务、控制台与边缘小窗

- 日期：2026-09-24
- 状态：产品范围 Accepted；Tauri 具体实现 Proposed，待双平台 POC
- 关联：[PRD](../product/PRD.md)、[UX](../product/UX.md)、[架构](../engineering/ARCHITECTURE.md)、[数据模型](../engineering/DATA_MODEL.md)、[ADR-0001](0001-platform-and-reuse.md)

## 背景

用户明确第一版只做最基本的大任务，不做小任务拆解；除了边缘小窗，还需要完整 App 大窗口控制台，用于任务管理和设置。此前“设置可以用较大窗口”的描述不足以定义一个完整主界面，需要明确窗口职责、生命周期和同源数据关系。

## 决定

独立大任务及两种用户界面构成产品范围；本文记录窗口标签、生命周期和共享数据协议的设计。

1. 首版 Task 是独立、扁平的大任务。今日计划引用同一个 Task ID；在任何视图勾选都表示整项完成。不设计子任务、步骤清单、任务树、`parent_id` 或进度聚合；备注保持普通文本。
2. 提供 `console` 普通大窗口，承担今日、全部任务、DDL、完成/删除记录、任务编辑和设置。提供 `edge-panel` 小窗，承担学习中的快速查看和勾选；`edge-handle` 仅是内部触发窗口。设置放在控制台内。
3. 三个标签唯一，由一个 Rust 窗口协调器管理。一个 Rust 应用状态、同一组用例服务和一个 SQLite 数据源服务两种任务界面；前端 store 不跨 WebView 共享，也不各自持久化任务。
4. 控制台关闭按钮隐藏窗口，边缘能力和托盘继续运行；菜单栏/托盘、重复启动和应用图标可恢复控制台。明确「退出 SideTask」进入应用退出流程。登录启动默认安静恢复边缘入口。未保存草稿与正在提交事务必须得到明确处理。
5. 控制台处于前台时暂停被动悬停展开，固定小窗可以保留查看和勾选；显式点击仍可打开小窗。刷新数据不能抢焦点。协调逻辑集中处理，避免两个窗口互相触发显示/隐藏。
6. 小窗可沿屏幕边缘移动；当前交互方案允许用户主动换边/跨屏后重新停靠。防溢出约束适用于小窗及把手停靠后的显示、展开/收起和缩放，不阻止显式拖动经过屏幕接缝。固定展开不锁位置。普通控制台按标准窗口移动。
7. 跨窗命令采用实体/计划/设置 revision 检查；事务提交后发送失效通知。监听注册完成后再取一致快照，使用数据集代次和提交序号避免漏更新、旧响应覆盖和备份恢复后的序号混淆。事件不是事实来源。
8. 设置与任务内容分开保存；设置提交成功后才应用系统状态。保存与应用分别报告结果，系统应用失败保留安全实际状态和重试入口，不显示虚假成功。

## 参考依据与取舍

采用完整窗口承接管理、常驻面板承接快捷操作的成熟桌面交互模式；这里不声称复制或了解任何闭源产品的内部架构。技术依据来自 Tauri 官方公开能力：

| 官方依据 | 可支持的设计 | 不能据此声称的结果 |
| --- | --- | --- |
| [WebviewWindow](https://v2.tauri.app/reference/javascript/api/namespacewebviewwindow/)、[配置](https://v2.tauri.app/reference/config/#windowconfig) | 多窗口和唯一 label | 小窗已具备两平台无抢焦/不越界行为 |
| [Process Model](https://v2.tauri.app/concept/process-model/)、[State Management](https://v2.tauri.app/develop/state-management/) | Rust 核心维护共享应用服务 | 不同 WebView 自动共享 JS 状态 |
| [Calling the Frontend](https://v2.tauri.app/develop/calling-frontend/) | 向多个或指定窗口发送更新提示 | 通知天然可靠、可回放或替代事务 |
| [System Tray](https://v2.tauri.app/learn/system-tray/)、[Single Instance](https://v2.tauri.app/plugin/single-instance/) | 恢复入口、重复启动路由至现有应用 | 插件默认替 SideTask 恢复隐藏窗口 |
| [WindowEvent](https://docs.rs/tauri/latest/tauri/enum.WindowEvent.html)、[RunEvent](https://docs.rs/tauri/latest/tauri/enum.RunEvent.html) | 明确区分窗口关闭和应用退出处理 | 所有平台生命周期已实测一致 |
| [Capabilities](https://v2.tauri.app/security/capabilities/) | 根据窗口 label 限制系统命令能力 | 仅在界面隐藏按钮即可隔离权限 |

本次为文档核实，未锁定 Tauri 发行版本，未引入依赖。具体 API、窗口权限和两平台适配以初始化后的锁文件及 POC 结果为准。

相较于将小窗直接放大为管理界面，单独控制台能保留普通桌面窗口的移动、焦点和导航习惯，同时让小窗保持简洁。代价是必须处理跨窗口缓存、并发编辑和生命周期；采用统一服务与 revision 协议控制这部分复杂度。首版无需独立后台服务、远程 API 或微服务。

2026-09-24 修订：用户指出小窗应能在屏幕边缘移动。删除先前“换屏只能通过设置”和任何永久固定屏幕的含义；保留自动展开/收起不意外泄漏到邻屏的原始要求。主动跨屏拖动、释放吸附及取消规则是目前提出的交互实现方案。

2026-09-25 用户调整呼出方式：默认单击展开、点击外部收起，悬停展开改为可选模式，只有悬停显示延迟。Mac 使用真实鼠标事件，外点可隐藏输入并保留草稿；Windows 当前保留显式打开可聚焦、原生失焦收起和输入保护，与完整外点目标仍有差异。固定/手势/退出保护优先，模式不改几何与任务数据。整合取舍见[ADR-0007](0007-panel-reveal-mode.md)，交互契约见[UX](../product/UX.md)，当前验收范围见内部验证记录（本地保留，不随公开仓库分发）。
