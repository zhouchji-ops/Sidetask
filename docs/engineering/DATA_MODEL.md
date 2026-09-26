# 数据模型与业务一致性

状态：当前实现继续使用 SQLite 的 app_state JSON snapshot。schema 3 加入 Task.deletedAt；schema 4 为 placement.console 及字段合并建立兼容边界；当前 schema 5 为 Settings.revealMode 建立新边界，任务协议保持不变。类型见 `apps/desktop/src/lib/types.ts` 与 Rust 平台几何类型，实际协议见本文末尾各扩展小节。下方实体关系与目标协议用于说明模型设计；实际存储格式为 `app_state` JSON 快照，版本控制使用 `Snapshot.revision` 和 `Task.revision`，具体格式以各“实际”协议小节为准。控制台与边缘小窗共享 Rust 服务和数据库。架构取舍见 [ADR-0004](../decisions/0004-data-safety-and-fixed-deadlines.md) 与 [ADR-0006](../decisions/0006-console-window-preferences.md)，实际完成度、测试数字与双平台验收见内部验证记录（本地保留，不随公开仓库分发）。

首版仅有独立的大任务。模型中不设 `parent_id`、子任务表、任务依赖、步骤清单、百分比进度或父子完成聚合；备注是普通文本，不支持可独立勾选的步骤。一次勾选表示整项任务完成，加入今日也不会创建一天的小任务或进度记录。见 [ADR-0002](../decisions/0002-console-and-edge-panel.md)。

## 实体

### Task

| 字段 | 含义 |
| --- | --- |
| id | 稳定 UUID，全局引用的任务身份 |
| title / notes | 标题与可选备注；标题去首尾空格后非空 |
| status | `open` / `done` |
| priority | `high` / `normal` / `low`；默认 normal |
| due_kind | `none` / `date` / `datetime` |
| due_date | date 模式使用 `YYYY-MM-DD` |
| due_at_utc | datetime 模式使用 UTC 瞬间 |
| due_timezone | 有 DDL 时保存 IANA 时区，用于解释日期及显示来源 |
| completed_at | 完成时间 UTC；仅 done 时非空 |
| created_at / updated_at | UTC 时间 |
| deleted_at | 与完成状态独立的 UTC 软删除时间；当前 JSON 字段 deletedAt，缺失/null 表示未删除 |
| revision | 单调递增整数，防止旧界面覆盖新状态 |

约束：none 时所有 DDL 字段为空；date 时仅 due_date + due_timezone 非空；datetime 时仅 due_at_utc + due_timezone 非空。status 与 completed_at 必须一致。

上述 status/due_kind 为目标命名，当前 JSON 仍使用 completed、dueDate/dueTime、dueTimezone/dueAtUtc。deletedAt 不改变 completed/completedAt：已完成和未完成任务均可移入回收站。恢复只清除删除标记，保留 Task ID、内容、DDL、优先级、创建和完成时间，不引入取消状态、父子关系或完成事件表。

### DailyPlanEntry

| 字段 | 含义 |
| --- | --- |
| task_id | 外键引用 Task.id |
| plan_date | 某个本地日历日 `YYYY-MM-DD` |
| sort_order | 今日清单内的手动排序键 |
| created_at | 安排时间 UTC |

唯一约束 `(task_id, plan_date)`。不存另一份 title、status、due、priority。当前 JSON 引用和唯一性由领域校验，规范化后的外键约束仍属目标设计。软删除和恢复完整保留当天、历史、未来计划及其排序值；本阶段不提供永久删除或自动清理。

### DailyPlanRevision（目标）

每个 `plan_date` 保存一个 `revision`，用于检查同一天计划引用与排序的并发修改。添加、移出或重排计划在同一事务更新引用及该日 revision；一天尚无安排时按初始 revision 处理。任务内容修改不必递增计划 revision，任务完成状态依然只在 Task 内存一份。

当前 schema 5 延续 schema 3 的 Snapshot.revision，保护全部计划操作，不新增每日 revision 字段。软删除/恢复另校验 Task.revision；同一服务内先验证版本，再保存并发布提交结果。

