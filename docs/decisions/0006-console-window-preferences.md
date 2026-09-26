# ADR-0006：控制台几何偏好与设备元数据合并

日期：2026-09-25。状态：已采用并接入实现。接续 [ADR-0005](0005-task-lifecycle-and-backup-schema.md)，当前自动化、构建和平台验证范围见内部验证记录（本地保留，不随公开仓库分发）。

## 背景

控制台原先每次启动采用固定尺寸和居中位置。将它的位置直接追加到原小窗 Placement 并整份保存，会让小窗持有的旧对象覆盖控制台偏好；沿用任务保存入口还会在每次移动后重新编码完整任务快照。此次采用独立运行态和同库字段合并，延续单一任务服务，不增加窗口状态文件或插件。

## 决定

1. SQLite 升为 schema 4，仍保留 `app_state` 的 `snapshot` / `placement` 两个 key。旧 schema 1 / 2 / 3 在主库及 WAL / SHM / journal 的完整检查副本中验证，通过后先创建、校验并同步 `before-schema-4` 一致性备份，再事务更新版本；schema 1 同时补既有应用身份。迁移不重编码原 snapshot / placement，不生成任务或清空数据。原有 `before-schema-2` / `before-schema-3` / `safety-backup` 恢复候选继续识别，新增 `before-schema-4`。
2. `placement.console` 仅保存本机控制台偏好。`Repository::save_console_placement` 在 IMMEDIATE 事务中读取最新 placement 对象，只替换 console 子对象；不读取、校验或改写任务快照，不推进任务 revision 或 Repository 的任务比较基线。原有 `save_placement(snapshot, edge_json)` 只从输入合并 `monitorName`、`monitorPosition`、`offset` 三个小窗字段，并与该次 snapshot 保存原子提交。双方保留另一方和未修改字段的值；元数据写入可重新编码 placement，不能据此要求它始终保持原文本格式。
3. 新元数据、已有 placement 与合并结果均受对象类型和 64 KiB 大小限制；平台几何类型负责字段及数值校验。合并或写入失败回滚整个对应事务。schema 4 构成旧程序的明确读取边界，避免旧 schema 3 程序整份写入 placement 丢掉 console；不支持手工降版本后继续编辑。
4. 控制台保存普通窗口的逻辑客户区尺寸、相对工作区的逻辑外框偏移、显示器名称/原生原点匹配提示，以及单独的 `maximized` 偏好。最大化时保留普通矩形，最小化和全屏临时矩形不用于覆盖它；不持久化隐藏或焦点。Mac 适配层将窗口与各显示器按各自来源 scale 转到统一 AppKit 逻辑平面，使用逻辑位置/尺寸调用；Windows 使用物理桌面像素计算，再按当前屏幕 scale 解释持久化逻辑值。原生显示器原点只作身份提示，不与 Mac 逻辑工作区混算。
5. 普通控制台隐藏创建，应用客户区尺寸与外框位置，重读确认普通几何，再请求并确认可选最大化；随后由明确启动意图显示、聚焦。失败仍显示窗口及位置错误，保留原保存记录。后续打开、移动/缩放稳定后与低频检查重新评估可达性；有效跨屏位置保留，丢失屏幕或不可达标题栏时校准，极小工作区优先可操作尺寸。过期代次不应用旧几何；纯校准不主动聚焦。
6. `ConsoleRuntime` 的候选、错误、忽略位置与恢复确认状态独立于任务/设置草稿。原生事件回调只记录变化或排队，工作线程在不持 service / dock 锁时采样、应用窗口。稳定移动合并保存；隐藏与已确认退出补一次采样/保存。位置失败显示“重试保存位置”与“不保存本次位置”：前者保存当前可用位置，不移回旧目标；后者先采集当前值再忽略它，后续位置变化仍可保存。部分恢复或最大化失败会阻止自动观察结果覆盖旧偏好。
7. 退出先验证请求代次，在不持业务锁时等待位置 flush，再按 dock → service → exit 顺序复核并批准。位置保存错误如实返回并记录，但不阻止用户已经完成草稿确认的退出；任务草稿保存失败仍遵循既有退出保护。控制台位置状态使用独立查询/事件，不广播任务变更。

