# 文档导航

第一次使用请先读[完整使用说明书](product/USER_GUIDE.md)，包含安装、今日与DDL、小窗和设置、备份恢复、退出与常见问题；[项目首页](../README.md)提供快速上手与下载入口。

| 目录 | 内容 | 更新时机 |
| --- | --- | --- |
| research | [同类调研](research/ALTERNATIVES.md)、[窗口模式参考](research/WINDOW_PATTERNS.md)、[UI 参考](research/UI_REFERENCES.md) | 新证据、复用试验、版本变化 |
| product | [使用说明书](product/USER_GUIDE.md)、[PRD](product/PRD.md)、[UX](product/UX.md)、[创新点与产品价值](product/INNOVATIONS.md)、[卖点](product/SELLING_POINTS.md)、[社交平台宣传稿](product/PROMO_COPY.md) | 操作、需求、交互或产品介绍改变 |
| engineering | [架构](engineering/ARCHITECTURE.md)、[数据模型](engineering/DATA_MODEL.md)、[开发流程](engineering/DEVELOPMENT.md) | 技术实现、约束或命令改变 |
| decisions | [ADR-0001 平台与复用](decisions/0001-platform-and-reuse.md)、[ADR-0002 控制台与小窗](decisions/0002-console-and-edge-panel.md)、[ADR-0003 原型](decisions/0003-prototype-implementation.md) | 重要选择及其原因改变 |
| delivery | [路线图](delivery/ROADMAP.md)、[待办](delivery/BACKLOG.md)、[验收](delivery/TEST_PLAN.md) | 排期、范围、完成标准改变 |
| delivery | [一期交付](delivery/PHASE_1_CLOSEOUT.md)、[状态](delivery/STATUS.md)、[交接](delivery/HANDOFF.md)、[仓库迁移](delivery/REPOSITORY_MIGRATION.md)、[分支清理与接续](delivery/BRANCH_CLEANUP.md) | 每次完成一段工作或开发入口变更 |
| delivery | [下一阶段分工](delivery/NEXT_STAGE.md)、[Mac任务单](delivery/MAC_NEXT_STAGE.md)、[Windows任务单](delivery/WINDOWS_NEXT_STAGE.md) | 平台任务分发、依赖或验收门槛改变 |

PRD 是产品行为的依据；ADR 是技术取舍的依据；BACKLOG 是事项状态的依据；STATUS / HANDOFF 是下一次工作的入口。发现冲突时修正文档，不以重复复制增加新的事实来源。

术语：Task = 一个待办事项；DailyPlanEntry = 某日要做它的安排；DDL = 截止日期或时刻；POC = 先验证技术能否成立的小实验；MVP = 第一版能完整解决核心问题的最小产品；ADR = 记录重要决定及理由的文档。

本轮稳定化记录：[总复查](research/RELEASE_HARDENING.md)、[存储](research/STORAGE_HARDENING.md)、[时间](research/TIME_SEMANTICS.md)、[原生安全](research/NATIVE_SECURITY_REVIEW.md)、[安全恢复说明](engineering/DATA_RECOVERY.md)、[ADR-0004](decisions/0004-data-safety-and-fixed-deadlines.md)。

功能与体验接续：[前端性能](research/FRONTEND_PERFORMANCE.md)、[今日整理](research/TODAY_ORDERING.md)、[任务生命周期](research/TASK_LIFECYCLE.md)、[生命周期取舍](decisions/0005-task-lifecycle-and-backup-schema.md)、[窗口偏好计划](research/WINDOW_PREFERENCES.md)。

- [控制台设备偏好与schema4决策](decisions/0006-console-window-preferences.md)
- [控制台几何集成验收](../tests/manual/2026-09-25-console-geometry.md)
- [小窗混合DPI复查与实现](research/EDGE_COORDINATES.md)
- [Windows真实App冒烟可行性与边界](research/WINDOWS_NATIVE_SMOKE.md)
- [小窗尺寸与混合DPI集成记录](../tests/manual/2026-09-25-edge-resize.md)
- [Windows开发机接手说明](delivery/WINDOWS_HANDOFF.md)

- [Mac分支及首次说明、真实窗口修复记录](../tests/manual/2026-09-25-mac-branch.md)

小窗展开方式：[ADR-0007 默认单击与可选悬停](decisions/0007-panel-reveal-mode.md)。
