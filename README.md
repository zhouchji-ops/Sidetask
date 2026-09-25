# 侧笺 · SideTask

把「今天要做什么」放在屏幕边缘：鼠标停留时展开，离开后收起；上半部分是今日计划，下半部分是截止日期（DDL）。让查看任务不必离开当前学习场景。

小窗可以沿边缘拖动调整位置；当前方案也支持主动换边、换屏后重新停靠。防溢出针对停靠后的展开/收起，不限制用户主动移动。

一个 App、两种界面：**大窗口控制台**集中管理任务和设置，**边缘小窗**用于学习时快速查看和勾选。第一版只做独立的大任务，不做拆解或子任务。

项目仓库：[changjin-cpu/SideTask](https://github.com/changjin-cpu/SideTask)。代码与文档均在该仓库维护；Mac 开发目录为 `任务弹窗`，Windows 本阶段使用 `E:\A_项目\SideTask-next-stage`，原 `E:\A_项目\SideTask` 及历史产物保留。

2026-09-25 按用户要求修复历史提交作者，三个分支的提交编号随之变化，原有代码和提交关系保留。**已有检出先读[历史身份迁移与 Windows 接续](docs/delivery/GIT_IDENTITY_MIGRATION.md)，不要直接合并旧历史。** 下文旧 SHA 用于描述迁移前的分工，当前编号见该对照表。

**Mac 开发固定使用 [`mac`](https://github.com/changjin-cpu/SideTask/tree/mac) 分支，后续 Mac 代码和文档均推送 `origin/mac`。** 分支从 `e844fcd` 建立；Windows 的 `codex/windows-polish` 已按用户授权合入 `mac`；后续按已整合提交协调，不覆盖彼此分支。

**当前阶段：功能完善与内部试用验收。** 使用 Tauri 2 + React/TypeScript + Rust + SQLite 自建精简核心。备份与坏库启动恢复、固定 DDL、退出草稿保护、全局搜索、大列表和今日整理已实现；回收站与单项恢复已落地，正在完成集成和原生验收。第一版同时面向 macOS / Windows，双平台、多屏和发布验收尚未完成。实际测试及构建结果见 [STATUS](docs/delivery/STATUS.md)。

## 从这里开始

| 想了解什么 | 文档 |
| --- | --- |
| 有没有现成工具、哪些值得试 | [同类项目调研](docs/research/ALTERNATIVES.md) |
| 大窗口与小窗参考了什么模式 | [成熟产品交互参考](docs/research/WINDOW_PATTERNS.md)、[双窗口决策](docs/decisions/0002-console-and-edge-panel.md) |
| 四套 UI 风格如何切换 | [设计对比页](design/STYLE_GALLERY.html)、[设计规范](design/DESIGN_SYSTEM.md)；App 设置 → 界面风格 |
| 第一版到底做什么 | [产品需求](docs/product/PRD.md) |
| 控制台和小窗怎么配合 | [交互设计](docs/product/UX.md) |
| 跨平台、多屏怎么实现 | [技术架构](docs/engineering/ARCHITECTURE.md) |
| 今日任务与 DDL 为什么能同步 | [数据模型](docs/engineering/DATA_MODEL.md) |
| 正常开发一个 App 的流程 | [开发流程](docs/engineering/DEVELOPMENT.md) |
| 先做哪一步 | [里程碑](docs/delivery/ROADMAP.md)、[待办](docs/delivery/BACKLOG.md) |
| 下一阶段分配给谁 | [分工总单](docs/delivery/NEXT_STAGE.md)、[Mac任务单](docs/delivery/MAC_NEXT_STAGE.md)、[Windows任务单](docs/delivery/WINDOWS_NEXT_STAGE.md) |
| Windows开发机如何接手 | [Windows交接](docs/delivery/WINDOWS_HANDOFF.md) |
| 目前做到哪、下次接着做什么 | [项目状态](docs/delivery/STATUS.md)、[交接说明](docs/delivery/HANDOFF.md) |
| 怎样判断真的做完 | [验收计划](docs/delivery/TEST_PLAN.md) |
| AI / 开发者协作约定 | [AGENTS.md](AGENTS.md) |

## 建议方向

Todobar 的窗口隐藏、悬停和数据模型与需求有明显差距，因此本轮选择自建精简核心，UI 与窗口验证并行，见 [ADR-0003](docs/decisions/0003-prototype-implementation.md)。借鉴成熟产品的公开交互和用户指定设计站点的视觉原则，具体见 [UI 参考](docs/research/UI_REFERENCES.md) 与 [设计系统](design/DESIGN_SYSTEM.md)。

「加入今日」是给同一任务建立今日计划引用，不是复制一条任务。任意位置完成或撤销完成，都更新同一个任务状态。

任务可移入回收站并恢复，保留原 ID、DDL、完成状态与所有日期的计划。正常搜索排除回收站，回收站有独立搜索；删除与恢复入口保留编辑草稿和冲突处理。当前 SQLite 为 schema4，便携任务备份为 v2，包含回收站记录；没有自动清空或永久删除。分区比例已支持操作结束后保存、取消和失败恢复；控制台位置/尺寸记忆已接入并在集成验收，首次常驻说明已接入，确认后隐藏且设置可再读，见[窗口偏好计划](docs/research/WINDOW_PREFERENCES.md)。

## 目录

```text
任务弹窗/
├── AGENTS.md                 协作规则、产品不变量、交接要求
├── README.md                 项目入口与目录导航
├── CHANGELOG.md              已交付变更；不把计划写成成果
├── apps/desktop/             桌面客户端源码与构建配置
│   ├── src/                  React 界面：surfaces、features、components、lib
│   │   └── surfaces/         console 大窗与 edge-panel 小窗的布局入口
│   └── src-tauri/            Rust 服务与原生系统能力
│       ├── src/domain/       任务、计划、排序等业务规则
│       ├── src/application/  用例与命令入口
│       ├── src/infrastructure/ SQLite、备份等实现
│       ├── src/platform/     macOS / Windows 窗口适配
│       └── migrations/       有版本的数据迁移
├── docs/
│   ├── research/             一手来源、竞品与复用评估
│   ├── product/              需求、交互、范围
│   ├── engineering/          架构、数据模型、开发说明
│   ├── decisions/            重要决策及变更理由（ADR）
│   └── delivery/             状态、待办、交接、验收、里程碑
├── design/                   原型、图标、设计源文件
├── tests/                    集成测试、合成数据、手工验证证据
└── scripts/                  以后实际使用的开发/打包脚本
```

运行入口在 [apps/desktop/README.md](apps/desktop/README.md)：进入该目录后 `npm ci`、`npm run dev` 可启动浏览器原型；原生开发使用 `npm run tauri -- dev`（需要 Rust 和平台构建环境）。浏览器只能验证布局和任务交互，不能证明真实多屏窗口能力。生成物与个人任务数据库不提交仓库。

上一阶段两平台成果已整合到 `mac`，保留 Mac 首次使用说明与原生几何修复、Windows 窗口/托盘适配，以及按窗口拆分加载和设置滚动修复。本轮 Windows 的首显框与退出修复已推到 `codex/windows-next-stage`，产品提交为 `e4217f4b8d57172105184b30bec5046e84b77912`；尚需按 B43 协調新一轮双平台整合。实际检查与产物以 [STATUS](docs/delivery/STATUS.md) 为准；原分支结果只作为历史证据。

Windows 开发机已从本轮源码生成可取得的 0.1.0 x64 内部试用 NSIS，文件位置、源码与校验值见 [STATUS](docs/delivery/STATUS.md)。该包未签名、未公开发布；同源码隔离包的新装、固定旧 schema 测试版升级、重装、卸载保数据再装和真实启动均通过，坏库恢复、原生 JSON 文件选择器与控制台中文 IME 也已有本轮证据。真实鼠标/托盘、部分恢复失败入口、多屏/混合DPI、休眠和实际3–7天连续使用仍待验收，详见 [Windows 本轮记录](tests/manual/2026-09-25-windows-next-stage.md)。远端 CI 的构建与产物上传分别记录，不以本地有包代替云端上传成功。

文档索引见 [docs/README.md](docs/README.md)。调研记录日期：2026-09-24。

安全边界与已知限制见[SECURITY](SECURITY.md)，数据恢复操作见[恢复说明](docs/engineering/DATA_RECOVERY.md)。