便携任务 JSON 仍为 v2，继续读 v1 / v2；本轮不改变回收站、全部计划或 revision 提升规则。任务备份不导出 console / edge 等设备信息，正常整份任务恢复保留它们；完整 SQLite 恢复则包含备份时的设备信息。详见 [数据模型](../engineering/DATA_MODEL.md) 与 [恢复说明](../engineering/DATA_RECOVERY.md)。

## 一手参考与取舍

| 固定来源 | 采用与许可 |
| --- | --- |
| Tauri window-state 2.4.1，[实现 e7a68fa63755603b9fa12d28e077eea645551d24](https://github.com/tauri-apps/plugins-workspace/blob/e7a68fa63755603b9fa12d28e077eea645551d24/plugins/window-state/src/lib.rs) | 参考普通矩形与最大化状态分离；默认显隐/聚焦与独立文件保存不满足本项目边界，未安装插件。Apache-2.0 OR MIT，许可核对见 [WINDOW_PREFERENCES](../research/WINDOW_PREFERENCES.md#一手参考与复用判断)。 |
| Tauri 2.11.6，[Window / Monitor 9452ddee5ebefd9b678a94ff003521379df6c9ae](https://github.com/tauri-apps/tauri/blob/9452ddee5ebefd9b678a94ff003521379df6c9ae/crates/tauri/src/window/mod.rs) | 使用已有工作区、scale、客户区/外框与窗口调用接口，区分 inner / outer；Apache-2.0 OR MIT。平台适配由本项目实现。 |
| rusqlite 0.37.0，[transaction.rs 44e0ef965580b94d59c5dfe8874b57ab5993a8f7](https://github.com/rusqlite/rusqlite/blob/44e0ef965580b94d59c5dfe8874b57ab5993a8f7/src/transaction.rs)、[MIT LICENSE](https://github.com/rusqlite/rusqlite/blob/44e0ef965580b94d59c5dfe8874b57ab5993a8f7/LICENSE) | 核对 IMMEDIATE 事务及未提交回滚语义；延续现有 SQLite 备份流程。没有复制参考代码或新增依赖。 |

## 验收与限制

合成测试覆盖旧库迁移/回滚、原 JSON 保留、两连接交错字段合并、元数据写失败和任务版本隔离；纯几何与状态测试覆盖恢复边界，浏览器测试覆盖状态反馈。当前验证状态见内部验证记录（本地保留，不随公开仓库分发），纯状态测试不称为原生故障注入。

此 ADR 记录窗口几何恢复、失败反馈与偏好持久化的实现决策。

## Mac真机补充（2026-09-25，mac分支）

基线e844fcd实机启动暴露了outer==inner、top_inset==0时永久拒绝正常控制台的问题。锁定[tauri-runtime-wry2.11.4实现](https://github.com/tauri-apps/tauri/blob/ca90b46b2e2cbbc981dae1b809f4af4343fe0558/crates/tauri-runtime-wry/src/lib.rs#L1200-L1206)对默认Visible标题栏启用fullsize_content_view，因此内容区可以包含标题区域，不能要求标题高度小于外内高度差。

Mac现由AppKit `contentLayoutRect`获取真实标题区域，同一主线程采样窗口外框、内容尺寸、scale和layout；工作线程等待有2秒上限，超时晚到操作仅只读，不持业务/dock锁。几何算法独立处理标题可达区域与边框厚度，不猜固定高度，不改变标题栏风格。直接声明原锁文件中已存在的objc2-foundation0.3.2，以绑定NSRect避免手写结构体ABI；固定commit `7b1abfd750a2cacaea71d6a56ecfb83cb7de560b`，[geometry类型](https://github.com/madsmtm/objc2/blob/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b/framework-crates/objc2-foundation/src/geometry.rs)、[MIT许可](https://github.com/madsmtm/objc2/blob/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b/LICENSE.md)。未复制上游代码或升级依赖版本。

同阶段首次说明使用placement根级usageGuideSeen字段，确认只置true，与console/edge互保，不重编码任务快照或提高revision。schema4和便携v2不变；缺省false、非法类型拒绝。具体执行证据与当前平台范围见内部验收记录（本地保留，未随公开仓库分发）。前文锁屏为当时限制，不覆盖这次真机结果。