### DevicePreferences / PreferenceApplyState（目标）

`DevicePreferences` 是本机设置，与 Task 和 DailyPlanEntry 分开；由 Rust 设置服务统一读写，包含独立的 `revision` 和 `updated_at`。建议按职责组织：

| 设置组 | 持久化内容 |
| --- | --- |
| edge_panel | 边缘入口启用/暂停、最近停靠显示器、边缘、沿边相对偏移、逻辑宽高、分区比例、展开方式（click默认/hover）、悬停展开/收起延迟、固定展开偏好、置顶和 DDL 排序 |
| console | 普通窗口的逻辑尺寸、恢复位置及最大化偏好；与小窗几何独立 |
| system | 快捷键、登录启动偏好 |
| appearance | uiStyle：paper / studio / editorial / mono；独立系统/浅色/深色偏好、减少动态效果等已确定的展示设置 |

显示器身份、几何、快捷键和登录启动只对当前设备解释，恢复任务备份不覆盖它们。`console` 位置恢复后只需可见可操作，不要求永远位于单屏内；`edge_panel` 每次恢复或重新停靠时验证当前屏幕边界。最近停靠显示器不是不可改变的绑定，用户拖动完成后可更新。

`PreferenceApplyState` 是运行态，记录 `desiredRevision`、`appliedRevision`、实际已生效配置及应用失败信息。它不能反过来当持久化期望值，也不能以设置已落盘推断系统操作成功。显示器已断开、快捷键注册失败等情况在控制台明确显示；失败设置可重试，保留上一套安全实际配置。

鼠标是否在区域内、控制台是否获焦、悬停计时器、当前编辑草稿、展开状态、交互保护计数和正在应用设置的代次属于运行态，不写入任务数据。固定“偏好”与当前窗口是否实际可见分别处理。

拖动时的指针捕获、候选显示器/边缘、旧停靠快照和开始时设置 revision 也是运行态，不逐帧持久化。拖动结束校准后，通过一次设置命令保存新停靠位置；取消或写入失败恢复最近已提交的合法位置。控制台并发修改导致 revision 冲突时保留最新持久化配置，不以旧拖动快照覆盖；屏幕失效由窗口层取消旧动作并安全回退。固定展开不表示锁定屏幕或位置。

### StoreMetadata / SchemaVersion（目标）

数据库元数据包含 `dataset_epoch` 和 `change_seq`。任何可查询持久化变更在同一事务递增 `change_seq`；它用于跨窗口快照的新旧比较，不能代替实体 revision 的冲突检查。整体恢复数据后生成新的 `dataset_epoch`，避免旧窗口把恢复前的较大序号误认成新数据。

迁移元数据记录 schema 版本和执行结果；导出同样包含 schemaVersion。应用版本不等于数据库版本。

## 查询视图

- 今日：DailyPlanEntry.plan_date 等于当前本地日期，关联非删除 Task；完成项放进该日已完成区。
- 此前未完成：未完成/未删除 Task 有历史计划，其最近计划日早于今天，且无今天计划；按 Task 去重。点击转入今日新增今天引用，保留历史。
- 移出今日后若还有历史计划，会回到「此前未完成」待安排组；这符合只移除当日安排的语义。MVP 没有「今天忽略」功能，不能用删除引用实现彻底隐藏。
- DDL：未删除且有截止字段的任务，默认展示 open；done 在折叠区。即使它同时在今日，也不从 DDL 区消失。
- 全部任务：未删除且未完成的任务，含无 DDL 且不在今日的任务，防止用户移出今日后找不到；已完成任务另在“已完成”页展示。

正常全局搜索覆盖未删除的未完成和已完成任务。回收站独立展示删除任务，按 deletedAt 倒序、ID 稳定排序，其搜索只查回收站标题/备注。所有日常列表、侧栏数字、今日完成分母、DDL 与时间刷新边界排除删除任务；全量 ID 索引仍保留原 Task，供详情草稿与恢复使用。

