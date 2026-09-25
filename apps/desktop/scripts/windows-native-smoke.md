# Windows 原生冒烟工具（B34）

该工具驱动专用 release EXE 中真实的 Tauri / WebView2 / Rust / SQLite；不启动 Vite，不替换 IPC，不造浏览器演示库。工具实现不代表原生用例已通过，以本次 `report.json` 和 `events.jsonl` 为准。原生矩阵仍见 `docs/delivery/TEST_PLAN.md`。

## 准备

在解锁的 Windows 交互桌面执行，需要 Node 24+、Rust、tauri-driver **2.0.6** 和匹配实际 WebView2 Runtime 前三段版本的 Microsoft Edge Driver。工具不安装依赖、不下载驱动、不启动构建。tauri-driver 按仓库调研固定：`cargo install tauri-driver --version 2.0.6 --locked`。驱动来源与许可见 [调研](../../../docs/research/WINDOWS_NATIVE_SMOKE.md)、[Tauri 官方指南](https://v2.tauri.app/develop/tests/webdriver/)、[Microsoft 官方 WebView2 指南](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webdriver)。未复制官方无许可示例。

从 `apps/desktop` 执行：

```powershell
node scripts/windows-native-smoke.mjs --prepare
```

输出唯一的临时配置、专用 target、证据目录及 Roaming 数据目录。把输出路径填到下面的变量。不要复用已运行过的配置，不要删除不明数据库。构建可能需数分钟。

```powershell
$smokeConfig = '准备命令输出的 config 绝对路径'
$smokeTarget = '准备命令输出的 targetDirectory 绝对路径'
$env:CARGO_TARGET_DIR = $smokeTarget
npm run tauri -- build --no-bundle --config $smokeConfig
if ($LASTEXITCODE -ne 0) { throw '原生验收构建失败' }
$smokeExe = Join-Path $smokeTarget 'release\sidetask.exe'
$tauriDriver = 'tauri-driver.exe 的绝对路径'
$edgeDriver = 'msedgedriver.exe 的绝对路径'
node scripts/windows-native-smoke.mjs --config $smokeConfig --exe $smokeExe --tauri-driver $tauriDriver --edge-driver $edgeDriver
if ($LASTEXITCODE -ne 0) { throw '原生冒烟失败，查看 evidence' }
```

`--session-only` 只验证环境、会话、真实控制台和空数据库；结果为 `session-only-pass`，不会称完整冒烟通过。完整测试用同一隔离标识启动两次，启动会话每次只尝试一次。失败后再次执行须准备新配置并重建。

## 实际边界

- 预检检查交互输入桌面、SessionId、显示器、WebView2/驱动版本、Git 提交与脏状态、EXE/驱动摘要；EXE 必须嵌入该次唯一隔离 identifier，数据库目录初始必须不存在。
- 每次启动等待原生窗口设置完成后，确认控制台没有残留错误横幅，以真实 HWND 的物理矩形验证唯一可见把手：`18×92` 逻辑尺寸按该窗 DPI 换算（超出工作区时裁小），完整落在所属屏幕工作区。这个检查能检出 Windows 最小跟踪宽度把把手意外扩宽的问题，不能只信 `get_window_status` 无错误。
- 控制台用真实 WebDriver 点击和输入创建任务、修改备注/精确 DDL、完成/撤销、移出/加入今日、软删除/恢复，读取既有 `get_snapshot` 辅助核验同一 ID 与计划保留。日期输入由原生 DOM setter 派发 input/change，避免系统日期格式干扰；这不验收日期键盘输入/IME。
- 在真实设置 UI 固定展开后打开小窗，切换到独立 `edge-panel` WebView，在今日列表完成任务；回控制台的“已完成”页面观察并撤销，再切回小窗同时验证今日和 DDL 出现原任务。断言两个 WebDriver handle 不同、同 Task ID、日期/时刻/时区/UTC 和计划完整保留，完成后以 UI 收起小窗。
- Win32 `WM_CLOSE` 触发真实宿主窗口关闭流程，核验窗口隐藏且进程存活，再以现有 `openConsole` IPC 恢复并核验唯一可见原生 HWND。这不验收托盘点击。
- 现有 `window_action('quit')` 触发与托盘相同的退出服务；有草稿时点击真实“保存并退出”，观察主进程结束，再用 Node 内置 SQLite **只读**检查 schema4、application ID、完整性及内容。重启必须新 PID 并保留同 Task ID / DDL / 计划；再次明确退出后再核验数据库。`driver.quit` 或强杀不能算产品退出通过。
- 单请求通常 15 秒，会话 90 秒，控制台 30 秒，退出 30 秒，总段 15 分钟；超时诊断/清理另有 45 秒硬上限。失败保留驱动日志、可获得的 HTML/截图、结构化报告和隔离数据库。不会无限重试会话。
- 收尾只强制回收本工具本次独有 EXE 路径的进程和本次 driver 进程树，记录为 cleanup；绝不按 `sidetask` 名称批量结束进程，绝不删除应用数据库。准备构建目录应专用于该次运行。

`CARGO_TARGET_DIR` 仅用于当前终端的隔离构建，正式构建前清除或恢复原值。tauri-driver 2.0.6 不提供 `--version`，工具读取其 `bin/` 相邻 Cargo `.crates2.json` 安装回执并记录二进制 SHA；请保留 Cargo 安装位置，不单独复制这个 EXE。

工具尚不证明悬停不抢焦点、混合 DPI/负坐标多屏、屏幕拔插、休眠、虚拟桌面、IME、托盘菜单操作、安装升级或持续资源性能。`windows-native-probe.ps1` 在确认 per-monitor-v2 DPI awareness 后记录物理屏幕工作区与窗口矩形；这只是该次屏幕布局证据，不据此判整个多屏矩阵通过。

## 报告与 CI

所有断言输出 JSON 行，退出码 0 表示请求范围通过，1 表示失败；最终状态还明确区分 `session-only-pass`。证据在生成配置旁的 `evidence/`，合成数据在该配置的独立 Roaming 目录。`GITHUB_STEP_SUMMARY` 存在时写摘要，不依赖 artifact 上传额度。CI 应把本段放在构建后、artifact 上传前，并设置 job/step timeout；不要用 continue-on-error 将失败变成 Windows 验收通过。现有工作流尚未接入本工具。

排查 `DevToolsActivePort` 时先保留日志与完整版本，不自动反复启动，不把页面切换到 mock。新的 attach 方案应作为另一次有界实验单独记录。
