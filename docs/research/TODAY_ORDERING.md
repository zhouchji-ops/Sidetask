# 今日计划整理：实现与参考

日期：2026-09-25。范围：R06 今日手动排序与直接移出，按用户“功能完整和使用体验优先”的最新方向推进。软删除、全局快捷键和拖拽排序不在此工作包内。

## 规则

新增动作 `reorderToday { date, taskIds }`，通过现有 `mutate` 和快照 `expectedRevision` 提交。`date` 严格使用 YYYY-MM-DD；`taskIds` 必须精确包含该日已经安排且当前未完成的任务，不能缺失、重复或混入已完成、未安排、未知任务。

只给这些 DailyPlan 按传入次序写入 `sortOrder = 0..n-1`；Task 的标题、备注、DDL、完成状态和修订号均保持，其他日期与已完成任务的计划记录完整保留。原计划数组不重排、不移除，只变更相应顺序值。快照修订号在事务提交后正常推进。完成、加入、移出和排序发生交错时，旧快照提交失败并由现有 store 刷新，不能静默覆盖。

原生命令仍由控制台整理完整顺序；小窗共享顺序，并通过既有 `planTask` 直接移出。搜索过滤时不允许整理局部结果。UI 首轮采用上移/下移和移出，保留键盘可操作性；不要求拖拽才能调整清单。

## 原生复验修复：重新加入必须位于末尾

300 项原生演练发现：移出留有顺序空洞后，原先用全部计划数量生成 `sortOrder` 会与已有值相同，重新加入不能可靠落到末尾；历史日期的计划数量也会影响新顺序。`createTask(addToToday=true)` 使用同一错误生成方式。

Rust `append_plan` 与浏览器预览 `appendPlan` 现在共用同一规则：**每次真正增加一个某日计划时**，稳定地按该日已有 `sortOrder` 排序，将该日编号整理为 `0..n-1`，新计划放在 `n`。正常值、空洞、重复值、接近/等于 JavaScript 最大安全整数都采用这条规则，不计算可能越界的最大值加一；相同值维持此前显示的相对顺序。

只改目标日期的顺序字段，不重排原计划数组、不改任务主记录、DDL、完成状态或其他日期的计划。已完成计划也保留相对顺序、只在这次追加规范化中更新编号；`reorderToday` 自身原有的“已完成计划字段不改”契约仍保持。重复加入已存在的同日计划不触发规范化，移出仍只删除同日引用。没有 schema 变更或自动启动清洗；历史重复值在下次相应日期追加时整理。

新增对等回归：Rust 2 项测试覆盖“重排→移出→再加入”及新建/已有任务各自的空洞、同值、最大安全值场景；浏览器 4 项同类回归同时确认其他日期、旧 Task 记录和原快照不变，第二次加入不再变计划。固定版本 Super Productivity 的稳定相对顺序工具与 MIT 许可已在本次修复再次阅读，仅参考行为，不复制实现。

## GitHub 参考与许可

核对 Super Productivity v19.1.0，固定 commit `42ded9f31a132bf92633b0c78ad4ebf1d87c0f71`。其[今日任务上下移动回归](https://github.com/super-productivity/super-productivity/blob/42ded9f31a132bf92633b0c78ad4ebf1d87c0f71/src/app/root-store/meta/task-shared-meta-reducers/section-reorder.regression.spec.ts)检查顺序变化同步与无关列表保持；[移出今日的稳定顺序工具](https://github.com/super-productivity/super-productivity/blob/42ded9f31a132bf92633b0c78ad4ebf1d87c0f71/src/app/features/tasks/util/move-valid-ids-to-front.ts)体现列表操作后保留相关顺序的行为目的。上游[顺序被翻转的问题反馈](https://github.com/super-productivity/super-productivity/issues/4392)也说明手工安排次序被自动改变会直接影响使用。

[固定版本 LICENSE](https://github.com/super-productivity/super-productivity/blob/42ded9f31a132bf92633b0c78ad4ebf1d87c0f71/LICENSE)已核对为 MIT。仅参考交互与回归检查范围，没有复制其代码，也没有引入其项目、子任务、分区或跨设备同步模型。

## 验证

新增 5 项 Rust 回归：重排保留任务、多个已完成计划和其他日期；拒绝错误 ID 集合与非法日期；完成/排序双向交错拒绝旧快照；空/单项日期；存储失败时不发布新顺序或修订号。定向测试 5/5，全库 `cargo test --lib --locked` 72/72，`cargo clippy --all-targets --locked -- -D warnings`、`cargo fmt --check` 与 `git diff --check` 通过。UI 接线、浏览器对等实现与实际按钮操作由对应工作包验证，不能由这组领域测试推断原生 UI 已通过。

追加顺序缺陷修复后：`npm test` **74/74**，Rust `cargo test --locked` **74/74**（1.57 秒）；`npx tsc -b`、`cargo clippy --all-targets --locked -- -D warnings`、`cargo fmt --check`、相关文件 `git diff --check` 全通过。这里只报告领域/编译检查，300 项原生重排/移出/重新加入的修复后复验由主工作包记录。
