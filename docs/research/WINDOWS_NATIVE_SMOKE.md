# Windows 原生冒烟：工具参考与运行环境

本文保留 Windows 原生冒烟所用工具、环境和来源参考。实际运行使用[原生冒烟工具说明](../../apps/desktop/scripts/windows-native-smoke.md)，结果由该次报告记录。

## 已核对的本项目条件

现有 [desktop-checks.yml](../../.github/workflows/desktop-checks.yml) 在 Windows 上完成业务/Rust/浏览器检查后构建 NSIS，随后记录包摘要并上传 artifact。Node 固定 24.14.1、Rust 固定 1.98.1；锁定 Tauri 2.11.6 / tauri-runtime-wry 2.11.4 / Wry 0.55.1 / Tao 0.35.3。原生冒烟应使用这次构建生成的 `apps/desktop/src-tauri/target/release/sidetask.exe`，并单独记录其 SHA-256，不能把安装器自身当应用交给驱动。

`setup_console` 先创建正常控制台，之后创建 edge-panel / edge-handle。三个原生 WebView 使用真实应用协议与同一个 AppState；控制台现在先隐藏，待几何恢复确认或失败反馈后显示。新测试必须等待正常控制台就绪，并将启动恢复页判为首轮空库用例失败，不能只以进程存在判断成功。

当前 Playwright 套件仍是浏览器/IPC 模拟证据，不包含 Windows 原生 WebView2、Rust 窗口回调或实际应用退出。驱动真实 App 后，操作应走实际 UI 和既有 IPC，不安装 mock、不切到 Vite 页面替代。

## 官方依据、固定来源与许可

