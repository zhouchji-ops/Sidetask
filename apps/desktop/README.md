# SideTask 桌面客户端（内部试用准备）

Tauri 2 + React / TypeScript + Rust + SQLite。任务、今日计划和设置共用一个 Rust 服务；控制台、边缘小窗和内部把手由平台层协调。当前原型与完整首版的差距见 [STATUS](../../docs/delivery/STATUS.md)。

在「设置 → 界面风格」可即时切换纸笺、霜序、暖刊、极简；四套均支持独立浅深色。风格跨窗口同步，重启保留，旧任务不会重置。

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

打包 Mac 应用：`npm run tauri -- build --bundles app`。Windows 在 Windows 构建环境运行 `npm run tauri -- build --bundles nsis`；命令已配置不表示已在 Windows 执行成功。

浏览器预览使用独立的合成数据存储 `sidetask-browser-preview-v1`，不读取本机 SQLite。原生数据位于系统应用数据目录 `com.changjin.sidetask/sidetask.sqlite3`，不在仓库内。首次原生启动为空库。浏览器演示才使用示例任务；旧数据库升级不会重置任务。

## 目录职责

| 位置 | 当前内容 |
| --- | --- |
| src/surfaces/console | 今日、全部、截止日期、已完成、详情、设置和新建表单 |
| src/surfaces/edge-panel | 今日/DDL 双区、拖动/缩放入口、内部边缘把手 |
| src/components | 共享任务行、勾选、品牌、空状态、开关 |
| src/styles | app.css 基础/纸笺，variants.css 三套风格覆盖，style-picker.css 风格预览；明暗、响应尺寸与减少动态效果 |
| src/lib | 类型、派生视图、Tauri 调用、统一 Store；另含浏览器演示适配器 |
| src-tauri/src/domain | 独立 Task、计划引用、校验、revision 冲突 |
| src-tauri/src/application | 事务用例与统一提交入口 |
| src-tauri/src/infrastructure | SQLite Repository，schema2版本化snapshot、升级前安全备份与严格验证 |
| src-tauri/src/platform | 窗口协调、物理工作区、拖动与停靠、hover |
| src-tauri/migrations | 实际数据库初始化 SQL |
| tests | Vitest 业务与 Playwright UI 自动化 |

`src/features` 仍预留，不为目录形式提前拆空模块。规范化表、Windows/多屏窗口全面验收与损坏启动恢复向导尚未完成。固定时区DDL、升级备份及控制台导出/恢复已实现，证据和限制见STATUS及数据恢复说明。

## 数据与安全检查

设置页可导出JSON任务备份、预览并恢复；恢复前自动保留完整SQLite安全备份。文件路径和损坏启动时的安全离线流程见 [恢复说明](../../docs/engineering/DATA_RECOVERY.md)。备份仅用于恢复任务，不执行脚本或改变设备设置。

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm audit
cargo audit --file src-tauri/Cargo.lock # 需要cargo-audit；本轮使用0.22.2
```

CI使用Node24.14.1/Rust1.98.1，Actions固定commit；生成Mac app归档和Windows NSIS试用artifact。CI只存在配置时不能算执行通过。隔离原生验收使用临时Tauri配置覆盖productName和identifier，不向正式个人数据库注入合成数据。
