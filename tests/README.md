# 测试与验证

自动化测试位于桌面客户端内，命令以 [package.json](../apps/desktop/package.json)、[Rust 工程](../apps/desktop/src-tauri/Cargo.toml)和 [CI 工作流](../.github/workflows/desktop-checks.yml)为准。在 `apps/desktop` 目录执行：

```sh
npm ci
npm test
npm run test:tools
npx playwright install chromium
npm run test:ui
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

| 入口 | 覆盖范围 |
| --- | --- |
| [TypeScript 业务测试](../apps/desktop/tests/domain.test.ts) | 任务、今日计划、DDL 与派生视图规则 |
| [界面测试](../apps/desktop/tests) | Playwright 浏览器交互回归，包括草稿、跨窗状态和恢复路径 |
| [工具测试](../apps/desktop/tests/windows-native-smoke-finalizer.test.mjs) | Windows 原生冒烟工具在失败路径中的证据记录与进程清理契约 |
| [Rust 测试](../apps/desktop/src-tauri/src) | 领域、业务服务、SQLite、迁移、恢复和窗口规则中的单元与集成测试 |
| [Windows 原生冒烟](../apps/desktop/scripts/windows-native-smoke.md) | 在 Windows 交互桌面以隔离配置驱动真实 EXE、WebView2 和 SQLite；需额外构建与驱动准备 |
| [性能样本](performance) | 指定版本与合成数据下的前端测量，不代表所有设备或长期资源表现 |

已执行检查与尚未覆盖的范围见[验证状态](../docs/VALIDATION.md)。手工验收原始记录本地留存，公开摘要不能替代原始截图、日志或逐项记录。记录新结果时应写明构建版本、系统、显示器和缩放配置；浏览器与纯算法测试不能代替原生多屏验证。测试只使用合成数据，不提交个人任务库。
