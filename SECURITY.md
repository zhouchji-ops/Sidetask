# SideTask 安全与试用边界

本文说明 0.1.0 内部试用版的数据保护、权限范围和安全问题反馈方式。

## 已实施的边界

- 任务默认保存在本机SQLite；无账号、云同步或广告接口。
- 窗口IPC同时使用Tauri capabilities和Rust调用方校验。边缘把手不能获取任务内容，边缘小窗不能恢复数据库或获得完整设置/退出能力。
- WebView不开放shell、任意文件路径、远程导航或受信事件伪造能力。备份导出限定应用自管目录；导入读取JSON并严格验证，不运行脚本或迁移SQL。
- 数据库未知版本、损坏结构、非法任务/引用拒绝覆盖；迁移与恢复前先生成、验证并同步安全备份。
- 保存失败不发布虚假状态；恢复提升任务revision，旧编辑不能静默覆盖恢复结果。
- 启动检查失败时进入独立图形恢复界面，不创建空任务服务。仅允许控制台从已验证的本机 SQLite 备份中选择，明确确认后先保留原数据库与日志，再执行替换；成功后提供重新启动入口。操作及文件边界见[数据恢复说明](docs/engineering/DATA_RECOVERY.md#启动检测到数据库损坏恢复界面)。

## 扫描与报告

在apps/desktop执行`npm audit`；安装cargo-audit后执行`cargo audit --file src-tauri/Cargo.lock`。CI同样检查锁定依赖。运行结果和供应链警告见[原生安全复查](docs/research/NATIVE_SECURITY_REVIEW.md)及[阶段记录](docs/research/RELEASE_HARDENING.md)。扫描无已知漏洞不证明不存在未知漏洞。

若发现数据泄漏、权限绕过或数据破坏问题，请向项目维护者私下提供版本、系统、复现步骤及脱敏证据。先查看仓库的 [Security 页面](https://github.com/zhouchji-ops/Sidetask/security)：如果提供 “Report a vulnerability” 入口，可用它提交私密报告；如果没有该入口，可在 [Issue](https://github.com/zhouchji-ops/Sidetask/issues/new) 中仅请求私密联系渠道，不公开漏洞细节、利用步骤或敏感附件。

普通使用问题按[使用说明书](docs/product/USER_GUIDE.md#当前范围与反馈)反馈。任何公开问题都不要附个人数据库、备份、凭据或其他隐私。

## 使用环境

安装包的签名状态与获取方式见[下载与安装](README.md#下载与安装)。原生交互依赖操作系统、显示器布局和输入环境；故障反馈请附系统、包版本及复现步骤。恢复操作前保留数据库与日志副本，具体方法见[数据恢复说明](docs/engineering/DATA_RECOVERY.md)。
