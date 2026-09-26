# SideTask 桌面客户端（0.1.0 内部试用版）

本文面向开发者。安装和日常操作请读[完整使用说明书](../../docs/product/USER_GUIDE.md)，当前包下载见[项目首页](../../README.md#下载与安装)，问题反馈方式见[说明书](../../docs/product/USER_GUIDE.md#当前范围与反馈)。

Tauri 2 + React / TypeScript + Rust + SQLite。任务、今日计划和设置共用一个 Rust 服务；控制台、边缘小窗和内部把手由平台层协调。当前已实现回收站与单项恢复、备份导入及双窗口草稿保护。

在「设置 → 界面风格」可即时切换纸笺、霜序、暖刊、极简；四套均支持独立浅深色。风格跨窗口同步，重启保留，旧任务不会重置。

移入回收站保留任务 ID、DDL、完成状态和全部历史/未来计划；恢复后仍按原完成状态与计划展示。普通搜索与回收站搜索分开，删除/恢复及查看任务都遵守编辑草稿保护。首轮不提供永久删除、自动清空或批量删除。

默认开发入口是 `mac`，已包含两平台的内部试用实现。Mac 使用 `mac` → `origin/mac`；Windows 同步远端后，从已确认的 `origin/mac` 完整提交 SHA 创建 `codex/<任务名>` 分支。已有工作副本按[接续说明](../../docs/UPDATING_CHECKOUT.md)保留原目录，在新目录克隆，不合并旧历史。

历史 CI 产品版本 `065aa67` 的 [CI 36148843605](https://github.com/zhouchji-ops/Sidetask/actions/runs/36148843605)通过 Mac、Windows 和 Rust 审计三个作业，并生成内部包。当前下载与期限见[项目首页](../../README.md#下载与安装)，内层实际文件校验值见[使用说明书](../../docs/product/USER_GUIDE.md#更新重装和备份)。真机原始记录在本地留存；CI 结果不能代替完整原生验收。

## 开发

需要 Node.js 24、npm、Rust 和相应系统的 Tauri 构建前置条件。与 CI 对齐时使用 Node.js 24.14.1 和 Rust 1.98.1；版本以[工作流](../../.github/workflows/desktop-checks.yml)为准。

以下命令都在 `apps/desktop` 目录执行。首次安装依赖：

```sh
npm ci
```

### 浏览器预览

```sh
npm run dev
```

打开 <http://127.0.0.1:1420>。该命令会持续运行，按 Ctrl+C 停止。预览使用独立合成数据，不读取原生 SQLite，也不能验证系统窗口行为。

### 原生开发

```sh
npm run tauri -- dev
```

Tauri 会自行启动 Vite；先停止其他占用 1420 端口的开发服务。默认配置使用正式 identifier `com.changjin.sidetask`，若本机已使用 SideTask，会访问同一应用数据目录。用于合成数据测试时，先用临时 Tauri 配置覆盖 `productName` / `identifier`，不要向个人库注入测试任务。Windows 隔离配置与构建的完整步骤见[原生冒烟说明](scripts/windows-native-smoke.md)。

## 检查

以下为一次性检查，按实际修改选择相关项目：

```sh
npm test
npm run test:tools
node --check scripts/windows-native-smoke.mjs
npx playwright install chromium
npm run test:ui
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

`npm test` 检查 TypeScript 业务规则，`test:tools` 检查冒烟工具的失败清理契约，`test:ui` 运行 Playwright 浏览器回归，`build` 执行类型检查及前端生产构建。Chromium 在首次运行或 Playwright 更新后安装；[Playwright 配置](playwright.config.ts)会在需要时启动 Vite，无需另开预览服务。测试用例见[客户端测试目录](tests)，格式、Clippy 与审计见下方[数据与安全检查](#数据与安全检查)。

## 打包与原生验证

打包 Mac 应用：`npm run tauri -- build --bundles app`。Windows 在 Windows 构建环境运行 `npm run tauri -- build --bundles nsis`。构建成功与安装/升级验收分别记录。

Mac 本地内部包在没有 Developer ID 时，构建后补完整 App 的 ad-hoc 签名并严格校验；不能把 linker 对二进制的签名当作整个 bundle 已通过。以下在 `apps/desktop` 执行，只针对本机内部试用构建；已有 Developer ID 的发布流程不要被此命令替换。隔离构建需改成其实际 App 名称。

```sh
codesign --force --deep --sign - 'src-tauri/target/release/bundle/macos/SideTask.app'
codesign --verify --deep --strict 'src-tauri/target/release/bundle/macos/SideTask.app'
```

归档使用 `ditto -c -k --sequesterRsrc --keepParent` 保留 App 元数据，并在解压副本上重复严格校验。内部包下载与校验入口见[项目首页](../../README.md#下载与安装)。ad-hoc 不等于 Developer ID、公证或 Gatekeeper 分发验证。

原生自动冒烟入口：`node scripts/windows-native-smoke.mjs --prepare`，会生成唯一隔离identifier及配置；再按[工具说明](scripts/windows-native-smoke.md)构建并驱动真实release EXE。命令不会自动安装驱动、启动构建或改写正式个人库，`--session-only`不等于完整闭环通过。资源采样在已启动的隔离App上执行：

```powershell
$smokeExe = Read-Host '输入本次隔离 sidetask.exe 的绝对路径'
$smokeAppProcessId = [int](Read-Host '输入该隔离进程的 PID')
./scripts/measure-windows-resources.ps1 -Executable $smokeExe -AppProcessId $smokeAppProcessId -Seconds 15 -State 'console-visible-edge-collapsed'
```

采样校验EXE与PID并记录进程树、CPU和内存；短样本不能证明持续性能或泄漏已解决。原始测量和手工记录在本地留存。

浏览器预览使用独立的合成数据存储 `sidetask-browser-preview-v1`，不读取本机 SQLite。原生数据位于系统应用数据目录 `com.changjin.sidetask/sidetask.sqlite3`，不在仓库内；隔离配置使用其对应 identifier 的数据目录。该目录首次使用时创建空库，已有数据库则按启动检查与迁移流程处理。浏览器演示才使用示例任务；旧数据库升级不会重置任务。

## 目录职责

| 位置 | 当前内容 |
| --- | --- |
| src/surfaces/console | 今日、全部、截止日期、已完成、回收站、详情、设置和新建表单 |
| src/surfaces/edge-panel | 今日/DDL 双区、拖动/缩放入口、内部边缘把手 |
| src/startup | 按surface加载控制台/小窗/把手，保持启动检查、Store与原生事件顺序；浏览器预览独立入口 |
| src/components | 共享任务行、勾选、品牌、空状态、开关 |
| src/styles | app.css 基础/纸笺，variants.css 三套风格覆盖，style-picker.css 风格预览；明暗、响应尺寸与减少动态效果 |
| src/lib | 类型、派生视图、Tauri 调用、统一 Store；另含浏览器演示适配器 |
| src-tauri/src/domain | 独立 Task、计划引用、校验、revision 冲突 |
| src-tauri/src/application | 事务用例与统一提交入口 |
| src-tauri/src/infrastructure | SQLite Repository，schema5版本化snapshot及独立设备metadata、升级前安全备份与严格验证 |
| src-tauri/src/platform | 窗口协调、分平台坐标适配、实际矩形确认、拖动/尺寸会话、hover |
| src-tauri/migrations | 实际数据库初始化 SQL |
| tests | Vitest 业务与 Playwright UI 自动化 |
| scripts/windows-native-smoke.mjs / windows-native-probe.ps1 / measure-windows-resources.ps1 | Windows真实App冒烟、物理窗口/环境探针与有界资源测量 |

任务持久化使用 SQLite JSON 快照。固定时区DDL、升级备份、控制台导出/恢复以及独立损坏启动恢复向导已实现，故障处理见[数据恢复说明](../../docs/engineering/DATA_RECOVERY.md)。

## 数据与安全检查

设置页导出便携 v2 JSON 任务备份，包含回收站记录与全部计划；导入接受合法 v1/v2，预览显示回收站数量，恢复前自动保留完整 SQLite 安全备份。v1 不能携带非空删除时间，避免旧格式悄悄丢失生命周期含义。文件路径和损坏启动时的安全离线流程见 [恢复说明](../../docs/engineering/DATA_RECOVERY.md)。任务备份恢复保留本机设备设置。

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm audit
cargo audit --file src-tauri/Cargo.lock # 需要单独安装 cargo-audit
```

[CI 工作流](../../.github/workflows/desktop-checks.yml)运行两平台检查与 App / NSIS 构建，并固定工具链和官方 Actions 版本。CI 构建、产物上传和真机验收是不同结果，应分别核对；旧 CI 链接只证明对应历史版本。

原生验证使用临时 Tauri 配置覆盖 `productName` / `identifier`，不向个人数据库注入合成任务。首次常驻说明的确认状态与任务快照分开保存；前端按 surface 分拆加载，保留启动恢复与加载失败重试。浏览器和算法检查不能替代对应平台的真实系统验证。
