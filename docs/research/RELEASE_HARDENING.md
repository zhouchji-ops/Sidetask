# 发布准备阶段复查

日期：2026-09-25。范围：本地SideTask仓库与其已声明的Mac/Windows桌面目标。三个独立工作包均使用GPT-6 Astra / xhigh；根任务负责前端与集成验收。没有复制第三方项目源码。

## 阶段一：风险与规则

从README、STATUS、HANDOFF、BACKLOG核对实际代码，优先处理首次demo、缺快照误初始化、IPC跨窗口权限、退出草稿、日期边界。独立分析见 [STORAGE_HARDENING](STORAGE_HARDENING.md)、[TIME_SEMANTICS](TIME_SEMANTICS.md)、[NATIVE_SECURITY_REVIEW](NATIVE_SECURITY_REVIEW.md)。

## 阶段二：前端复盘与修复

- 新任务草稿原先不参与未保存保护；已统一登记任务详情、新任务、设置，退出可逐项保存/放弃/取消，错误保留输入。
- 多层弹窗共用标题ID，Escape闭包可能调用过期关闭逻辑；改为独立ID、最新回调和最上层处理，内层取消不关闭底层新任务。
- 保存等待期间继续输入会被异步成功回调清掉；独立review复现后改为保存中冻结表单与离开操作，并以延迟IPC回归验证。
- 同一设置在另一窗口修改时旧草稿可能静默覆盖；现在比较已编辑字段的基线，冲突须明确确认后才可保存。
- 所有新恢复操作统一走store在途写锁；预览携带revision，数据有变须重新预览。大小和格式限制前后端同时校验。
- 状态栏区分草稿、保存中和失败；设置区另显示系统应用状态与重试。
- 日期显示按下一截止/固定时区午夜边界刷新；每秒只检查时钟，边界/时钟跳变时才重绘，不改变持久化数据。

## GitHub参考与CI取舍

阅读 [tauri-action官方README固定提交](https://github.com/tauri-apps/tauri-action/blob/a6e90ddc4ba4721f294e52b856d3d50e645edc07/README.md) 与 [Tauri Windows安装文档](https://v2.tauri.app/distribute/windows-installer/)，核对跨平台矩阵与NSIS产物模式；仓库许可MIT，未复制其发布脚本。采用本项目自有CLI工作流，CI只生成内部试用artifact，不创建GitHub Release。

CI补前端业务/类型/生产构建/Playwright、Rust格式/clippy/测试、Mac app及Windows NSIS、失败截图和14天试用产物。外部Actions固定完整commit，checkout不持久化凭据，默认token只读。Rust1.98.1/Node24.14.1与锁文件可追溯；执行证据与配置存在分开。

## 依赖审计

`npm audit --json`：0条已知漏洞。`cargo-audit 0.22.2`全锁文件：489依赖，漏洞列表0，另有7条informational warning。RustSec数据库commit `593df8c1b5ed0bcde9dddadfeeead776fa514ff8`，更新于2026-09-24。

`glib 0.18.5`安全性警告和`proc-macro-error 1.0.4`停维护警告仅见Linux/BSD依赖链，不在本次Mac/Windows目标图内；仍保留全锁记录。5个`unic-*`停维护依赖通过urlpattern/tauri-utils进入两目标，需随上游升级处理。不能把audit退出码0解释为没有警告，更不能据此保证零漏洞。目标图与官方源码证据见原生安全记录。

## 验证边界

IPC模拟测试验证前端协议与失败流程，不验证Tauri ACL、系统焦点或SQLite。Mac隔离验证使用独立identifier和合成数据；检查结论按平台、屏幕环境与用例范围记录。当前集成结果见内部验证记录（本地保留，不随公开仓库分发），不将中途构建/测试结果混作最终结果。

## 推送后交叉复审

main基线2b04c6f已按用户明确授权推送。独立复审发现新增macOS专属依赖段误把chrono-tz/iana-time-zone包含其中；已移回通用依赖，以cargo tree --target x86_64-pc-windows-msvc --depth 1确认Windows可达，随后实际CI已完成两平台编译/测试。此错误说明单平台clippy/test不能替代双平台构建。

48e5d4f的[实际CI](https://github.com/changjin-cpu/SideTask/actions/runs/36034926452)两平台测试和App/NSIS均已通过；最终失败发生在artifact上传，账户存储quota已满。仓库artifact查询为0，不删除其他项目数据或改变账户计费。工作流保留上传失败，并在上传前输出包大小/SHA-256，明确“已构建”与“可下载”区别。

CI日志另提示旧Actions Node20运行时已弃用。已查[checkout v7.0.1](https://github.com/actions/checkout/blob/3d3c42e5aac5ba805825da76410c181273ba90b1/README.md)、[setup-node v7.0.0](https://github.com/actions/setup-node/blob/820762786026740c76f36085b0efc47a31fe5020/README.md)与[upload-artifact v7.0.1](https://github.com/actions/upload-artifact/blob/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/README.md)，固定相应commit并保持现有输入/只读权限与不留凭据。MIT许可，仅调用官方Action，不复制源码；采用Node24支持版本，产物上传受账户配额控制。

用户随后将功能完整与体验列为首要目标。必要的启动日志丢失修复与Mac恢复演练闭合后，转入列表性能、全局搜索和今日整理，不继续扩大安全加固范围。实际启动恢复初始失败及修复证据见内部验收记录（本地保留，未随公开仓库分发）。