MVP 历史计划仅记录「安排过」，不提供按历史日期统计完成率的功能。以后需要历史完成事实时加入 TaskEvent，不倒推当前状态。

## 命令与事务

下表沿用规范化目标的用例名称与计划/设置版本；当前动作名、快照写入协议和生命周期规则以末节为准。

| 命令 | 原子操作 | 明确不做的事 |
| --- | --- | --- |
| createTask | 校验并插入 Task；若来自今日入口，同事务建立计划引用 | 不隐式设置 DDL 为今天 |
| addToToday | 校验计划 revision，插入今日引用并更新该日 revision；重复已存在引用无额外效果 | 不克隆任务，不改 DDL |
| removeFromToday | 校验计划 revision，删除该日引用并更新该日 revision | 不删除 Task，不改变完成状态 |
| reorderToday | 校验计划 revision，原子更新该日排序键并递增 revision | 不改变任务 DDL 或优先级 |
| completeTask | 校验任务 revision，置 done，写 completed_at，revision + 1 | 不逐列表分别勾选 |
| reopenTask | 校验任务 revision，置 open，清 completed_at，revision + 1 | 不丢失计划、优先级或 DDL |
| editTask | 校验 revision 后更新允许字段 | 不让过期界面静默覆盖较新数据 |
| trashTask / restoreTask | 校验快照和任务 revision，设置/清除 deletedAt，保留全部计划与完成字段 | 不删除 Task/Plan，不改变 DDL，不自动安排到今天 |
| updatePreferences | 校验设置 revision 并提交；随后请求协调器应用已提交设置 | 不在数据库失败时提前变更实际系统状态 |

每次真实变更同时更新 `change_seq`；业务数据、完成时间、实体/计划 revision 和全局序号在同一事务提交。命令返回已提交结果及版本标记，然后发布小型失效通知（数据集代次、变更序号、受影响类型/ID），界面通过返回值或重查获取已提交数据。通知发送失败不回滚已经提交的事务，也不能让用户因误报失败重复创建任务。

此处 change_seq、每日和设置 revision 描述目标协议；当前实际使用 Snapshot.revision 与 Task.revision，任务动作仍遵循下方 schema 3 生命周期契约，不将这些目标字段当成已存在的数据列。schema 4 的控制台位置写入独立于这些任务版本。

用 `setCompleted(true/false)` 表达意图，比没有目标状态的 toggle 更容易处理重复请求。重复完成已完成任务保持原 completed_at；如果携带的是过期 revision，返回冲突及当前值，前端判断目标是否已达到，否则请用户重新确认，不静默覆盖。计划操作同时校验引用的任务存在且未删除。

MVP 可在提交期间禁用重复提交按钮，等待服务端确认后更新 UI；若做乐观更新则必须有回滚，不能显示保存成功后实际丢失。

### 两个窗口同时操作

控制台编辑任务时，小窗可能同时完成它。当前每个命令都带快照 `expectedRevision`，任务编辑另带 Task revision，由 Rust 写入锁内的校验和 Repository 事务决定唯一结果；不依赖“控制台先打开”“最后一次前端事件”或 UI 禁用按钮实现并发控制。发生冲突时展示新状态，保留未提交草稿，让用户重新确认受影响修改。当前计划排序和设置保存也用全局快照版本，未来规范化模型才分别使用该日计划 revision、设置 revision。

删除与完成、计划重排交错时也适用当前快照版本锁。旧“恢复”提示须携带其对应删除的 Task revision，不能撤销新一次删除。表单草稿独立于列表投影；另一窗口删除该 Task 后仍保留输入，恢复动作本身不能卸载脏详情。恢复后基于新版本明确确认草稿，再执行编辑；不得直接用最新 revision 静默重放旧修改。

### 订阅与快照协议

以下描述含 dataset_epoch/change_seq 的目标协议；当前以 Snapshot.revision 完成版本比较，整份恢复的当前处理见末节。

