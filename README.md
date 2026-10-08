# 侧笺 · SideTask

**看一眼任务，继续手头的事。**

把今日计划和截止日期放在屏幕边缘。随手查看、直接添加、勾选完成，需要集中整理时再打开完整控制台。

[**完整使用说明书**](docs/product/USER_GUIDE.md) · [下载与安装](#下载与安装)

当前版本为 **0.1.0 内部试用版**。本轮 Mac arm64 / Windows x64 构建包含三列表拖动排序和可选的双端同步；各平台产物状态见下方下载区。

可选启用 **Mac ↔ Windows Supabase 同步**。使用前需自行初始化 Supabase 项目，并在两台电脑登录同一账号，步骤见 [Supabase 配置说明](docs/engineering/SUPABASE_SETUP.md)。真实 Supabase、系统凭据库及双端原生联网验收仍待完成；CI 构建不等于这些场景已通过。

## 用侧笺做什么

- **今日与 DDL，同屏看清。** 小窗上方是今天的安排，下方是截止任务，可按日期、重要程度或手动顺序查看。
- **顺序自己定。** 今日计划、全部任务和截止日期可各自拖动排序；小窗也能直接调整今日和 DDL，拖动不改变截止信息。
- **同一件事，勾选一次。** 今日与 DDL 关联同一项任务，完成或撤销会同步更新；移出今日保留任务和截止日期。
- **想到就加。** 点击今日计划旁的＋，直接在小窗输入并加入今日，保存后可连续添加。
- **小窗随手用，大窗集中管。** 控制台负责完整编辑、搜索、回收站和设置；关闭大窗后，小窗仍可使用。
- **按习惯摆，按喜好选。** 调整边缘位置、尺寸和两区比例，选择纸笺、霜序、暖刊或极简，明暗独立设置。
- **任务保存在本机。** 核心使用无需账号，支持任务备份、导入恢复和误删后的单项恢复。

默认单击把手展开、点击外部收起，也可主动选择悬停模式。Mac 与 Windows 均使用真实外点，单纯切换焦点不收起；小窗隐藏后保留尚未提交的输入草稿。第一版只管理独立任务，没有子任务或部分完成进度。未启用同步时，任务继续只保存在本机。

## 下载与安装

最新安装包已发布到 [GitHub Release：v0.1.0 Beta 1](https://github.com/zhouchji-ops/Sidetask/releases/tag/v0.1.0-beta.1)。安装包来自 [CI 37221920357](https://github.com/zhouchji-ops/Sidetask/actions/runs/37221920357)，对应产品代码 [c922fea](https://github.com/zhouchji-ops/Sidetask/commit/c922fea31d02bc6550d34f3c6de24130965f0060)，包含可选同步。两平台检查、包构建与上传均已通过，Release 文件摘要已与 CI 记录核对一致。

| 平台 | 下载 | 文件 |
| --- | --- | --- |
| Mac · Apple Silicon / arm64 | [下载 Mac 试用包](https://github.com/zhouchji-ops/Sidetask/releases/download/v0.1.0-beta.1/SideTask-macos.zip) | `SideTask-macos.zip` 内的 `SideTask.app` |
| Windows · x64 | [下载 Windows 安装包](https://github.com/zhouchji-ops/Sidetask/releases/download/v0.1.0-beta.1/SideTask_0.1.0_x64-setup.exe) | `SideTask_0.1.0_x64-setup.exe`（4,684,220 字节） |

Mac 下载后解压得到 App；Windows 直接运行下载的安装器。Release 中提供 [SHA256SUMS.txt](https://github.com/zhouchji-ops/Sidetask/releases/download/v0.1.0-beta.1/SHA256SUMS.txt) 校验文件。完整步骤、包摘要、更新和首次启动见[使用说明书：安装与更新](docs/product/USER_GUIDE.md#安装与更新)。

当前 Release 标记为试用版（Pre-release）；Mac 包为临时签名、未公证，Windows 包未签名。Release 附件不受 CI 产物的 14 天保留期限制；本批原始 CI 产物仍于 **2026-10-18 UTC** 到期。请下载上表附件，Release 自动生成的 Source code ZIP 是源码，不是安装包。

## 第一次使用

1. 打开 SideTask，点击“新建任务”，填写名称并确认“安排到今日”已开启，点击“创建任务”。
2. 点击“打开边缘小窗”，在今日计划中查看任务；之后也可从屏幕边缘把手展开。
3. 做完后点击任务左侧勾选按钮，大小窗同步更新。
4. 临时想到新任务，点击小窗今日标题旁的＋，输入后按 Enter 或点击“添加”。
5. 需要备注、DDL 或整理任务，点击任务名称或“管理任务”进入控制台。

关闭控制台只隐藏大窗，菜单栏／系统托盘可以恢复。要结束应用，选择“退出 SideTask”，按提示处理未保存草稿。

## 完整使用说明

[**阅读完整使用说明书 →**](docs/product/USER_GUIDE.md)

| 想做什么 | 直接查看 |
| --- | --- |
| 安装、启动或更新 | [安装与更新](docs/product/USER_GUIDE.md#安装与更新)、[第一次使用](docs/product/USER_GUIDE.md#第一次使用) |
| 创建、编辑、完成或撤销任务 | [任务操作](docs/product/USER_GUIDE.md#创建与编辑任务)、[今日安排](docs/product/USER_GUIDE.md#安排今日与完成任务) |
| 设置 DDL 与排序 | [截止日期与重要程度](docs/product/USER_GUIDE.md#截止日期与重要程度) |
| 调整展开方式、位置、大小和外观 | [边缘小窗](docs/product/USER_GUIDE.md#使用边缘小窗)、[设置](docs/product/USER_GUIDE.md#外观与窗口设置) |
| 查找任务、恢复误删 | [搜索与回收站](docs/product/USER_GUIDE.md#搜索与回收站) |
| 导出备份或恢复数据 | [备份与恢复](docs/product/USER_GUIDE.md#备份与恢复) |
| 配置双端同步 | [同步使用说明](docs/product/USER_GUIDE.md#mac-与-windows-同步)、[Supabase 项目配置](docs/engineering/SUPABASE_SETUP.md) |
| 关闭、退出、使用快捷键或排查问题 | [窗口与键盘](docs/product/USER_GUIDE.md#关闭退出与键盘操作)、[常见问题](docs/product/USER_GUIDE.md#常见问题) |

## 开发与协作

采用 Tauri 2、React / TypeScript、Rust 和 SQLite。界面共用任务服务，平台窗口适配集中在 Rust 平台层；架构、验证和数据恢复资料见下方文档。

默认分支为 `mac`，已包含两平台的内部试用实现。Mac 开发以 `mac` → `origin/mac` 为入口；Windows 开发先同步远端，再从已确认的 `origin/mac` 提交创建 `codex/<任务名>` 分支，并记录所用完整 SHA。不要从旧分支或旧提交历史接续。需要 Node.js 24、Rust 与对应系统的 Tauri 构建环境，详情见[桌面客户端开发说明](apps/desktop/README.md)。

```sh
git clone --branch mac https://github.com/zhouchji-ops/Sidetask.git
cd Sidetask/apps/desktop
npm ci
npm run tauri -- dev
```

只查看浏览器交互原型时可运行 `npm run dev`。浏览器使用独立演示数据，不与原生任务库共用，也不能替代真实系统窗口验收。已有开发目录按[历史整理后的接续说明](docs/UPDATING_CHECKOUT.md)操作：保留原目录及全部未提交、私有文件，在新目录克隆，不把旧历史合回新分支。

正式仓库为 [zhouchji-ops/Sidetask](https://github.com/zhouchji-ops/Sidetask)，远端 `origin` 应指向该地址。平台适配集中在 `apps/desktop/src-tauri/src/platform/`，两平台共享任务模型与数据库规则。

| 资料 | 内容 |
| --- | --- |
| [产品需求](docs/product/PRD.md) / [交互设计](docs/product/UX.md) | 功能范围与交互契约 |
| [技术架构](docs/engineering/ARCHITECTURE.md) / [数据模型](docs/engineering/DATA_MODEL.md) | 窗口、任务与持久化设计 |
| [详细数据恢复](docs/engineering/DATA_RECOVERY.md) / [安全边界](SECURITY.md) | 备份、启动故障与已知限制 |

反馈时附上系统、包版本和重现步骤，具体格式见[说明书](docs/product/USER_GUIDE.md#当前范围与反馈)。个人数据库、导出文件和本地备份不提交仓库。

## 第三方材料

已收录的第三方依赖声明见[前端依赖](apps/desktop/public/third-party/frontend-notices.txt)和[时间处理依赖](apps/desktop/public/third-party/time-dependencies.txt)，对应其中列出的第三方材料。
