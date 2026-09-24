# SideTask 数据备份与故障恢复

更新：2026-09-25。当前内部试用版本；操作依据为本轮 Rust Repository / TaskService 与 `tauri.conf.json`。Windows 的路径规则已核对 Tauri 2.11.6 源码，但 Windows 实机恢复未验证。

## 先区分两种文件

| 文件 | 内容 | 使用方式 |
| --- | --- | --- |
| `exports/SideTask-<UUID>.json` | 可携带任务与计划；含 schemaVersion / exportedAt | 应用可打开时，在控制台「设置 → 数据备份 → 选择备份恢复」导入 |
| `sidetask-safety-backup-<UUID>.sqlite3` | 恢复前的完整 SQLite，包括本机设置及停靠信息 | 应用完全退出后，按下面离线流程恢复 |
| `sidetask-before-schema-2-<UUID>.sqlite3` | 升级schema前完整SQLite副本 | 同上；新版本再次打开时先验证并安全升级 |
| `sidetask.sqlite3` | 正在使用的唯一任务数据库 | 不能被JSON直接替换，不在应用运行时复制它作为完整备份 |

JSON 文件即使改名为 `.sqlite3` 也不是数据库。SQLite 安全副本也不能从 JSON 文件选择器导入。JSON 恢复保留当前本机设置；离线完整 SQLite 恢复会恢复该副本内的本机设置。

## 数据目录

代码使用 Tauri `app_data_dir()`，应用标识为 `com.changjin.sidetask`：

- macOS：`~/Library/Application Support/com.changjin.sidetask/`。本开发机对应 `/Users/changjin/Library/Application Support/com.changjin.sidetask/`。
- Windows：`%APPDATA%\com.changjin.sidetask\`，通常位于当前用户 `AppData\Roaming`，以实际环境的 `%APPDATA%` 为准。

macOS Finder 的「前往文件夹」可输入上面的路径；Windows 文件资源管理器地址栏可输入含 `%APPDATA%` 的路径。不要在项目源码仓库内寻找个人数据库或把备份提交到 Git。

## 应用可以正常打开：JSON 恢复

1. 先处理当前编辑草稿。数据区在有未保存草稿或正在保存时不允许恢复。
2. 在设置的数据区导出当前任务备份，记下界面返回的完整路径。重要备份另复制到自己管理的安全位置。
3. 选择需要恢复的 JSON，核对任务数、计划数和导出时间。当前限制为 10 MiB / 10,000 任务 / 100,000 计划。
4. 点击「备份当前数据并恢复」。应用先创建经过校验的完整 SQLite 安全副本，再一次事务替换任务与计划；保留当前设备设置和停靠位置。备份或校验失败不恢复。
5. 确认恢复成功及自动安全备份路径。核对今日 / 全部任务 / DDL，退出并重启检查。发生冲突先重新预览，不重复点击强行覆盖。

普通导出产生的文件需要另行保管；现版本没有周期备份或云备份。

## 启动因数据库损坏而失败：离线恢复

当前没有独立的启动恢复向导。以下流程用于内部试用恢复；操作前必须保留原始文件，不能把不明来源备份直接覆盖唯一原库。

1. 明确退出 SideTask，并确认所有 SideTask 应用/开发进程已结束。仅关闭控制台窗口不等于退出。macOS 活动监视器或 Windows 任务管理器可确认；同时停下可能运行的 `tauri dev`。
2. 找到上面的整个数据目录。保留原目录为一个新名字，例如 `com.changjin.sidetask.before-recovery-20260925-153000`；确保该备份名字不存在，不覆盖其他备份。目录内的 `sidetask.sqlite3`、`-wal`、`-shm`、`-journal` 及导出文件一起保留。只有进程全部停止后才能执行这步。
3. 在原位置重新创建空的 `com.changjin.sidetask` 目录。从保留下来的文件中**复制**一份确认过时间与内容的 `sidetask-…-<UUID>.sqlite3` 安全备份到新目录，复制后的名字为 `sidetask.sqlite3`。保留源安全备份不动。新目录不要放旧库的 WAL/SHM/journal；这些文件与旧数据库配套，不能混到恢复副本中。
4. 启动当前 SideTask。应用先校验库版本、身份、结构、SQLite完整性和业务字段，失败则停止，不以空任务或示例数据覆盖。schema1安全副本通过后会再做一次带备份的schema2升级。
5. 若启动成功，先核对任务和计划，再核对停靠屏幕/尺寸等设备设置；完整SQLite副本含创建时的本机配置。确认前继续保留原目录和安全副本。
6. 若仍失败，退出所有进程，保留这次尝试目录为另一个新名字，再把步骤2的原目录恢复原名。不要把多份库或WAL文件混在一起，不删除唯一原始损坏数据。由维护者用副本进一步分析。

只有 JSON 备份时：完成步骤1/2保留整个旧目录，创建空的正式目录并启动应用，再在新空库中使用 JSON 恢复。第一次生成空库属于用户明确选择的新目录，原始损坏数据库仍在单独保留目录中；不要在原库上直接初始化或用JSON替换数据库文件。

可用 SQLite CLI 的维护者可在**副本**上执行只读检查：

```text
sqlite3 -readonly "所选安全备份的绝对路径.sqlite3" "PRAGMA integrity_check; PRAGMA user_version; PRAGMA application_id;"
```

预期 integrity_check 为 `ok`；schema1 的 application_id 为0，schema2为1396986955。此命令只检查SQLite层，不能替代应用对任务/计划/时区/字段的完整校验。不要执行 `.recover`、`VACUUM` 或手工写 SQL 到唯一原库。

## 未覆盖与后续

本轮单元测试已在临时合成数据库中验证损坏拒绝覆盖、迁移回滚、WAL备份和恢复冲突，但没有用个人库演练，也没有Windows真机/磁盘满/断电恢复结果。启动恢复向导、备份轮转、健康检查及两平台离线恢复演练仍是试用发布前的后续事项。
