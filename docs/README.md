# 文档导航

第一次使用请先读[项目首页](../README.md)和[完整使用说明书](product/USER_GUIDE.md)，分别提供下载入口与完整操作说明。这里按阅读目的整理仓库中的公开文档，也保留设计、研究和技术取舍的查阅入口。

## 从哪里开始

| 你想做什么 | 建议阅读顺序 |
| --- | --- |
| 安装并开始使用 | [下载与安装](../README.md#下载与安装) → [使用说明书](product/USER_GUIDE.md) → [已验证范围与限制](VALIDATION.md) |
| 参与开发或改进文档 | [贡献指南](../CONTRIBUTING.md) → [客户端开发说明](../apps/desktop/README.md) → [架构](engineering/ARCHITECTURE.md)，再按改动范围读 PRD、UX、数据模型或设计系统 |
| 复现问题、检查交付 | [验证状态](VALIDATION.md) → [测试入口](../tests/README.md) → 对应平台的运行说明；安全问题先读 [SECURITY](../SECURITY.md) |
| 理解产品与技术取舍 | [PRD](product/PRD.md) → [UX](product/UX.md) → 下方 ADR 与专题研究；查版本变化用 [CHANGELOG](../CHANGELOG.md) |

## 产品与设计

| 文档 | 用途 |
| --- | --- |
| [完整使用说明书](product/USER_GUIDE.md) | 安装、今日与 DDL、小窗和设置、备份恢复、退出与常见问题 |
| [产品需求 PRD](product/PRD.md) | 产品范围、行为约束和验收要求 |
| [交互说明 UX](product/UX.md) | 控制台、小窗、编辑与错误处理的交互流程 |
| [设计资料](../design/README.md) · [设计系统](../design/DESIGN_SYSTEM.md) | 四套风格预览、字阶、密度、颜色与组件规范 |
| [产品价值](product/INNOVATIONS.md) · [社交平台宣传稿](product/PROMO_COPY.md) | 产品定位与对外介绍素材 |

PRD、UX 与设计系统描述产品和界面的约定；具体功能的验证完成情况请核对[验证状态](VALIDATION.md)。宣传素材和视觉预览不作为功能验收证据。

## 开发与验证

| 文档 | 用途 |
| --- | --- |
| [贡献指南](../CONTRIBUTING.md) | 提交问题、代码与文档改动的入口 |
| [桌面客户端](../apps/desktop/README.md) | 环境准备、开发启动、构建与检查命令 |
| [技术架构](engineering/ARCHITECTURE.md) · [数据模型](engineering/DATA_MODEL.md) | 模块边界、共享任务服务、持久化与业务一致性 |
| [开发流程](engineering/DEVELOPMENT.md) · [工作副本接续](UPDATING_CHECKOUT.md) | 开发步骤和已有工作副本的更新方式 |
| [数据备份与故障恢复](engineering/DATA_RECOVERY.md) | 备份格式、恢复流程和失败处理边界 |
| [验证状态与交付范围](VALIDATION.md) | 已执行检查、平台覆盖和仍未验证的项目 |
| [测试入口](../tests/README.md) · [Windows 原生冒烟工具使用说明](../apps/desktop/scripts/windows-native-smoke.md) | 测试组织、检查方法与原生工具运行方式 |
| [安全说明](../SECURITY.md) · [版本记录](../CHANGELOG.md) | 安全问题处理与可交付变化 |
| [开发脚本目录说明](../scripts/README.md) | 现有客户端工具索引与根目录脚本区的用途约定 |

自动化、浏览器测试和系统窗口真机检查各有覆盖范围，不能互相替代。原生检查摘要不替代原始记录，原始手工记录在本地留存。

## 技术决策（ADR）

ADR 按编号记录重要决定、原因和代价。早期决策可能被后续 ADR 补充；阅读时一并核对文中的日期、状态与接续关系。

| 编号 | 决策 |
| --- | --- |
| ADR-0001 | [首版双平台与复用方式](decisions/0001-platform-and-reuse.md) |
| ADR-0002 | [独立大任务、控制台与边缘小窗](decisions/0002-console-and-edge-panel.md) |
| ADR-0003 | [自建最小核心与双窗口交互原型](decisions/0003-prototype-implementation.md) |
| ADR-0004 | [试用阶段的数据安全、固定截止语义与退出保护](decisions/0004-data-safety-and-fixed-deadlines.md) |
| ADR-0005 | [保留身份的回收站与备份版本](decisions/0005-task-lifecycle-and-backup-schema.md) |
| ADR-0006 | [控制台几何偏好与设备元数据合并](decisions/0006-console-window-preferences.md) |
| ADR-0007 | [小窗默认单击与可选悬停](decisions/0007-panel-reveal-mode.md) |

## 专题研究与阶段记录

这些文档保留参考来源、评估过程、实施计划和当时的测量结果。它们有各自的日期、版本、设备与测试范围，其中的候选方案或待办不等于当前产品承诺。判断当前实现时结合源码、对应 ADR 与[验证状态](VALIDATION.md)，不要把旧阶段结果当作最新版本全部通过。

| 主题 | 文档 |
| --- | --- |
| 产品与界面参考 | [同类项目与复用评估](research/ALTERNATIVES.md)、[主控制台与快捷窗口模式](research/WINDOW_PATTERNS.md)、[UI 参考与设计转化](research/UI_REFERENCES.md)、[设计 skill 调研与采用记录](research/DESIGN_SKILLS.md) |
| 数据与时间 | [数据可靠性加固](research/STORAGE_HARDENING.md)、[时间语义与输入校验](research/TIME_SEMANTICS.md) |
| 安全与发布准备 | [原生窗口与 IPC 安全复核](research/NATIVE_SECURITY_REVIEW.md)、[发布准备阶段复查](research/RELEASE_HARDENING.md) |
| 任务行为 | [今日计划整理](research/TODAY_ORDERING.md)、[任务生命周期与恢复](research/TASK_LIFECYCLE.md) |
| 性能与大列表 | [前端派生计算与大列表基线](research/FRONTEND_PERFORMANCE.md)、[Rust 存储规模实测](research/STORAGE_PERFORMANCE.md)、[大任务列表按视口渲染](research/VIRTUAL_TASK_LIST.md) |
| 窗口与坐标 | [窗口偏好与首次说明](research/WINDOW_PREFERENCES.md)、[小窗坐标适配与缩放会话](research/EDGE_COORDINATES.md) |
| Windows 原生行为 | [原生冒烟的可行性与首轮边界](research/WINDOWS_NATIVE_SMOKE.md)、[真实外部点击](research/WINDOWS_OUTSIDE_CLICK.md)、[边缘窗口首显与 WebView2 退出](research/WINDOWS_WINDOW_LIFECYCLE.md) |

## 常用术语

| 术语 | 含义 |
| --- | --- |
| Task | 一个独立的待办事项 |
| DailyPlanEntry | 某日要做某个任务的安排，引用同一个 Task ID |
| DDL | 截止日期或时刻，与计划做事的日期不同 |
| POC | 验证技术可行性的小实验 |
| MVP | 第一版能完整解决核心问题的最小产品 |
| ADR | 记录重要决定及理由的文档 |
