# 文档导航

第一次使用请先读[完整使用说明书](product/USER_GUIDE.md)，包含安装、今日与 DDL、小窗和设置、备份恢复、退出与常见问题；[项目首页](../README.md)提供快速上手与下载入口。

| 类别 | 内容 |
| --- | --- |
| 产品 | [使用说明书](product/USER_GUIDE.md)、[PRD](product/PRD.md)、[UX](product/UX.md)、[产品价值](product/INNOVATIONS.md)、[社交平台宣传稿](product/PROMO_COPY.md) |
| 开发 | [桌面客户端](../apps/desktop/README.md)、[架构](engineering/ARCHITECTURE.md)、[数据模型](engineering/DATA_MODEL.md)、[开发流程](engineering/DEVELOPMENT.md)、[工作副本接续](UPDATING_CHECKOUT.md)、[数据恢复](engineering/DATA_RECOVERY.md) |
| 验证 | [验证状态与边界](VALIDATION.md)、[测试入口](../tests/README.md) |
| 调研 | [同类产品](research/ALTERNATIVES.md)、[窗口模式](research/WINDOW_PATTERNS.md)、[UI 参考](research/UI_REFERENCES.md) |
| 决策 | [平台与复用](decisions/0001-platform-and-reuse.md)、[控制台与小窗](decisions/0002-console-and-edge-panel.md)、[原型实现](decisions/0003-prototype-implementation.md) |

PRD 描述产品行为，ADR 记录技术取舍；[验证状态](VALIDATION.md)区分已执行检查与未覆盖范围。原生检查摘要不替代原始记录，原始手工记录在本地留存。

术语：Task = 一个待办事项；DailyPlanEntry = 某日要做它的安排；DDL = 截止日期或时刻；POC = 验证技术可行性的小实验；MVP = 第一版能完整解决核心问题的最小产品；ADR = 记录重要决定及理由的文档。

更多实现说明：

- 数据可靠性：[存储](research/STORAGE_HARDENING.md)、[时间语义](research/TIME_SEMANTICS.md)、[原生安全](research/NATIVE_SECURITY_REVIEW.md)、[数据与截止日决策](decisions/0004-data-safety-and-fixed-deadlines.md)。
- 任务与性能：[前端性能](research/FRONTEND_PERFORMANCE.md)、[今日整理](research/TODAY_ORDERING.md)、[任务生命周期](research/TASK_LIFECYCLE.md)、[生命周期决策](decisions/0005-task-lifecycle-and-backup-schema.md)。
- 窗口：[窗口偏好](research/WINDOW_PREFERENCES.md)、[控制台设备偏好决策](decisions/0006-console-window-preferences.md)、[小窗坐标与边界](research/EDGE_COORDINATES.md)、[展开模式决策](decisions/0007-panel-reveal-mode.md)。
- Windows：[原生冒烟工具](research/WINDOWS_NATIVE_SMOKE.md)、[真实外点](research/WINDOWS_OUTSIDE_CLICK.md)、[窗口生命周期](research/WINDOWS_WINDOW_LIFECYCLE.md)。
