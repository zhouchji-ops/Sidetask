# 数据可靠性加固与参考

日期：2026-09-25。对应 B06 / B11 / B25。范围为 Rust Repository、TaskService 和临时合成数据库；未打开、导入、删除或改写个人任务数据库。本文是本轮工程证据，不代表双平台数据恢复验收完成。

## 已证实风险与改动

| 原行为 / 风险 | 本轮行为 |
| --- | --- |
| `user_version=0` 就初始化，可把非本项目库当作新库 | 只有本次以 `create_new` 创建的文件可初始化；现存空文件、零版本、未知版本、身份不符均拒绝打开 |
| schema1 只验证版本，没有检查表、触发器、缺失快照与业务关系 | 校验 application_id、表/列/主键/非空约束、未知对象/记录、完整性；调用领域 `Snapshot::validate()` 校验任务、计划、设置和修订号 |
| schema1 缺 snapshot 时重新写入示例 | 快照缺失或损坏即停止，保留原库；真正新库一次事务创建默认设置和空任务/计划 |
| 无迁移前可恢复副本 | schema1 → schema2 前执行 SQLite `VACUUM INTO`，校验备份并同步文件；成功后才在一个事务更新身份与版本 |
| 内存 revision 检查无法防止第二连接更新后被旧 Repository 覆盖 | `BEGIN IMMEDIATE` 内对比之前加载的完整持久化快照，冲突不覆盖；提交后才更新 Repository 基线与 TaskService 内存 |
| 没有受控的备份恢复 | JSON 导出/预览/恢复统一校验；恢复前自动生成完整 SQLite 安全备份，成功后一次事务替换任务/计划，保留设备偏好和 placement |

schema2 仍使用 `app_state` JSON snapshot，没有冒称完成规范化 Task / DailyPlan 表。相对 schema1 只增加 SQLite `application_id=0x5344544b`、`user_version=2`，既有 snapshot JSON **不重编码**；旧 uiStyle、DDL 字段的只读兼容由领域层负责。

新建 SQLite 文件和安全备份在 Unix 上使用 0600；已有文件不改权限。连接设置 `trusted_schema=OFF`、外键、`synchronous=FULL`、`fullfsync=ON`，写锁等待 3 秒。备份不复制正在写入的单独 `.db` 文件，已验证包含 WAL 中提交内容。同步安全备份文件；Unix 同步其父目录。Windows 文件 ACL、目录项断电持久性和实际图形恢复尚未验收。

## 备份契约与恢复冲突

- `TaskService::export_backup() -> Result<String, String>`：可携带的 JSON，含 `schemaVersion: 1`、`exportedAt`、`tasks`、`plans`；排除 settings / placement。
- `preview_restore(content) -> RestorePreview`：返回 taskCount / planCount / exportedAt。
- `restore_backup(content, expected_revision) -> RestoreResult`：返回已提交 snapshot 与 safetyBackupPath。预览后数据改变即拒绝；自动安全备份失败不进入保存。
- JSON 最大 10 MiB、10,000 任务、100,000 计划；SQLite 快照最大 16 MiB。版本、未知字段、任务字段、时间、引用唯一性、完成状态与修订号都要校验；预览与执行使用同一解析函数，导出的文件也必须通过该函数。
- 恢复 revision 取 `max(当前全局revision, 导入task revisions) + 1`；每个恢复任务使用该新 revision。这样在 store 刷新后仍握有旧实体 revision 的编辑草稿也不能覆盖恢复数据。保留 ID 与计划关系，不回退全局序号；超过 JavaScript 安全整数上限则拒绝。
- 完整 SQLite 安全备份默认保留在数据库同目录，命名 `sidetask-safety-backup-<UUID>.sqlite3`；迁移备份为 `sidetask-before-schema-2-<UUID>.sqlite3`。不自动轮转/删除备份。

IPC、导出文件落盘、窗口权限与控制台 UI 由本轮其他工作包接入；本文件不替代其原生手工验收。恢复操作说明见 [DATA_RECOVERY](../engineering/DATA_RECOVERY.md)。

## GitHub 与一手参考

