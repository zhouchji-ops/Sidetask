# 任务生命周期：软删除与恢复

日期：2026-09-25。本文记录软删除、恢复、迁移和备份格式的实现，相关需求见 [PRD R10](../product/PRD.md)。任务移入回收站后退出日常列表，恢复时保留原 Task ID、DDL、完成状态和全部计划。

## 实现范围

任务服务通过 `trashTask` / `restoreTask` 修改删除标记，普通列表与回收站由同一快照派生。控制台提供单项移入和恢复入口；便携备份 v2 保留任务及回收站记录。

## 两个固定源码参考

仅借鉴公开行为与设计，不复制代码、界面素材或引入依赖。

| 官方仓库与固定版本 | 具体证据 | 本项目采用的部分 |
| --- | --- | --- |
| Tasks.org `tasks/tasks` 15.12，commit `1211fc469459f632b7bf357f61bd9a7c3265bd95`；已读 [GPL-3.0 LICENSE](https://github.com/tasks/tasks/blob/1211fc469459f632b7bf357f61bd9a7c3265bd95/LICENSE) | [Task.kt](https://github.com/tasks/tasks/blob/1211fc469459f632b7bf357f61bd9a7c3265bd95/data/src/commonMain/kotlin/org/tasks/data/entity/Task.kt#L54) 将完成与删除时间分开；[DeletionDao.kt](https://github.com/tasks/tasks/blob/1211fc469459f632b7bf357f61bd9a7c3265bd95/data/src/commonMain/kotlin/org/tasks/data/dao/DeletionDao.kt#L55) 在事务中写删除标记；[TaskDeleter.kt](https://github.com/tasks/tasks/blob/1211fc469459f632b7bf357f61bd9a7c3265bd95/kmp/src/commonMain/kotlin/org/tasks/service/TaskDeleter.kt#L35) 完成后刷新；[测试](https://github.com/tasks/tasks/blob/1211fc469459f632b7bf357f61bd9a7c3265bd95/app/src/androidTest/java/com/todoroo/astrid/service/TaskDeleterTest.kt#L19) 验证标记后记录仍可读取。 | 删除是独立标记，提交后才从活动视图消失。其物理清理、同步、子任务机制不纳入本阶段。 |
| Joplin `laurent22/joplin` v3.3.13，commit `144ed593ccfd3ed4bb92e4e22046bb486cffc5b9`；已读 [LICENSE](https://github.com/laurent22/joplin/blob/144ed593ccfd3ed4bb92e4e22046bb486cffc5b9/LICENSE)，相关目录无覆盖许可，适用 AGPL-3.0-or-later | [restoreItems.ts](https://github.com/laurent22/joplin/blob/144ed593ccfd3ed4bb92e4e22046bb486cffc5b9/packages/lib/services/trash/restoreItems.ts#L56) 读取原记录、清除删除标记；[恢复测试](https://github.com/laurent22/joplin/blob/144ed593ccfd3ed4bb92e4e22046bb486cffc5b9/packages/lib/services/trash/restoreItems.test.ts#L14) 验证重新出现在正常集合，并保留冲突条目的标题和状态。 | 恢复原 Task，而非另建副本；恢复后清楚说明任务在哪。Joplin 的目录层级、同步及自动清理不适用于 SideTask。 |

上述许可核对只用于明确参考边界，不构成第三方源码复用授权决策；本计划没有复制这些实现。

## 数据、迁移和动作契约

1. **单字段**：Rust Task 增 `deleted_at: Option<String>`，serde camelCase/default，None 可省略；TS 对应 `deletedAt?: string | null`。缺失/null 表示正常任务，非空须为有效 UTC RFC3339 时间，由服务端记录。completed/completedAt 与 deletedAt 相互独立；不新增 cancelled/status 枚举或 TaskEvent。
2. **SQLite 升至 schema3**：仍用 app_state JSON，无新表。验证现有 schema1/2 后先做一致性升级前备份，再用一个事务更新身份/版本；旧 Task 缺字段通过默认值读取，不重编码标题、DDL、计划或完成记录。schema1→3、2→3 均明确支持；失败走现有回滚/启动恢复。这样旧 App 会拒绝不支持的数据库版本，避免将删除语义当成旧数据继续写入。
3. **恢复路径跟进**：`verify_schema`/`verify_database`/`verify_before_open`/候选校验需共同接受已定义的 1/2/3；保留 `before-schema-2`、`safety-backup`，新增受控 `before-schema-3` 命名。schema1 的 application_id 规则与 schema2/3 区分。恢复旧备份后正常启动再迁移，不能新增旁路读取或忽略 WAL。
4. **便携备份独立升至 v2**：新导出包含全量任务（含回收站）及全部计划；导入明确支持 v1/v2，v1 缺删除字段视为未删除，拒绝 v1 携带非空删除状态。预览展示总任务、其中回收站、计划数量。恢复沿用整库替换、当前设备设置保留、预先备份和统一提升 revision。导入旧备份会还原备份时的任务集合，不能暗示会与当前回收站自动合并。
5. **浏览器原型兼容**：保持现有存储键，读取旧 Task 时默认无删除状态；同步更新字段白名单和严格时间校验，不清空既有预览数据。回收站仍计入现有备份容量；不通过隐藏/丢弃删除项绕过容量校验。

两个新 Action：`trashTask { id, expectedRevision }`、`restoreTask { id, expectedRevision }`，复用 `mutate(action, snapshotExpectedRevision)`。动作仅更新 deletedAt 和该 Task revision；全局 revision 沿用现有事务递增规则。恢复不改 ID、createdAt、completed/completedAt、优先级、DDL 或任何 Plan。相同目标状态的重复请求在修订号检查通过后不重写时间或 Task revision；过期请求仍返回冲突。

删除状态下拒绝 updateTask、setCompleted、planTask；reorderToday 的精确集合只包含“未删除且未完成”的当天任务，删除项的计划与排序值完整保留。恢复同日计划会重新显示；跨日恢复只返回原日期的计划，按既有规则进入今日、此前未完成或未安排视图，**不自动加入今天或修改 DDL**。若其他任务已重排，恢复项保留存储的 sortOrder，同键继续按现有 Plan 数组顺序稳定排序；不承诺恢复删除前的绝对行号，也不重排其他任务。

## 操作与反馈

- 控制台详情底部提供文字按钮“移入回收站”，与“移出今日”“标记完成”分开。无草稿时直接提交，成功后关闭详情、保留当前列表位置、将焦点交给相邻任务或列表标题，显示“已移入回收站”及“恢复”。失败保留原任务和详情；不用成功动画掩盖写入失败。
- 有草稿时复用现有保存/放弃/继续编辑门禁。选择保存则先保存，只有保存成功才执行删除，并携带**自己这次保存返回的 Task revision**；不要读任意最新 revision 后自动覆盖并发修改。可将 store 的 mutate 返回类型由 void 扩为已提交 Snapshot，无需新增 IPC。保存成功、删除失败时清楚显示任务已保存但未移入回收站，保留可重试入口。
- 侧栏底部新增“回收站”与数量；按 deletedAt 倒序、ID 稳定排序。行内展示标题、原完成状态、DDL、移入时间和“恢复”；详情只读。回收站可复用 VirtualTaskList、四风格与窄窗布局。回收站中搜索仅查回收站，正常全局搜索排除回收站；标签分别写“搜索回收站”“搜索全部任务”。
- 恢复成功提示“任务已恢复”，提供“查看任务”；未完成且仍有当日计划可定位今日，已完成定位已完成，其他定位全部任务并打开详情。保留原完成状态，避免“恢复”被误解为“撤销完成”。恢复失败保持该行及焦点。空回收站说明“移入回收站的任务会保留在这里，可随时恢复”。
- 小窗不增加删除按钮或回收站列表；已有完整编辑入口可到控制台。收到提交后的快照立即移除/恢复相关今日、DDL 行与数字，刷新本身不激活窗口或改变固定状态。

## 并发、草稿与最小验收

全局 expectedRevision 与 Task expectedRevision 均继续检查。控制台删除与小窗完成/安排同时发生，只允许一方基于当时版本成功；冲突后刷新并让用户重新确认，不能自动重放删除、恢复或 toast 操作。撤销提示必须携带删除成功时的 Task revision；后续已恢复再删除时，旧提示不能将新删除撤销掉。

全量 `byId` 保留删除 Task。若已有脏详情收到删除状态，不能因正常列表过滤而卸载表单丢草稿；保留编辑内容，显示“任务已移入回收站，请先恢复”，禁用保存/完成/安排。恢复只清标记，草稿仍由现有冲突机制显式确认后保存。新建、设置和退出草稿保护继续生效。

以下三个阶段组织任务生命周期、界面与备份格式的实现记录：

| 阶段 | 文件与交付 | 必要验收 |
| --- | --- | --- |
| 1. 数据与动作 | Rust domain/application/infrastructure/recovery；TS types 与预览领域；迁移/备份契约 | 活动和已完成任务均能删除/恢复；DDL 纳秒/时区、完成时间、历史/未来/当日 Plan 完全保留；重复与非法时间；完成/排序/恢复交错冲突；保存失败不发布；近容量失败明确。 |
| 2. 日常界面 | 统一 projections/filter、console 回收站/详情/反馈、edge 同步 | 全部相关列表/计数/搜索排除删除项；同日与跨日恢复去向；零活动但有回收站的空状态；10k 混合记录虚拟列表；键盘删除→恢复焦点、四套风格及窄窗。 |
| 3. 升级与恢复复验 | schema1/2 合成库升级、v1/v2 导入导出、现有恢复 GUI | 升级前副本可识别/恢复，任务与计划无损；失败回滚；回收站导出→预览→恢复→重启仍在；旧版本明确拒绝新库；Mac/Windows 各自记录，不以浏览器代替原生。 |

## 可采用的默认决定

默认“回收站”命名、只在控制台操作、无草稿直接移入并提供恢复、保留全部计划与原完成状态、跨日不自动安排今日、正常搜索排除回收站。这些是本计划建议，主任务可直接采用，无需让未决偏好阻塞实现。唯一需在编码前统一的是迁移/备份版本号与文件归属，防止多工作包各自定义。永久删除、自动清理、批量生命周期、取消原因均继续延后。

## 实现状态与数据验证

本节记录本轮从上述方案落实到源码的进度，不能将设计表格本身当作已完成验收。

- `infrastructure/mod.rs` 当前 schema 为 **3**，验证 1/2/3：schema1 的 application_id=0，schema2/3为1396986955。旧库先经原有完整四文件副本预检（包含 WAL 提交）再打开；损坏、主库缺失但有日志、pending 恢复标记等保护保持。schema1/2先完成一致性备份、校验与同步，再在事务中写 schema3 标记，snapshot 与 placement 原文不重编码；失败回滚版本和数据。
- 升级前备份命名 `sidetask-before-schema-3-<UUID>.sqlite3`。`recovery.rs` 同时识别旧 before-schema-2、新 before-schema-3 与 safety-backup。扫描或复制恢复时不迁移源备份；恢复后的正常启动才升级旧 schema。原件和 WAL/SHM/journal 证据保留、候选摘要重查及恢复中断重试逻辑不变。
- `application/mod.rs` 新导出 **portable schemaVersion=2**，全量任务包含回收站，计划含过去/现在/未来。v1/v2 使用同一解析验证路径，v1 缺失/null deletedAt合法，任一非空删除状态拒绝。预览固定 `trashedTaskCount`（其中回收站），`taskCount`仍为全量总数，`planCount`仍为全部计划。
- JSON 备份恢复继续替换整个任务/计划集合、保留本机 settings/placement，创建完整 SQLite 安全副本后提交；deletedAt 原值保留，Task/global revision 统一提升。v1恢复将任务还原为旧备份中的未删除状态，不合并当前回收站。所有回收站记录仍计入 10MiB/10,000任务/100,000计划限制。
- 新字段/TrashTask/RestoreTask与 console 路由由原生领域工作包实现；界面、草稿、投影和浏览器对等实现由各自工作包接入。此数据阶段没有增加删除/清空后台任务，也没有修改正常窗口行为。

数据工作包定向测试（macOS arm64、仅 UUID 临时合成数据）：

```text
cargo test --locked infrastructure::   35 passed / 0 failed（1.91秒）
cargo test --locked application::       9 passed / 0 failed（0.65秒）
```

新增证据包括 schema2升级保留 snapshot/placement 原文及可扫描旧版本副本、schema2升级失败回滚；schema1升级与既有损坏/WAL/中断恢复继续通过。恢复候选测试覆盖 before-schema-2/schema1和before-schema-3/schema2，复制期间不改源，重启再迁3。

便携备份测试覆盖 v2回收站删除时间（含纳秒）和所有计划导出→预览→恢复→SQLite重启、设备信息保留、修订号严格提高；v1缺失/null兼容与非空删除状态拒绝，实际v1恢复替换当前回收站集合。Trash/Restore写入失败分别验证完整已发布快照不变；原备份距离10MiB仅16字节余量时增加删除时间会明确拒绝，任务保持原状态，未越过可恢复容量或悄悄丢弃回收站。

本次继续核对上文两项固定 GitHub 文件与 LICENSE，只使用已记录的行为参考，不复制 GPL/AGPL 实现、没有新增数据依赖。原生工作包独占执行的全 Rust 集成结果：`cargo test --locked` **88/88**（1.85秒），`cargo fmt --check`、`cargo clippy --locked --all-targets -- -D warnings` 均通过。最终95项TS、60项UI和Mac生产构建通过，包含脏草稿、多窗口、失败焦点和万条回收站回归。最后资源 index-GFNXw43Q.js / index-Cp14iSy_.css 已打包并本地验签。上述数字对应本段所列版本与自动化测试环境。
