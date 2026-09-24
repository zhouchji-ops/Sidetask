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

IPC模拟测试验证前端协议与失败流程，不验证Tauri ACL、系统焦点或SQLite。Mac隔离验证使用独立identifier和合成数据；Windows、多屏/混合DPI/热插拔/睡眠与长期资源验收另列路线门槛。最终集成命令和数字见STATUS，不将中途构建/测试结果混作最终结果。