1. 窗口加载时先注册 Rust 变更通知监听，等待注册完成；此时先缓存通知，不直接把事件内容写成任务数据。
2. 通过查询命令请求所需视图快照。服务在同一个读事务读取任务、计划、相关设置及 `(dataset_epoch, change_seq)`，保证这份快照内部一致。
3. 安装快照前检查数据集代次和查询代次，丢弃已经过期的查询响应。缓冲通知中若有同代次更大的序号，则继续查询最新快照；小于等于快照序号的通知可忽略。收到不同代次时清理旧缓存并重新初始化。
4. 正常通知仅将缓存标为过期并合并刷新，不盲目逐事件修改字段。事件丢失、重复或乱序不改变数据库事实；发送端不以通知成功决定事务是否成功。
5. 窗口重新显示、订阅重新建立、睡眠恢复和恢复备份后主动重查；仍可见的另一窗口依靠提交通知及时刷新。若通知发布失败，服务记录失效标记并重试通知，配合再次展示/恢复时的快照校准。
6. 窗口销毁或组件解绑时取消监听和旧请求的应用资格，防止反复打开后积累重复监听器。

这是 SideTask 的一致性协议设计；Tauri 事件 API 只提供传输机制，不自动提供可靠重放、事务快照或修订号冲突处理。[Tauri Rust → Frontend](https://v2.tauri.app/develop/calling-frontend/)

### 设置保存与应用

数据库和系统设置不能跨边界原子提交。`updatePreferences` 返回结果必须包含 `savedRevision` 以及应用结果：未保存、已保存且生效、已保存但应用失败。提交失败不发布设置成功事件，不改变旧生效配置。提交后应用失败则保留新期望值，界面明确展示错误、实际生效值与重试入口；没有可安全维持的小窗位置时隐藏小窗，控制台和托盘仍可恢复。

设置变更必须串行应用，并携带 revision/操作代次。旧应用回调晚到不能覆盖新设置；设置应用成功后由协调器发布生效状态，不能由 UI 收到“已保存”自行假定成功。重启重新应用期望值，对拔屏、快捷键占用、登录启动权限变化等逐项报告，不掩盖部分失败。

## 时间与排序

「计划日」跟随用户当前系统本地日历日；保留的日期字符串不会因为时区变化被批量重写。

创建 DDL 时默认采用当前时区并保存：

- date：例如 `2026-09-30` / `Asia/Shanghai`。到该时区 `2026-10-01 00:00` 起逾期，不使用人为的 `23:59:59.999`。计算下一天的日历边界，不能简单加 24 小时，避免夏令时问题。
- datetime：保存精确 UTC 瞬间及原时区；`now >= due_at_utc` 时逾期。系统时区变化不改变这个瞬间。
- 切换时区后，date 的约定仍按已保存时区解释；来源时区与当前时区不同则展示提示。MVP 可默认系统时区，后续再提供完整手动时区选择。
- 对有夏令时的当地时间，不存在/歧义时刻需在输入转换时提示或让用户选择，不能静默漂移。

默认 DDL 排序使用有效截止瞬间升序；date 使用下一日开始作为比较边界。同键再按 created_at、id。优先级模式的键为 `(priorityRank, effectiveDue, created_at, id)`；没有 DDL 的任务不参加 DDL 列表排序。

排序键不用于直接生成显示日期：date 用 due_date 及其保存时区的当前日历日判断「今天」；datetime 按当前显示时区的日历日判断「今天」，必要时显示原时区。逾期判断优先，依据有效截止瞬间。优先级模式以优先级分组，只保留日期标签，不用日期分组改变优先级主排序。

午夜、最近一个有效截止瞬间到点、任一窗口重新显示、睡眠恢复、时区或系统时间变更时刷新派生视图，不修改原始 DDL。使用可重排的下一边界定时器，编辑 DDL 后重新安排，不用高频轮询。时间边界不会增加数据库 change_seq，Rust 需另发视图失效通知使所有可见任务窗口重查当前时间派生状态，不能只按持久化序号过滤掉它。

## 备份、恢复与迁移

- 导出内容含全部任务（含回收站）、全部计划、版本和导出时间；首版任务备份排除 DevicePreferences 等设备专属设置，恢复保留当前设备配置并重新校验窗口几何。便携 v2 读取 v1/v2 的实际兼容规则见末节。
- 导入前验证字段/外键/唯一性/版本，展示条数和处理策略，再一次事务落盘。MVP 优先「备份后整体恢复」，不实现含糊的自动多库合并。
- 恢复、数据库迁移前创建一致性备份；失败不能把半更新库当成正常数据继续使用。整体恢复成功后通知两个任务窗口丢弃旧查询结果并重新取快照；当前提高版本号，目标协议另更换数据集代次。
- 任务数据库、个人备份与导出不在源码目录，不提交 Git。

数据模型验收至少覆盖：同源完成与撤销、重复加入今日、移出今日、软删除恢复、写入失败、跨日、时区、同优先级排序、重启恢复、跨窗口 revision 冲突、订阅/快照竞争、事件丢失后恢复、设置保存/应用分别失败。另需核对任务结构及入口不包含拆解功能。详见验收计划。

## 历史原型外观兼容（2026-09-25）

schema1 原型时期已在 JSON Settings 增加 `uiStyle`。Rust serde 及浏览器只读兼容层对缺失字段默认 `paper`，读取旧记录不重写任务/计划，下一次合法写入随事务保存新字段。非法风格值拒绝保存。任务与计划数据不随外观变更，窗口协调器只在几何/显隐相关设置改变时重新定位和显示，不因外观或排序变化隐藏、重新弹出窗口。外观字段兼容与数据库版本迁移是独立机制。

## schema 3 实际兼容与生命周期契约

本节保留生命周期阶段引入的规则和迁移历史；当前数据库已升为 schema 5，新增设备元数据边界见末节，下面的 Task / Plan 规则继续适用。

当前 Task 用 `completed`/`completedAt` 和 `dueDate`/`dueTime` 表示完成与 DDL；新截止日期可带 `dueTimezone`，精确时刻带 `dueAtUtc`。旧记录缺时区字段时保留原截止语义，普通标题/备注编辑不能重新固定时区。新增 `deletedAt` 对应 Rust `deleted_at: Option<String>`，serde default/skip_none，旧记录缺失或 null 均为未删除；非空值必须通过既有严格 UTC RFC3339 校验。该字段只能由生命周期动作修改，普通字段编辑不能注入它。

`trashTask {id, expectedRevision}` / `restoreTask {id, expectedRevision}` 通过原有 mutate 入口提交，外层另携带 Snapshot expectedRevision。先校验版本，再判断是否已达目标状态；同状态不重写删除时间或 Task revision，全局 revision 沿用现有提交递增规则。真正删除/恢复只改 deletedAt 与 Task revision；写入失败不发布新快照。删除状态下拒绝 updateTask、setCompleted 和 planTask 的加入/移出两种方向。

reorderToday 的精确集合只包括当天未删除、未完成任务；已删除及已完成计划的排序值不参与重排。追加今日计划仅稳定压缩当日未删除任务的计划，保留删除项原值。恢复不调整任何 Plan；排序值相同时沿用 Plan 数组的稳定顺序，因此其他任务重排后不保证恢复到删除前的绝对行号。跨日按原计划重新投影，不创建今天的新引用。

生命周期阶段的 SQLite schema1/2→3 先对完整数据库做保留 WAL 的副本预检，再创建校验可读、已同步的一致性 `before-schema-3` 备份；迁移事务只更新版本/身份标记，保留 snapshot 与 placement 原字节，不重编码任务。当时识别 schema1/2/3，候选保留 `before-schema-2`、`before-schema-3` 与 `safety-backup`。后续 schema 4 与当前 schema 5 的版本及备份规则见末节。迁移失败不以空库或演示数据替代，首次新库仍写入空快照。

便携 JSON 的 schemaVersion 与 SQLite 版本独立：新导出 v2，导入接受 v1/v2，均包含完整 tasks/plans；v1 缺失或 null 的 deletedAt 作为未删除，v1 携带非空删除状态则拒绝。预览提供 taskCount、trashedTaskCount、planCount 和 exportedAt。整份恢复先备份当前库，再替换任务及回收站、保留设备设置，并将全局及所有导入任务 revision 提高到已见值以上；当前没有 dataset_epoch 字段。旧备份按备份时的完整集合恢复，不与现有回收站合并。回收站仍计入现有容量限制，元数据增长超限时保持原已提交状态并提示失败。

本节任务规则在 schema 5 继续有效，不将自动化测试、文档同步或 Mac 证据写成双平台验收完成。来源与分阶段检查见 [TASK_LIFECYCLE](../research/TASK_LIFECYCLE.md)，当前验证范围与原始执行证据见内部验收记录（本地保留，未随公开仓库分发）。

## 展开模式偏好（2026-09-25）

Settings新增 `revealMode`（Rust `reveal_mode`），只接受 `click` / `hover`；新建与旧记录缺失时均默认 `click`。旧 `revealDelay` / `hideDelay` 保留读取和校验，悬停模式继续采用已保存值且仅该模式显示延迟设置。只读补默认不重写旧原文，下一次合法事务保存新字段；模式更新不改Task/Plan、几何或其他偏好。当前采用下述 schema5 兼容边界，便携任务备份v2不带设备偏好。Windows旧分支曾在schema4只读补默认，其原生/安装证据仍按旧SHA保留，不能据此省略整合版升级与降级拒绝验收。

## 分区偏好的当前扩展

Settings新增panelSplit（Rust panel_split:u8），缺省54，只接受30–70整数；属于本机偏好，便携任务备份不携带，整份任务恢复保留本机值。比例修改沿用统一设置事务，不改Task/Plan字段；同一设置冲突由版本及前端的初始比例核对处理。旧快照缺字段只读补默认，不重编码原文；正常提交后保存。分区比例单独落地时保持schema3，与uiStyle一样只支持新程序读旧库；旧schema3程序可能因未知设置字段拒绝读取。当时控制台placement扩展采用下述schema4备份迁移，当前由schema5继承，不支持降级继续编辑。分阶段记录见[窗口偏好计划](../research/WINDOW_PREFERENCES.md)。

## schema 4 控制台设备元数据契约

schema 4 阶段的 `PRAGMA user_version=4`，仍只有 `app_state` 的 snapshot / placement 记录，不添加 Task 字段、独立偏好 revision 或第二份存储。读取识别 schema 1 / 2 / 3 / 4；旧版本在保持原主库及日志不变的完整副本上通过预检后，先创建经过校验和同步的 `sidetask-before-schema-4-<UUID>.sqlite3`，再事务升到 4。schema 1 同时设置既有 application_id，schema 2 / 3 只更新版本。迁移保留 snapshot / placement 原文，备份内版本仍为迁移前版本；失败回滚并保留安全副本。schema 4 让旧程序明确拒绝继续写库，避免旧 placement 写法丢弃 console 子对象。

placement 中的 console 可缺省，结构由 `ConsolePlacement` / `ConsoleNormal` 表达：

| JSON 字段 | 当前含义 |
| --- | --- |
| console.normal.innerWidth / innerHeight | Tauri内容区逻辑宽高，有限正数；Mac默认全尺寸内容可与标题区域重叠，标题可达高度独立实测 |
| console.normal.monitorName | 可空的显示器名称；匹配失败回退有效屏幕 |
| console.normal.monitorPosition | 可空原生原点 `{x,y}`，只作同名显示器匹配提示；不是工作区偏移 |
| console.normal.outerOffsetX / outerOffsetY | 相对工作区的逻辑外框偏移，有限数，可为负以表达跨屏 |
| console.maximized | 最大化偏好；正常矩形单独保留，不用最大化尺寸覆盖 |

Mac 先把窗口和各工作区按各自来源 scale 转到统一 AppKit 逻辑平面，计算时 scale 为 1；Windows 在物理桌面坐标中计算，持久化与恢复时转换逻辑尺寸/偏移。原点和单位的转换只在平台层进行；不保存隐藏、焦点、最小化或全屏状态。无效 console 子对象作为独立位置错误处理，不丢弃可读取的小窗字段；不可解析的整个 placement 仍不能被合并写入静默覆盖。

设备元数据写入在同一个 SQLite 库内各自读取最新 placement：

| Repository 方法 | 同一 IMMEDIATE 事务内的行为 | 版本边界 |
| --- | --- | --- |
| acknowledge_usage_guide() | usageGuideSeen缺省false；只置true，已true不重复写；保留所有其他元数据，非法类型/存储失败返回错误 | 不读写snapshot，不改revision或任务比较基线；沿用schema4 |
| save_console_placement(console_json) | 校验对象和大小，只替换 console；保留 edge 及其他字段值 | 不读取/重编码 snapshot，不改 Snapshot / Task revision，也不推进任务比较基线 |
| save_placement(snapshot, edge_json) | 按既有任务比较基线验证并保存 snapshot，再只合并 monitorName / monitorPosition / offset；保留 console 和未提供字段 | 保留原任务保存协议，元数据错误使 snapshot 与 placement 一起回滚 |

输入、已存 placement 与合并结果均限 64 KiB，且须为 JSON 对象。数据库层不依赖平台几何类型；平台负责 console 字段和坐标语义。合并会重新编码 placement，因此承诺字段值互保；只有升级事务及 console-only 写入的 snapshot 承诺原文保持。两连接依次写入时仍合并最新元数据，控制台写入不能使过期任务基线变成有效。

位置候选/恢复错误/忽略状态只在 ConsoleRuntime 内，不加入任务草稿或 portable JSON。恢复失败阻止自动采样覆盖旧保存值；显式重试保存当前位置，丢弃先采样当前值后取消这次保存。便携任务格式继续为 v2，读取 v1/v2，任务恢复保留 Settings 与全部 placement；完整 SQLite 恢复包含备份时设备配置。启动候选扩展为 before-schema-2 / before-schema-3 / before-schema-4 / safety-backup。

实现决策及固定许可参考见 [ADR-0006](../decisions/0006-console-window-preferences.md)。本阶段Mac已开始单屏原生复验，Windows由另一开发机负责；当前平台验证范围见内部验证记录（本地保留，不随公开仓库分发）。合成数据、几何与状态测试不能替代多屏窗口或断电恢复证据。

## 首次使用说明状态

`placement.usageGuideSeen` 为可缺省boolean，缺失视为false；不放在Settings、console子对象或Task内。`get_usage_guide_seen` / `acknowledge_usage_guide`仅控制台有权限；确认调用完成后才隐藏提示。读取失败显示重试，不把坏元数据当默认值覆盖。没有任务、已有任务、仅回收站均使用同一标记，不导入示例数据。

确认事务与控制台、边缘位置事务合并最新字段；不发布任务变更事件，不中断尺寸设置会话或编辑草稿。便携JSON导出不包含标记，任务恢复保留它；整库备份包含当时标记，整库恢复到未确认版本后可再次显示。浏览器预览使用独立`sidetask-usage-guide-seen-v1`键，不能用预览localStorage证明原生SQLite写入。

## schema 5 小窗展开方式契约

当前 `PRAGMA user_version=5`。Settings新增 `revealMode: "click" | "hover"`（Rust reveal_mode:String）；新建和旧快照缺字段均默认click，非法字符串/null/数值拒绝。保留revealDelay/hideDelay，切模式不清它们。模式属于本机设置；便携备份仍v2，不携带或覆盖本机Settings。

schema1–4预检通过后先生成校验并同步的 `sidetask-before-schema-5-<UUID>.sqlite3`，再IMMEDIATE事务升级marker；snapshot/placement原文字节不重编码，备份保留旧版本。只读补默认不写入，下一次成功业务提交才按新格式写完整snapshot。备份失败或迁移失败不修改旧内容/版本；schema1沿用设置application_id。旧程序拒绝schema5，不手工改版本降级。恢复候选支持before-schema-2/3/4/5和safety-backup。历史schema4段保留其引入的设备字段/合并规则。
