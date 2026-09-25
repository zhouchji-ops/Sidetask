# Windows 真实 App 自动化冒烟：可行性与首轮边界

2026-09-25，只读调研。用户随后明确Windows专项由Windows开发机接手，本文作为[接手说明](../delivery/WINDOWS_HANDOFF.md)的可选参考，本Mac任务不继续实施。**可在现有 `windows-latest` 上尝试真实 Tauri / WebView2 / Rust / SQLite 链路；尚未安装工具、修改 CI 或启动 SideTask 验证。** 第一阶段仅验证控制台 CRUD、明确退出和重新启动。双窗口附着、原生几何及完整 B12 验收不能提前标记完成，最新执行状态统一见 [STATUS](../delivery/STATUS.md)。

## 已核对的本项目条件

现有 [desktop-checks.yml](../../.github/workflows/desktop-checks.yml) 在 Windows 上完成业务/Rust/浏览器检查后构建 NSIS，随后记录包摘要并上传 artifact。Node 固定 24.14.1、Rust 固定 1.98.1；锁定 Tauri 2.11.6 / tauri-runtime-wry 2.11.4 / Wry 0.55.1 / Tao 0.35.3。原生冒烟应使用这次构建生成的 `apps/desktop/src-tauri/target/release/sidetask.exe`，并单独记录其 SHA-256，不能把安装器自身当应用交给驱动。

`setup_console` 先创建正常控制台，之后创建 edge-panel / edge-handle。三个原生 WebView 使用真实应用协议与同一个 AppState；控制台现在先隐藏，待几何恢复确认或失败反馈后显示。新测试必须等待正常控制台就绪，并将启动恢复页判为首轮空库用例失败，不能只以进程存在判断成功。

当前 Playwright 套件仍是浏览器/IPC 模拟证据，不包含 Windows 原生 WebView2、Rust 窗口回调或实际应用退出。驱动真实 App 后，操作应走实际 UI 和既有 IPC，不安装 mock、不切到 Vite 页面替代。

## 官方依据、固定来源与许可

