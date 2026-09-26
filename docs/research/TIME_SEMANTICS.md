# B08 时间语义、输入校验与阶段复盘

日期：2026-09-25。仅使用合成任务测试，没有读取或修改个人任务数据库。实现位置为 `apps/desktop/src/lib/deadline.ts`、`domain.ts` 与 `src-tauri/src/domain/`。本记录不代替双平台运行和窗口验收。

## 本阶段发现与修复

原型以当前系统本地时区解释全部 DDL；精确时间随系统时区变化，JavaScript `Date` 在 DST 空缺/重叠时会自动选择或移动时刻。浏览器适配器还缺少完整的备注长度、优先级、计划日期、未知字段、非有限数值、布尔类型、数据关系和安全 revision 校验。

本轮新增固定时区/UTC 语义；持久化与导入共用严格只读校验，错误返回给调用方而不改写原数据。此前未完成视图按每个任务的最近计划日判断，排除已完成、已有今日或未来计划的任务，历史引用不会被清除。重复完成保持原完成时间与任务 revision。排序比较真正的创建瞬间，兼容 Rust `+00:00` 和浏览器 `Z` 两种 UTC 写法并保留纳秒先后关系。

## 当前实现契约

| 情况 | 保存与判断 |
| --- | --- |
| 无 DDL | `dueDate`/`dueTime` 为 null，新增时区/瞬间字段为空或不存在 |
| 新建仅日期 DDL | 保存 `dueDate` 与 IANA `dueTimezone`；`dueAtUtc` 为空；到来源时区下一日第一个有效瞬间逾期 |
| 新建精确 DDL | 保留输入的 `dueDate`/`dueTime` 供编辑，保存 `dueTimezone` 与 Rust 推导的 `dueAtUtc`；逾期、排序以 UTC 瞬间为准 |
| 修改 DDL | 日期、时刻或时区的实际值变化时重新解析；已有固定时区默认保留，旧数据首次修改 DDL 时采用当前时区 |
| 普通编辑、完成、计划与换肤 | 不重新解释 DDL，不因传入相同日期/时刻而固定旧数据 |
| 旧 snapshot | 缺失新增字段仍可读，保留浮动本地时间语义；不猜测原始时区、不在读库或迁移时批量改变 DDL |
| DST 不存在/重复时刻 | 新输入拒绝保存并说明原因；当前没有选择第一次/第二次偏移的控件，用户需改选有效时刻 |
| DST 午夜跳跃 | 仅日期边界取下一日第一个有效瞬间；午夜重复取最早瞬间，不按 24 小时累加 |
| 完全跳过的日期 | 拒绝把不存在的日期作为新 DDL；前一日的结束边界仍能正确越过跳日 |

精确 DDL 的 `dueAtUtc` 是已提交的权威值，`dueDate`/`dueTime` 是当时的输入记录。读取或恢复不会用新版本时区规则重算 UTC，否则政府修改未来时区规则时会悄悄移动用户已经确认的截止瞬间。这是现有 JSON snapshot 的兼容实现，与 DATA_MODEL 中规范化目标表应区别描述。

新建/更新命令不能直接写 `dueAtUtc`；该字段由领域层推导。导入的权威 UTC 字段需符合格式与字段组合约束；不会以当前 tzdb 对历史输入字段再做等价重算。

日期范围为 `0001-01-01` 至 `9999-12-31`，严格 `YYYY-MM-DD`；时刻为 `HH:mm`。UTC 记录只接受有效日期、`T`、00–59 秒、最多 9 位小数及 `Z`/`+00:00`，拒绝闰秒和超精度后静默截断。任务 ID、重复关系、完成状态、设置枚举、延迟/尺寸、安全整数范围均验证。任务 revision 不能超过 snapshot revision；到 JavaScript 最大安全整数时拒绝继续写入。

`Snapshot::empty()` 与 `Snapshot::validate()` 供原生存储、迁移、导入调用；校验不修改输入。`normalizePreviewSnapshot()` 只为旧设置补 `uiStyle=paper`，不为任务补猜测的时区。未知 snapshot/任务/计划/设置字段拒绝读取，避免旧应用静默丢弃新格式内容。

## UI 与 Store 接续接口

- `currentTimeZone()` 每次查询当前系统 IANA 时区，不长期缓存。
- `deadlineTimeZoneHint(task)` 提供固定时区或旧 DDL 尚未固定的提示。
- `formatDue()` 对仅日期 DDL 使用来源时区的日历日；精确 DDL 转为当前显示时区；跨时区时附来源时区。跨年份日期包含年份。
- `nextTimeBoundary(tasks, now)` 返回下一个当前/相关来源时区午夜或未完成 DDL 瞬间。它不写数据库或增加 revision；Store 负责重排计时器，以及显示、睡眠恢复、系统时间/时区变化后的刷新。
- `selectEarlierIncomplete(snapshot, today)` 按最近计划日去重查询；移出今日后仍有历史计划的未完成任务可以重新出现。
- `createEmptySnapshot()` 为浏览器空白首次使用入口；示例数据仅由显式演示入口创建。

