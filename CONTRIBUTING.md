# 参与侧笺 · SideTask

可以通过报告问题、完善文档、补充测试或提交修复参与项目。当前是 0.1.0 双平台内部试用版，已完成与待验证的范围见[验证状态](docs/VALIDATION.md)。

开始前，使用问题先看[使用说明书](docs/product/USER_GUIDE.md)，开发环境看[桌面客户端开发说明](apps/desktop/README.md)，其他资料从[文档导航](docs/README.md)查找。目前仓库未设置项目级 `LICENSE`，许可协议仍待维护者明确。

## 报告问题或提出建议

先搜索[已有 Issues](https://github.com/zhouchji-ops/Sidetask/issues)，确认是否有相同问题。一般缺陷可以[新建 Issue](https://github.com/zhouchji-ops/Sidetask/issues/new)，附上这些信息：

```text
问题概述：
系统版本与架构：
SideTask 版本与来源（安装包 / CI 运行 / 源码完整 SHA）：
复现步骤：
预期结果：
实际结果：
是否稳定复现：
脱敏截图或日志（如有）：
```

窗口问题还需要说明显示器数量、排列和缩放比例，以及单击/悬停模式、固定展开状态；输入问题请附输入法与当时操作。使用合成任务重现，截图、日志和附件中不要包含个人任务、数据库、备份或凭据。疑似安全漏洞按[安全报告说明](SECURITY.md#扫描与报告)处理。

功能建议请说明具体使用场景、遇到的困难与期望操作。第一版围绕独立任务、今日安排、DDL、控制台与边缘小窗展开；子任务、云同步、AI、日历聚合、重复任务和移动端不在当前范围内。涉及范围变化时，先在 Issue 中讨论。

## 提交修改

仓库默认和集成分支是 **`mac`**，其中包含 macOS 与 Windows 实现。分支名不代表项目只支持 Mac。

外部贡献者先 Fork 仓库，通过 GitHub 的 Sync fork 同步上游，再克隆自己的副本。已有个人副本先保留未提交工作、拉取同步后的 `mac`，然后创建主题分支：

```sh
git switch mac
git switch -c codex/docs-navigation
```

完成后向 `zhouchji-ops/Sidetask` 的 **`mac`** 提交 Pull Request。如果使用的是历史清理前的旧副本，先按[工作副本接续说明](docs/UPDATING_CHECKOUT.md)保留旧目录、另行克隆，避免把旧历史合回仓库。

维护者继续按[开发流程](docs/engineering/DEVELOPMENT.md)中的平台分工工作。修改共享服务或窗口协议时，应先协调涉及的两平台改动。

一次 PR 聚焦一个问题，描述：

- 哪个操作或场景存在问题，修改后会怎样。
- 修改涉及哪些界面、平台或数据行为。
- 实际执行的检查、结果，以及未覆盖的平台或场景。
- 如果改变了界面，附合成数据截图；如果改变了窗口行为，附对应原生环境与复现记录。

提交信息可用 `docs:`、`fix:`、`feat:`、`test:` 或 `chore:` 加简短目的。无需为了修改文档运行整套应用构建；纯 Markdown 维护核对内容、链接和差异即可，提交可使用 `[skip ci]`。涉及代码、配置、依赖或工作流时，不应跳过相应检查。

## 代码与验证约定

界面负责展示和用户意图，任务规则在 Rust 业务层，数据库经统一 Repository 访问；平台差异集中在 `apps/desktop/src-tauri/src/platform/`。细节见[架构](docs/engineering/ARCHITECTURE.md)与[数据模型](docs/engineering/DATA_MODEL.md)。

修改时保留这些行为：

- 今日计划与 DDL 引用同一 Task ID；移出今日保留任务、DDL 与完成状态。
- 多窗口共享已提交状态，写入失败保留草稿并显示错误，旧编辑不能静默覆盖新版本。
- 关闭控制台只隐藏窗口，明确退出才结束应用；退出前处理各窗口草稿。
- 窗口坐标区分逻辑单位与物理像素，不能假定主屏原点为零或缩放比为一。

按改动选择验证，具体命令见[开发说明](apps/desktop/README.md#检查)和[测试入口](tests/README.md)：

| 改动 | 应核对的内容 |
| --- | --- |
| 文档 | 事实、相对路径、标题锚点、示例命令与实际配置的一致性 |
| 任务规则与界面 | 相关业务测试、界面回归、类型检查与生产构建 |
| Rust 服务与持久化 | Rust 测试、格式与 Clippy；迁移、失败恢复和重启需使用临时库 |
| 原生窗口与输入 | 相关自动化检查，以及受影响平台上的真实窗口、焦点、手势和输入法验证 |
| 依赖与构建配置 | 锁文件、依赖审计和受影响平台的构建结果 |

浏览器预览和自动化使用合成数据；原生试验使用独立应用 identifier 与数据目录。没有对应设备时，写明“未验证”。单平台、单屏或浏览器通过不能扩展成双平台、多屏或完整原生验收。

## 如何维护文档

现有研究、决策和过程记录保留其历史价值。更新当前说明时，补充适用版本、日期或新结论的入口，不因整理导航而删除过程材料，也不把旧测试数字改成新版本的验证结果。

| 内容变化 | 同步入口 |
| --- | --- |
| 用户操作与功能范围 | [使用说明书](docs/product/USER_GUIDE.md)、[PRD](docs/product/PRD.md)、[UX](docs/product/UX.md) |
| 数据与重要实现取舍 | [架构](docs/engineering/ARCHITECTURE.md)、[数据模型](docs/engineering/DATA_MODEL.md)、[ADR](docs/README.md#技术决策adr) |
| 构建、测试或开发环境 | [桌面开发说明](apps/desktop/README.md)、[测试入口](tests/README.md)，并核对实际配置 |
| 下载与交付范围 | [README](README.md#下载与安装)、[使用说明书](docs/product/USER_GUIDE.md#安装与更新)、[验证状态](docs/VALIDATION.md) |
| 可交付变化、新增文档 | [CHANGELOG](CHANGELOG.md)、[文档导航](docs/README.md) |

公开文档应能独立阅读，不依赖本地内部记录才能完成安装、开发或反馈。已经由忽略规则保留在本地的交接、手工记录和私人资料继续本地留存；不要强制加入公开提交。第三方代码或材料需要核对来源、版本与许可，并保留其必要的归属说明。
