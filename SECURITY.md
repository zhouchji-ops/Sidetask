# SideTask 安全与试用边界

当前版本为 0.1.0 内部试用版，尚未完成公开分发验收或安全认证。

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

普通使用问题按[贡献指南](CONTRIBUTING.md#报告问题或提出建议)反馈。任何公开问题都不要附个人数据库、备份、凭据或其他隐私。

## 尚未完成的发布门槛

两平台完整原生与多屏矩阵、恢复失败的完整场景、真实磁盘满与物理断电、正式签名/公证及完整第三方许可清单仍需完成。历史 Windows 分支已验证限定环境下的启动恢复和已提交任务受控强杀后重启；这不能代替当前整合版的完整异常矩阵或真实断电验证。Mac Dock退出保护已有实现，先前自动化访问Dock超时的记录不能作为实机通过证据。当前验证范围与未覆盖项见[验证摘要](docs/VALIDATION.md)，原始执行证据见内部验收记录（本地保留，未随公开仓库分发）。
