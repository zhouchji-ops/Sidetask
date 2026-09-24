# SideTask 桌面客户端（内部试用准备）

Tauri 2 + React / TypeScript + Rust + SQLite。任务、今日计划和设置共用一个 Rust 服务；控制台、边缘小窗和内部把手由平台层协调。回收站与单项恢复已实现，正在完成集成与原生验收；完整首版的剩余门槛见 [STATUS](../../docs/delivery/STATUS.md)。

在「设置 → 界面风格」可即时切换纸笺、霜序、暖刊、极简；四套均支持独立浅深色。风格跨窗口同步，重启保留，旧任务不会重置。

移入回收站保留任务 ID、DDL、完成状态和全部历史/未来计划；恢复后仍按原完成状态与计划展示。普通搜索与回收站搜索分开，删除/恢复及查看任务都遵守编辑草稿保护。首轮不提供永久删除、自动清空或批量删除。

当前本地99/99 TypeScript、93/93 Rust、67/67 Playwright通过；最后包证据见STATUS，含回收站、分区保存及键盘焦点回归。合成 10k 回收站首屏挂载 17 行、639 个 DOM 节点，首尾搜索和恢复路径有回归；这是浏览器桌面分支结果，不是原生 WebView 性能承诺。

最后补丁的 Mac arm64 App 已构建并通过本地 ad-hoc 验签（`index-B-9KMQ89.js` / `index-BN07M5pO.css`）。因设备锁屏尚未启动本阶段原生验收；包路径和归档摘要见 STATUS，不标记 B31 或双平台验收完成。

## 开发

需要 Node.js 24、npm、Rust stable 和相应系统的 Tauri 构建前置条件。当前 Mac 已安装 Rust 到 `~/.cargo/bin`；若终端找不到 cargo，将该目录加到当前终端 PATH。

在本目录运行：

```sh
npm ci
npm run dev          # 浏览器 UI 预览，http://127.0.0.1:1420
npm test             # TypeScript 业务测试
npm run test:ui      # Playwright；首次运行需 npx playwright install chromium
npm run build        # 类型检查及前端生产构建
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri -- dev # 原生开发（会启动 Vite，不要同时占用 1420）
```

打包 Mac 应用：`npm run tauri -- build --bundles app`。Windows 在 Windows 构建环境运行 `npm run tauri -- build --bundles nsis`；基线48e5d4f已在Windows CI构建成功，但artifact上传因账户配额失败，安装与交互仍需实机验收。

浏览器预览使用独立的合成数据存储 `sidetask-browser-preview-v1`，不读取本机 SQLite。原生数据位于系统应用数据目录 `com.changjin.sidetask/sidetask.sqlite3`，不在仓库内。首次原生启动为空库。浏览器演示才使用示例任务；旧数据库升级不会重置任务。

## 目录职责

| 位置 | 当前内容 |
| --- | --- |
| src/surfaces/console | 今日、全部、截止日期、已完成、回收站、详情、设置和新建表单 |
| src/surfaces/edge-panel | 今日/DDL 双区、拖动/缩放入口、内部边缘把手 |
| src/components | 共享任务行、勾选、品牌、空状态、开关 |
| src/styles | app.css 基础/纸笺，variants.css 三套风格覆盖，style-picker.css 风格预览；明暗、响应尺寸与减少动态效果 |
| src/lib | 类型、派生视图、Tauri 调用、统一 Store；另含浏览器演示适配器 |
| src-tauri/src/domain | 独立 Task、计划引用、校验、revision 冲突 |
| src-tauri/src/application | 事务用例与统一提交入口 |
| src-tauri/src/infrastructure | SQLite Repository，schema3版本化snapshot、升级前安全备份与严格验证 |
| src-tauri/src/platform | 窗口协调、物理工作区、拖动与停靠、hover |
| src-tauri/migrations | 实际数据库初始化 SQL |
| tests | Vitest 业务与 Playwright UI 自动化 |

`src/features` 仍预留，不为目录形式提前拆空模块。规范化表和Windows/多屏窗口全面验收尚未完成。固定时区DDL、升级备份、控制台导出/恢复以及独立损坏启动恢复向导已实现，证据和限制见STATUS及数据恢复说明。

## 数据与安全检查

设置页导出便携 v2 JSON 任务备份，包含回收站记录与全部计划；导入接受合法 v1/v2，预览显示回收站数量，恢复前自动保留完整 SQLite 安全备份。v1 不能携带非空删除时间，避免旧格式悄悄丢失生命周期含义。文件路径和损坏启动时的安全离线流程见 [恢复说明](../../docs/engineering/DATA_RECOVERY.md)。任务备份恢复保留本机设备设置。

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm audit
cargo audit --file src-tauri/Cargo.lock # 需要cargo-audit；本轮使用0.22.2
```

CI 使用 Node24.14.1/Rust1.98.1，Actions 固定 commit。b781899 的 Windows Clippy 因恢复目录构造器 `unused_mut` 失败；fc182cf 按 Unix/非 Unix 拆分声明修复，[CI36042694723](https://github.com/changjin-cpu/SideTask/actions/runs/36042694723)已完成Mac74TS/74Rust/47UI、Windows74TS/72Rust/47UI及App/NSIS构建；最终只有artifact配额上传失败。该CI与本地回收站/分区比例改动分开，后者仍需自己的双平台验证。旧 artifact 配额问题仍未解决，不能把构建通过写成安装包已可下载。

隔离原生验收使用临时 Tauri 配置覆盖 productName 和 identifier，不向正式个人数据库注入合成数据。小窗分区比例已可保存，后续控制台窗口位置和首次说明尚未实现，执行方案见[窗口偏好计划](../../docs/research/WINDOW_PREFERENCES.md)。