| 来源 | 已核对结论与使用边界 |
| --- | --- |
| [Tauri WebDriver 指南](https://v2.tauri.app/develop/tests/webdriver/)、[官方 CI 指南](https://v2.tauri.app/develop/tests/webdriver/ci/) | Windows / Linux 可以直接驱动 tauri-driver；CI 指南明确在 windows-latest 直接运行，Linux 才用 Xvfb。现指南也推荐 WDIO embedded 插件，但本轮不引入插件或 IPC mock；先采用外部驱动。 |
| tauri-driver **2.0.6**，tag `tauri-driver-v2.0.6` → commit [`e5ae5b93cdd310045191cc0526f253140ad64b87`](https://github.com/tauri-apps/tauri/tree/e5ae5b93cdd310045191cc0526f253140ad64b87/crates/tauri-driver)；[清单](https://github.com/tauri-apps/tauri/blob/e5ae5b93cdd310045191cc0526f253140ad64b87/crates/tauri-driver/Cargo.toml)、[MIT](https://github.com/tauri-apps/tauri/blob/e5ae5b93cdd310045191cc0526f253140ad64b87/LICENSE_MIT) | Apache-2.0 OR MIT，已读清单/许可和 `server.rs` / `webdriver.rs` / `cli.rs`。Windows 包装 msedgedriver，把 `tauri:options.application` 转为 WebView2 的应用 binary，支持指定 `--native-driver`；会设置 Tauri automation 环境。版本独立于应用 Tauri 版本。后续安装应固定 `cargo install tauri-driver --version 2.0.6 --locked`，本次未执行。 |
| Tauri 官方 [webdriver-example 固定工作流](https://github.com/tauri-apps/webdriver-example/blob/e4c2607cd60287a0ceb69458a0d69d0b676f39a6/.github/workflows/webdriver-v2.yml)，commit `e4c2607cd60287a0ceb69458a0d69d0b676f39a6` | 存在 Windows Selenium / WebdriverIO 路径；已读其 Selenium 示例。该提交未发现 LICENSE / COPYING / NOTICE，GitHub license 字段为 null，因此只作行为参考，不复制工作流或测试代码。示例未固定安装版本，也不能直接当本项目可复现方案。 |
| Microsoft [WebView2 WebDriver 指南](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webdriver)，[固定文档源码 24c6d4d78e5520ac38ab92da0c85fe6a209c1861](https://github.com/MicrosoftDocs/edge-developer/blob/24c6d4d78e5520ac38ab92da0c85fe6a209c1861/microsoft-edge/webview2/how-to/webdriver.md) | 驱动须匹配实际 WebView2 Runtime。launch 自动附着首个实例；多实例建议 attach。Edge WebDriver 不负责系统原生控件操作。本文只引用说明，不复制样例或将 Microsoft 驱动二进制宣称为 MIT。 |
| actions/runner-images commit [`ebade26c60adcb867918b31c8f8caa37343a3d39`](https://github.com/actions/runner-images/tree/ebade26c60adcb867918b31c8f8caa37343a3d39)，[Windows 2025 清单](https://github.com/actions/runner-images/blob/ebade26c60adcb867918b31c8f8caa37343a3d39/images/windows/Windows2025-Readme.md)、[MIT](https://github.com/actions/runner-images/blob/ebade26c60adcb867918b31c8f8caa37343a3d39/LICENSE) | 清单有 Edge / EdgeDriver 及 `EDGEWEBDRIVER` 路径；这不证明它和当前 App 实际使用的 WebView2 一致。镜像随更新变化，应记录运行时 image / OS / runtime / driver 版本。 |

不新增产品依赖。客户端可先用已有 Node 的 HTTP 能力调用少量标准 WebDriver 命令，形成独立、带超时的小型 smoke harness；若后续用 Selenium/WDIO 扩大场景，再固定其版本和许可。没有理由为本阶段引入付费 Mac 驱动或额外云机器。

## 已查到的官方 Windows 失败证据

实际读取了 [官方示例 Windows WebdriverIO job 105924363616](https://github.com/tauri-apps/webdriver-example/actions/runs/35453402606/job/105924363616) 的失败日志：运行时间 2026-09-19，测试提交 `26cd00293e11dc13338c62a9bae6a930eb41ae26`。Tauri 应用已构建为 `target/debug/tauri-app.exe`，但 `/session` 创建反复失败，错误为 `DevToolsActivePort file doesn't exist`，没有任何业务用例通过。该次 Windows Selenium job 为 cancelled，也不能作通过证据。

这说明官方支持与示例工作流存在，不等于当前驱动/runner/应用组合已经可用。该失败不是 SideTask 的已复现 bug，也未定位其根因；不据此断言 Windows 全部不支持。首轮应先定位会话创建与 runtime，而非直接搬整套测试或用无限重试掩盖失败。

## Runner 显示会话与驱动限制

Microsoft 的 [Windows UI 测试说明](https://learn.microsoft.com/en-us/windows/apps/develop/ai-assisted/testing) 明确要求图形会话，并给出 windows-latest。不能将此推断为任意 Windows runner / 服务会话均支持；首轮记录进程 SessionId、是否可交互、实际屏幕/工作区与 native window 句柄。检测无可用图形桌面时，报告环境预检未通过，不能退化成 headless 浏览器后仍标“原生通过”。

WebView2 Evergreen 与 Edge 浏览器可能是不同安装/版本。先查询实际可用 WebView2 Runtime，再选择匹配的 x64 Microsoft Edge Driver；不要只信 runner 清单或无版本的 latest 下载。记录完整版本、解析出的具体下载地址和 SHA-256。Microsoft 的 [Edge 驱动版本规则](https://learn.microsoft.com/en-us/microsoft-edge/webdriver/) 要求前三段一致；WebView2 场景另按其指南核对真实 runtime，不能仅核对 Edge 浏览器。

首轮 launch 使用 `browserName: wry` 与 `tauri:options.application` 指向真实 exe，驱动转换为 WebView2 capabilities。即使会话成功，也先验证实际页面 `surface=console` 和真实 App PID；不要假定首个 WebDriver handle 就是控制台，或三个 WebView 必然都在同一会话可枚举。

## 最小实施顺序（尚未执行）

建议先在 Windows 构建之后、`upload-artifact` 之前增加一段单独命名的预检/冒烟步骤；**不依赖下载 artifact**。已有配额上传失败不能让原生步骤因为放在其后而被跳过。保留现有检查和安装包上传的各自结论。

| 步骤 | 通过条件与截止时间建议 |
| --- | --- |
| 1. 环境和数据隔离 | 60 秒内记录提交、runner image、OS、Node/Rust、WebView2、驱动、桌面会话和应用摘要。使用本次全新 runner 的合成数据；预期 app data 目录必须初始不存在，存在未知数据就失败，不删除它。两次启动复用同一目录。若以后与其他原生任务共用 runner，则改 CI 专用 identifier 构建。 |
| 2. 固定工具准备 | 安装 tauri-driver 2.0.6 与匹配实际 runtime 的 Edge Driver，最多 8 分钟；工具下载/构建失败单列为环境失败，不伪装 App 失败。显式传驱动绝对路径，记录版本和摘要。 |
| 3. 创建真实会话 | 驱动服务 ready 最多 15 秒，单次 session 最多 90 秒、最多一次尝试。应用不得出现启动恢复页；控制台就绪最多 30 秒。失败收集有界进程/驱动/页面诊断后结束，不像上述示例连续重复创建多个 App。 |
| 4. 控制台 CRUD | 用 UI 新建一条合成任务、读取、修改备注/DDL、完成与撤销、移入回收站并恢复；这里的 Delete 是产品既有软删除。断言 Task ID、字段与计划保留；必要时可用既有真实只读 get_snapshot 辅助断言，禁止 mock。动作等待各最多 15 秒，本段总计最多 3 分钟。 |
| 5. 明确退出和重启 | 通过既有 UI 退出入口/草稿确认，30 秒内观察 App 主 PID 真正结束。不要用 `driver.quit` 或强杀替代产品退出通过。进程结束后用标准 SQLite 只读检查合成库并记录 revision/摘要，再建第二个 App 会话，验证新的 PID 和任务持久化。本段最多 3 分钟。 |
| 6. 收尾与结果 | 无论成功失败都打印逐项断言和失败分类。给整个原生段 15 分钟上限；finally 仅回收本段创建的驱动/App 进程。超时后清理不算退出用例通过，不删除其他任务数据。 |

这些时间是将来实施的控制上限，不是性能通过标准或实测耗时。若 launch 复现 DevToolsActivePort 错误，停止本轮并分析日志；下一次有界实验可按微软 attach 方案单独启动真实 App，在进程级环境设置本机调试端口后附着。不要同时改产品逻辑、换测试框架和扩大用例，让会话故障失去可定位性。

## 后续：双窗口与基本原生几何

第一阶段通过后，再验证 WebDriver `window handles` 能否实际发现并切换 console / edge-panel。通过控制台现有入口显示小窗后，在两侧用真实 UI 完成/撤销同一 Task，检查各自真实快照与最终数据库。若 launch 只能操作首个 WebView，按 Microsoft attach 指南使用进程级 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 的远程调试端口与 `ms:edgeOptions.debuggerAddress`，验证实际实例/目标再继续；这仍是待验证路径。**不能把控制台里执行两次相同 IPC 算作双窗口同步证据。**

Edge WebDriver 的主要能力是 WebView 内容，并非任意宿主窗口或托盘控件。基本 native 几何建议独立、有限地用 Win32 helper 按本次 PID 枚举 HWND，记录真实外框、客户区、DPI、当前工作区，用系统位置/尺寸调用触发事件，再检验 placement.console 与重启后的几何。不能提前假定 WebDriver `setWindowRect` 能可靠改变本项目宿主窗口，也不能把 JS 的窗口尺寸或 DOM 截图当作完整系统几何证明。

这类 CI 证据仍不能代替混合 DPI 多屏、负坐标屏幕拼接、实际拔插、睡眠恢复、输入法、全屏/虚拟桌面、托盘交互或“悬停不抢用户其他应用焦点”的真实场景；也不证明 NSIS 安装/升级。runner 单屏上的成功只记录其真实 OS、屏幕和会话条件。

## Artifact 配额不足时的证据

逐项检查应直接输出结构化 JSON 行及非零失败退出码，并写简短 job summary：提交/exe SHA、runner/runtime/driver 版本、两个启动 PID、实际 URL/窗口标识、合成 Task ID、revision/内容摘要、退出后 SQLite 检查和各断言状态。纯合成数据可用于有界诊断，但不把整份数据库、截图 base64 或二进制塞入日志。

GitHub 的 [Actions 文档](https://docs.github.com/en/billing/concepts/product-billing/github-actions) 将普通日志/job summary 与 artifact allowance 区分；该方案不调用额外 upload-artifact 来保存测试报告。使用 run/job 链接关联日志，分别报告“检查通过”和“包/截图未保留”。日志断言能证明当次命令及观察结果，**图片的 SHA 不能替代可查看图片，exe SHA 也不能替代可下载安装包**；日志仍受平台保留策略约束。

本次没有变更计费、删除 artifact、发布 Release、安装新工具或启动任何 App。下一步仅实施上述有界会话预检，再根据实际结果决定接控制台用例；不从本调研推断原生验收通过。