1. [rusqlite v0.37.0 backup.rs 固定提交](https://github.com/rusqlite/rusqlite/blob/44e0ef965580b94d59c5dfe8874b57ab5993a8f7/src/backup.rs)：核对 API 使用与官方备份测试模式；文件开头明确列出 `VACUUM INTO` 作为一致性备份方式。`git ls-remote` 核对 tag `v0.37.0` 指向该提交。许可：[MIT](https://github.com/rusqlite/rusqlite/blob/44e0ef965580b94d59c5dfe8874b57ab5993a8f7/LICENSE)。已读取许可；没有复制其源码或样例代码，也没有新增备份依赖。
2. [SQLite VACUUM](https://sqlite.org/lang_vacuum.html)：采用 `VACUUM INTO` 保留源库，目标必须为不存在或空文件；使用绑定参数传入本工具新建的唯一目标，失败时删除本次不完整输出。同步与重新打开校验后才允许迁移或恢复。
3. [SQLite Online Backup](https://sqlite.org/backup.html)：核对运行中数据库的一致性备份要求，不把直接复制 `.sqlite3` 当成 WAL 安全备份。
4. [SQLite PRAGMA](https://sqlite.org/pragma.html)：核对 `integrity_check`、`application_id`、`trusted_schema` 与同步配置。完整性检查和业务校验相互补充，不能由其中一个证明另一个。

## 实际验证

在本机 macOS / Apple Silicon 执行：

```sh
/Users/changjin/.cargo/bin/rustfmt --edition 2021 apps/desktop/src-tauri/src/infrastructure/mod.rs apps/desktop/src-tauri/src/application/mod.rs
/Users/changjin/.cargo/bin/cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --locked
```

首轮30/30通过；容量防护与其他工作包集成后，最近一次44/44通过，0失败（0.25秒），无编译警告。这是执行时刻的全 Rust 测试总数；其他 agent 后续新增测试时，以最终集成结果为准。本包新增15项有意义的测试：

- 首次使用及重启空库，无 demo；schema1 snapshot 原始 JSON 字节及 uiStyle 兼容保留；迁移只做一次。
- 迁移 SQL 在两个版本标记更新后注入错误，原事务回滚，schema1 与安全备份内容一致。
- 现存零字节/非SQLite/零版本/未知版本/不符字段拒绝覆盖。
- 缺快照、坏JSON、孤立计划、触发器及易与 SQLite 内部对象前缀混淆的表名均拒绝；原始文件字节不变。
- 停靠位置第二次写入注入失败，快照写入回滚，修复故障后可重试；第二 Repository 不能覆盖未见提交。
- WAL 内容进入备份；备份完整性/版本/任务内容与 Unix 0600 权限通过。
- 恢复前备份真实旧数据、保持设备设置/placement、提升任务 revision 拒绝旧草稿；提交冲突时内存和数据库保留原状态，安全备份仍存在。
- 导入坏版本/字段/关系/日期/完成状态/大小、备份不可用、预览过期、revision耗尽全部失败且不发布新状态；容量边界拒绝新写入且不发布失败状态。

所有磁盘测试使用以 UUID 命名的系统临时目录，测试结束只清理该次目录。没有使用个人数据作为 fixture。首轮领域函数未使用警告已由对应工作包消除。

## 阶段反思与后续门槛

- **启动损坏时的图形恢复入口尚缺**：目前 setup 会明确报错退出，不能声称用户已可在损坏状态内点按钮恢复。离线恢复指引已提供，仍需恢复向导与可执行真机演练。
- **还需 Windows 和真实故障证据**：当前合成 SQLite 测试验证事务错误路径，不等于真实断电、磁盘满、系统强杀与不同文件系统全通过。
- **阶段复审发现并修复容量差异**：SQLite读取上限16MiB、便携备份10MiB可能导致新写入增长到不能导出的大小。已在TaskService每次mutation与恢复前检查同一便携备份容量，超出即拒绝提交且保留旧状态；新增10,000任务边界测试。现有较大旧库不会为了满足新限制被截断或覆盖，长期分批/流式备份仍待产品策略。schema2仍为快照表，规范化模型未完成。
- **恢复需要有持续有效的备份**：没有周期备份、保留策略或跨设备副本。用户可导出，自动安全副本仅在迁移/恢复前创建。
- **安全目标不是绝对保证**：严格解析和事务减少已识别失败路径；同一用户权限下外部篡改文件、硬件损坏与未知漏洞仍不能用单轮测试排除。B06 / B11 父项保持 In progress，B25 原生空库能力具备，完整首次使用/Windows验收由主agent汇总。