| 来源 | 已核对结论与使用边界 |
| --- | --- |
| [Tauri WebDriver 指南](https://v2.tauri.app/develop/tests/webdriver/)、[官方 CI 指南](https://v2.tauri.app/develop/tests/webdriver/ci/) | Windows / Linux 可以直接驱动 tauri-driver；CI 指南明确在 windows-latest 直接运行，Linux 才用 Xvfb。现指南也推荐 WDIO embedded 插件，但本轮不引入插件或 IPC mock；先采用外部驱动。 |
| tauri-driver **2.0.6**，tag `tauri-driver-v2.0.6` → commit [`e5ae5b93cdd310045191cc0526f253140ad64b87`](https://github.com/tauri-apps/tauri/tree/e5ae5b93cdd310045191cc0526f253140ad64b87/crates/tauri-driver)；[清单](https://github.com/tauri-apps/tauri/blob/e5ae5b93cdd310045191cc0526f253140ad64b87/crates/tauri-driver/Cargo.toml)、[MIT](https://github.com/tauri-apps/tauri/blob/e5ae5b93cdd310045191cc0526f253140ad64b87/LICENSE_MIT) | Apache-2.0 OR MIT，已读清单/许可和 `server.rs` / `webdriver.rs` / `cli.rs`。Windows 包装 msedgedriver，把 `tauri:options.application` 转为 WebView2 的应用 binary，支持指定 `--native-driver`；会设置 Tauri automation 环境。版本独立于应用 Tauri 版本。固定版本的安装命令为 `cargo install tauri-driver --version 2.0.6 --locked`。 |
| Tauri 官方 [webdriver-example 固定工作流](https://github.com/tauri-apps/webdriver-example/blob/e4c2607cd60287a0ceb69458a0d69d0b676f39a6/.github/workflows/webdriver-v2.yml)，commit `e4c2607cd60287a0ceb69458a0d69d0b676f39a6` | 存在 Windows Selenium / WebdriverIO 路径；已读其 Selenium 示例。该提交未发现 LICENSE / COPYING / NOTICE，GitHub license 字段为 null，因此只作行为参考，不复制工作流或测试代码。示例未固定安装版本，也不能直接当本项目可复现方案。 |
| Microsoft [WebView2 WebDriver 指南](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webdriver)，[固定文档源码 24c6d4d78e5520ac38ab92da0c85fe6a209c1861](https://github.com/MicrosoftDocs/edge-developer/blob/24c6d4d78e5520ac38ab92da0c85fe6a209c1861/microsoft-edge/webview2/how-to/webdriver.md) | 驱动须匹配实际 WebView2 Runtime。launch 自动附着首个实例；多实例建议 attach。Edge WebDriver 不负责系统原生控件操作。本文只引用说明，不复制样例或将 Microsoft 驱动二进制宣称为 MIT。 |
| actions/runner-images commit [`ebade26c60adcb867918b31c8f8caa37343a3d39`](https://github.com/actions/runner-images/tree/ebade26c60adcb867918b31c8f8caa37343a3d39)，[Windows 2025 清单](https://github.com/actions/runner-images/blob/ebade26c60adcb867918b31c8f8caa37343a3d39/images/windows/Windows2025-Readme.md)、[MIT](https://github.com/actions/runner-images/blob/ebade26c60adcb867918b31c8f8caa37343a3d39/LICENSE) | 清单有 Edge / EdgeDriver 及 `EDGEWEBDRIVER` 路径；这不证明它和当前 App 实际使用的 WebView2 一致。镜像随更新变化，应记录运行时 image / OS / runtime / driver 版本。 |

原生冒烟使用独立 Node 工具调用 WebDriver，通过有界请求和进程清理管理真实应用会话，不增加产品运行时依赖。

## 已查到的官方 Windows 失败证据

实际读取了 [官方示例 Windows WebdriverIO job 105924363616](https://github.com/tauri-apps/webdriver-example/actions/runs/35453402606/job/105924363616) 的失败日志：运行时间 2026-09-19，测试提交 `26cd00293e11dc13338c62a9bae6a930eb41ae26`。Tauri 应用已构建为 `target/debug/tauri-app.exe`，但 `/session` 创建反复失败，错误为 `DevToolsActivePort file doesn't exist`，没有任何业务用例通过。该次 Windows Selenium job 为 cancelled，也不能作通过证据。

这说明官方支持与示例工作流存在，不等于当前驱动/runner/应用组合已经可用。该失败不是 SideTask 的已复现 bug，也未定位其根因；不据此断言 Windows 全部不支持。首轮应先定位会话创建与 runtime，而非直接搬整套测试或用无限重试掩盖失败。

## Runner 显示会话与驱动限制

Microsoft 的 [Windows UI 测试说明](https://learn.microsoft.com/en-us/windows/apps/develop/ai-assisted/testing) 明确要求图形会话，并给出 windows-latest。不能将此推断为任意 Windows runner / 服务会话均支持；首轮记录进程 SessionId、是否可交互、实际屏幕/工作区与 native window 句柄。检测无可用图形桌面时，报告环境预检未通过，不能退化成 headless 浏览器后仍标“原生通过”。

WebView2 Evergreen 与 Edge 浏览器可能是不同安装/版本。先查询实际可用 WebView2 Runtime，再选择匹配的 x64 Microsoft Edge Driver；不要只信 runner 清单或无版本的 latest 下载。记录完整版本、解析出的具体下载地址和 SHA-256。Microsoft 的 [Edge 驱动版本规则](https://learn.microsoft.com/en-us/microsoft-edge/webdriver/) 要求前三段一致；WebView2 场景另按其指南核对真实 runtime，不能仅核对 Edge 浏览器。

首轮 launch 使用 `browserName: wry` 与 `tauri:options.application` 指向真实 exe，驱动转换为 WebView2 capabilities。即使会话成功，也先验证实际页面 `surface=console` 和真实 App PID；不要假定首个 WebDriver handle 就是控制台，或三个 WebView 必然都在同一会话可枚举。

## Artifact 配额不足时的证据

逐项检查应直接输出结构化 JSON 行及非零失败退出码，并写简短 job summary：提交/exe SHA、runner/runtime/driver 版本、两个启动 PID、实际 URL/窗口标识、合成 Task ID、revision/内容摘要、退出后 SQLite 检查和各断言状态。纯合成数据可用于有界诊断，但不把整份数据库、截图 base64 或二进制塞入日志。

GitHub 的 [Actions 文档](https://docs.github.com/en/billing/concepts/product-billing/github-actions) 将普通日志/job summary 与 artifact allowance 区分；该方案不调用额外 upload-artifact 来保存测试报告。使用 run/job 链接关联日志，分别报告“检查通过”和“包/截图未保留”。日志断言能证明当次命令及观察结果，**图片的 SHA 不能替代可查看图片，exe SHA 也不能替代可下载安装包**；日志仍受平台保留策略约束。
