# SideTask 桌面客户端（内部试用准备）

本文面向开发者。安装和日常操作请读[完整使用说明书](../../docs/product/USER_GUIDE.md)，当前包下载见[项目首页](../../README.md#下载与安装)。

Tauri 2 + React / TypeScript + Rust + SQLite。任务、今日计划和设置共用一个 Rust 服务；控制台、边缘小窗和内部把手由平台层协调。回收站与单项恢复已实现，正在完成集成与原生验收；完整首版的剩余门槛见 [STATUS](../../docs/delivery/STATUS.md)。

在「设置 → 界面风格」可即时切换纸笺、霜序、暖刊、极简；四套均支持独立浅深色。风格跨窗口同步，重启保留，旧任务不会重置。

移入回收站保留任务 ID、DDL、完成状态和全部历史/未来计划；恢复后仍按原完成状态与计划展示。普通搜索与回收站搜索分开，删除/恢复及查看任务都遵守编辑草稿保护。首轮不提供永久删除、自动清空或批量删除。

合并后最新检查与包见[STATUS](../../docs/delivery/STATUS.md)。以下为原分支证据：Windows开发机从`main`的`e844fcd`建立`codex/windows-polish`，本机99/99 TypeScript、138/138 Rust、83/83 Playwright及fmt/clippy通过。Mac CI暴露的换肤等待与生命周期测试释放竞态已确定性复现并修正，两项定向回归通过；新CI以[STATUS](../../docs/delivery/STATUS.md)为准。已构建本地release/NSIS并执行150%单屏真实App检查，详见[Windows原生记录](../../tests/manual/2026-09-25-windows-native.md)。浏览器和纯测试不替代原生多屏验收。

Windows 开发机原分支安装器位于 `artifacts/SideTask_0.1.0_x64-setup.exe`，3497586字节，SHA256 `6724bf4e314380456f46a09b70d2d360ae18ccdf91359ccc77d294732a157bd7`，产品提交`edbbd7a`，签名状态`NotSigned`。支持简体中文/英文，属于内部试用包；隔离同版本安装/重装、卸载数据保留及安装后运行已验证，旧版本升级仍待验收。最终包与对应源码以[STATUS](../../docs/delivery/STATUS.md)为准。

继续Windows工作先读[Windows接手说明](../../docs/delivery/WINDOWS_HANDOFF.md)，包含环境、隔离流程、代码入口和剩余验收项。Mac与Windows通过GitHub同步；首次使用说明已由Mac实现并与Windows代码整合。

Mac 开发与推送固定使用 `mac` → `origin/mac`；Windows完成分支已按用户授权合入 `mac`，具体协作规则见根 [AGENTS](../../AGENTS.md)。

## 开发

需要 Node.js 24、npm、Rust stable 和相应系统的 Tauri 构建前置条件。当前 Mac 已安装 Rust 到 `~/.cargo/bin`；若终端找不到 cargo，将该目录加到当前终端 PATH。

在本目录运行：

```sh
npm ci
npm run dev          # 浏览器 UI 预览，http://127.0.0.1:1420
npm test             # TypeScript 业务测试
npm run test:tools       # 原生冒烟工具清理故障契约
node --check scripts/windows-native-smoke.mjs
npm run test:ui      # Playwright；首次运行需 npx playwright install chromium
npm run build        # 类型检查及前端生产构建
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri -- dev # 原生开发（会启动 Vite，不要同时占用 1420）
```

打包 Mac 应用：`npm run tauri -- build --bundles app`。Windows 在 Windows 构建环境运行 `npm run tauri -- build --bundles nsis`；当前机器已有本地NSIS，不依赖GitHub artifact下载。构建成功与安装/升级验收分别记录。

Mac 本地内部包在没有 Developer ID 时，构建后补完整 App 的 ad-hoc 签名并严格校验；不能把 linker 对二进制的签名当作整个 bundle 已通过。以下在 `apps/desktop` 执行，只针对本机内部试用构建；已有 Developer ID 的发布流程不要被此命令替换。隔离构建需改成其实际 App 名称。

```sh
codesign --force --deep --sign - 'src-tauri/target/release/bundle/macos/SideTask.app'
codesign --verify --deep --strict 'src-tauri/target/release/bundle/macos/SideTask.app'
```

归档使用 `ditto -c -k --sequesterRsrc --keepParent` 保留 App 元数据，并在解压副本上重复严格校验。本轮可取得的 arm64 包、SHA-256、源码版本和原位升级/坏库恢复记录见[Mac阶段验收](../../tests/manual/2026-09-25-mac-next-stage.md)。ad-hoc 不等于 Developer ID、公证或 Gatekeeper 分发验证。

原生自动冒烟入口：`node scripts/windows-native-smoke.mjs --prepare`，会生成唯一隔离identifier及配置；再按[工具说明](scripts/windows-native-smoke.md)构建并驱动真实release EXE。命令不会自动安装驱动、启动构建或改写正式个人库，`--session-only`不等于完整闭环通过。资源采样在已启动的隔离App上执行：

```powershell
$smokeExe = Read-Host '输入本次隔离 sidetask.exe 的绝对路径'
$smokeAppProcessId = [int](Read-Host '输入该隔离进程的 PID')
./scripts/measure-windows-resources.ps1 -Executable $smokeExe -AppProcessId $smokeAppProcessId -Seconds 15 -State 'console-visible-edge-collapsed'
```

采样校验EXE与PID并记录进程树、CPU和内存；短样本不能证明持续性能或泄漏已解决。本轮数据见`artifacts/windows/resources-final.json`（Windows开发机本地文件），安装后真实悬停/隐藏、控制台几何重启及缩放会话见`artifacts/windows/installed-experience/report.json`（Windows开发机本地文件）。混合DPI多屏、物理拖动、IME、睡眠、虚拟桌面、托盘真实点击、旧版本升级及连续性能仍未验。

浏览器预览使用独立的合成数据存储 `sidetask-browser-preview-v1`，不读取本机 SQLite。原生数据位于系统应用数据目录 `com.changjin.sidetask/sidetask.sqlite3`，不在仓库内。首次原生启动为空库。浏览器演示才使用示例任务；旧数据库升级不会重置任务。

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

`src/features` 仍预留，不为目录形式提前拆空模块。规范化表和Windows/多屏窗口全面验收尚未完成。固定时区DDL、升级备份、控制台导出/恢复以及独立损坏启动恢复向导已实现，证据和限制见STATUS及数据恢复说明。

## 数据与安全检查

设置页导出便携 v2 JSON 任务备份，包含回收站记录与全部计划；导入接受合法 v1/v2，预览显示回收站数量，恢复前自动保留完整 SQLite 安全备份。v1 不能携带非空删除时间，避免旧格式悄悄丢失生命周期含义。文件路径和损坏启动时的安全离线流程见 [恢复说明](../../docs/engineering/DATA_RECOVERY.md)。任务备份恢复保留本机设备设置。

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm audit
cargo audit --file src-tauri/Cargo.lock # 需要cargo-audit；本轮使用0.22.2
```

CI固定Node24.14.1/Rust1.98.1及官方Actions commit。接手前main的[CI36096207144](https://github.com/changjin-cpu/SideTask/actions/runs/36096207144)已通过两平台检查与App/NSIS构建，仅artifact上传受账户配额阻塞，整套run仍为failure。当前Windows分支提交后的新CI需单独核对，不能借用旧main结果；本地包与远端下载可用性分别记录。

隔离原生验收以临时Tauri配置覆盖productName/identifier，不向正式个人库注入fixture。分区比例和控制台几何已实现，小窗混合DPI/尺寸取消本轮修复；首次常驻说明已接入，确认状态与任务快照分开保存，见[路线图](../../docs/delivery/ROADMAP.md)。

前端按 surface 分拆加载，保留启动恢复与加载失败重试。Windows 原分支的资源体积测量见[原生记录](../../tests/manual/2026-09-25-windows-native.md)，不可当成合并后产物的实测值。
