# ADR-0009：可选 Mac / Windows 账号同步

- 日期：2026-10-04
- 状态：采纳；真实 Supabase 与双端原生验收待配置
- 前置：[ADR-0003](0003-prototype-implementation.md)、[ADR-0005](0005-task-lifecycle-and-backup-schema.md)、[ADR-0008](0008-independent-task-order.md)

## 背景

用户明确把原先三端设想收窄为 Mac 与 Windows，选择 Supabase Free 同账号自动同步，并要求先完成代码、提供项目创建步骤。原有本地模式继续可用。Snapshot 的本机 revision 只用于本机窗口 CAS，不能作为两台电脑的更新时间比较后整份覆盖。

## 决定

同步只包含 Task（含完成、回收站及 DDL）、所有日期 Plan 和今日/全部/DDL 独立手动顺序。本机设置、窗口位置、主题、DDL 展示模式、草稿不进入载荷。Rust 负责 HTTP/Auth/同步，前端只发意图和显示状态，不扩大 WebView 网络 CSP。

云端每 Auth UID 保存一个 protocol 1 JSON 文档和单调递增 revision。`head` 只读版本；`get` 读取新文档；`put` 以预期云端 revision 执行事务 CAS。三个 RPC 从 `auth.uid()` 获取所有者，客户端不能指定其他 user_id；表开启 RLS并撤销普通角色直接写权限。首次插入也使用账号事务锁，防止两端同时创建。重复提交相同内容返回已接受版本，覆盖请求响应丢失情形。

本地 SQLite schema7 增加独立 sync 元数据：device ID、公开配置、UID/email、启用状态、已确认远端 revision、基线和最近同步时间。当前任务状态相对基线的差异就是持久的待同步修改，不维护第二份操作日志；重启可重新计算。任务修改仍走既有 SQLite 事务，合并快照与新基线一起提交并对快照、元数据作本机 CAS。网络请求期间不持 TaskService 锁，网络返回后重新检查本机状态，保留期间的新修改；退出请求期间不再提交异步结果。

三方合并比较已确认基线、本机、云端。任务 revision 在载荷固定为0，各机收到变化时各自维护本机修订号。标题、备注、重要程度分别合并；DDL四字段与完成状态各为原子组。删除/恢复独立处理，不由过期编辑隐式恢复；任务记录不硬删。计划成员用 `(Task ID, date)` 与基线比较，确保移出计划可传播；任务并集保留回收站引用。每份顺序独立合并，新增任务与单侧重排可共存，真正并发重排或同字段不同修改要求逐项选择。用户选择只适用于当时的本机内容、远端版本和冲突值，变化后重新核对。

登录使用已有邮箱/密码账号。密码不存储；access/refresh token 仅进入 Windows Credential Manager 或 macOS Keychain，不进入 SQLite、导出、IPC 状态或日志。刷新令牌旋转后先保存新凭据；失效时保留基线、停止自动重试并要求原账号重新登录。只接受 hosted Supabase HTTPS 地址和 publishable/legacy anon key，不接受服务密钥。断开先暂停同步再清理凭据，失败可重试。

首次连接显式确认合并，不直接以某一端覆盖；不同 Task ID 不按同名去重。JSON 旧备份恢复需要先断开，避免全库替换自动写向远端；断开不清除任务或云端文档。升级schema7前备份旧1–6，快照/窗口原文保持；便携任务JSON仍为v3。

## 代价与边界

小型个人任务库选择整体文档 CAS，比逐实体操作日志更容易验证与恢复；任务编辑会上传文档，故限制10MiB、1万Task、10万Plan，并每30秒仅检查版本，无变化不重复下载。它不提供共享协作、历史版本、手机或任意自托管地址。大型数据、多用户产品需重新评估增量协议与服务额度。

Supabase Free 的暂停/额度限制仍影响在线同步，本机保存不依赖云端。公开安装包与真实双端验收分别记录证据，不能以合成测试、CI构建或旧安装包宣称真实部署通过。配置步骤见 [SUPABASE_SETUP](../engineering/SUPABASE_SETUP.md)。