原生计时/重现、精确时刻持续可见刷新、跨时区文案在四种风格与最小小窗中的布局，由主任务完成集成验收。本阶段没有单独将 T08/T09/C13 或 B08 标为 Done。

## GitHub 一手参考及许可

没有复制第三方业务代码；通过包管理器安装正式依赖并调用公开 API。源码引用固定至发布版本 commit，包完整性分别由 npm/Cargo 锁文件记录。

| 来源 | 固定版本 / commit | 采用与许可 |
| --- | --- | --- |
| [js-temporal/temporal-polyfill 类型和解析选项](https://github.com/js-temporal/temporal-polyfill/blob/f3c07e503632ddf7ff918066f2eb30a9dcfa06ff/index.d.ts) | `@js-temporal/polyfill=0.5.1` / `f3c07e503632ddf7ff918066f2eb30a9dcfa06ff` | 使用 PlainDate 日历运算、ZonedDateTime 的 `disambiguation: reject`、Instant 精确比较；ISC |
| [Chrono-TZ 时区解析与 GapInfo](https://github.com/chronotope/chrono-tz/blob/e15d1f308a1ac2fdf3f1bf19c325dc202d418081/chrono-tz/src/timezone_impl.rs) | `chrono-tz=0.10.4` / `e15d1f308a1ac2fdf3f1bf19c325dc202d418081` | 区分 Single/Ambiguous/None，处理无午夜的日历边界；MIT OR Apache-2.0，tzdb 数据为公有领域 |
| [iana-time-zone 系统时区库](https://github.com/strawlab/iana-time-zone/tree/3726968181ae67d95c8de2f750a95b9c703ae4c8) | `iana-time-zone=0.1.65` / `3726968181ae67d95c8de2f750a95b9c703ae4c8` | 原生命令未传来源时区时读取系统 IANA 名称；MIT OR Apache-2.0，本包附 MIT 许可文本 |
| [JSBI](https://github.com/GoogleChromeLabs/jsbi/tree/5382367c7e3199858d36bb620977e1f90605bcb9) | `jsbi=4.3.2` / `5382367c7e3199858d36bb620977e1f90605bcb9` | Temporal 的传递依赖；Apache-2.0 |

发布包资源 `apps/desktop/public/third-party/time-dependencies.txt` 保留上述许可，并包含新增 Rust 传递依赖 phf/phf_shared 0.12.1 的许可。它只覆盖本阶段新增时间依赖，完整项目依赖声明仍由发布工作包统一维护。

## 验证记录

- `npm test`：最终 61/61 业务测试；原型原有 26 项保留。
- `TZ=America/New_York npm test`、`TZ=Pacific/Kiritimati npm test`：最终新增纳秒/未来计划回归前，均 59/59；验证与运行主机不同时区的日历和 DST 行为。
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml domain::`：14/14 领域测试，无失败。
- `npx tsc -b`：通过。
- npm 安装后即时 audit：105 个包、0 个报告项；这不是应用没有漏洞的证明。

有意义的新增用例包括纽约春季不存在时刻/秋季重复时刻、23/25 小时日期、巴西无午夜、萨摩亚跳过日期、固定上海 UTC、跨时区“今天”显示、旧数据普通编辑不升级、清空 DDL 清理元数据、伪造字段/ID/引用/完成记录、revision 溢出、日期与 UTC 严格格式、纳秒创建排序、亚毫秒截止不提前、未来计划与系统日期回调。

## 阶段复盘与剩余限制

1. 自动化覆盖核心时间转换和输入校验；环境变量时区测试使用指定进程时区。
2. 历史 DDL 无法凭空恢复创建时区，当前明确保留旧语义并提示。未修改 DDL 的旧任务仍会随系统时区解释；要固定它必须有明确日期/时刻/时区编辑。
3. 原生 Chrono-TZ 0.10.4 内置 tzdb `2025b`；本机 Node 24.14.1/ICU 78.2 使用 `2025c`，实际 WebView 还依赖 OS。新时区规则更新可能造成跨引擎差异；已保存的精确 UTC 不重算。发布维护需要更新时区依赖并复验受影响区域，未来可由原生服务向界面统一提供日期边界。
4. 新 DDL 使用系统时区；歧义或不存在的当地时刻会提示选择其他有效时刻。DDL 用于截止信息展示与排序。
5. 本轮没有改动或验证个人数据库，也未提交/推送 Git。总状态、DATA_MODEL 实现说明、路线和安装包证据由主任务同步。
