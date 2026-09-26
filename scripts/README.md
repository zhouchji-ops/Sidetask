# 仓库级开发脚本

根目录的 `scripts/` 目前没有可执行脚本。现有桌面工具位于[客户端脚本目录](../apps/desktop/scripts)，开发、测试和构建命令见[桌面开发说明](../apps/desktop/README.md)。

| 工具 | 用途与入口 |
| --- | --- |
| [windows-native-smoke.mjs](../apps/desktop/scripts/windows-native-smoke.mjs) | 生成隔离配置并驱动真实 Windows App；先读[运行说明](../apps/desktop/scripts/windows-native-smoke.md) |
| [windows-native-probe.ps1](../apps/desktop/scripts/windows-native-probe.ps1) | Windows 环境、物理窗口与进程探针；配合原生冒烟验证使用 |
| [windows-native-smoke-finalizer.mjs](../apps/desktop/scripts/windows-native-smoke-finalizer.mjs) | 冒烟工具调用的内部收尾模块，负责结果记录与清理；无需单独运行 |
| [measure-windows-resources.ps1](../apps/desktop/scripts/measure-windows-resources.ps1) | 核对指定 EXE 与 PID 后采样进程资源；参数示例见[原生验证](../apps/desktop/README.md#打包与原生验证) |
| [artifact-manifest.mjs](../apps/desktop/scripts/artifact-manifest.mjs) | 为 CI 中构建出的 Mac App 压缩包或 Windows 安装器记录文件大小与 SHA-256 |

这些工具的运行平台与准备步骤不同，不应作为一组命令依次执行。根目录只在需要跨工程的环境检查、构建或发布辅助流程时新增脚本；说明应包含目的、平台、参数、输出与失败行为，构建命令与 CI 保持一致。
