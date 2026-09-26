# 历史清理后的开发机接续

2026-09-26，公开仓库移除了内部协作说明、交接与迁移文档、手工验收记录和聊天溯源资料，并清理这些文件的提交历史及普通联系邮箱。提交号发生变化；默认开发入口仍为 `origin/mac`。

## 保留旧目录，克隆到新目录

**先保留原开发目录和本地文件，再接续。** 不要在旧目录直接拉取合并、执行硬重置或清理未跟踪文件。普通 Git 更新可能删除原来受跟踪的文档；新仓库无法替你保存另一台机器的本地资料。

1. 在旧目录查看 `git status`，记录未提交修改、未跟踪文件和未推送工作。保留整个旧目录作为本地备份，不把它推送到公开仓库。
2. 在另一个目录克隆新历史：

   ```sh
   git clone --branch mac https://github.com/zhouchji-ops/Sidetask.git SideTask-clean
   cd SideTask-clean
   git rev-parse HEAD
   ```

3. 如需继续使用内部资料，从旧目录复制本机的 `AGENTS.md`、`docs/delivery/`、`tests/manual/` 和 `docs/product/SELLING_POINTS.md` 到新目录。这些路径已加入忽略规则，本地可以保留；不要用 `git add -f` 重新提交。
4. 有未交接的功能修改时，逐项比较旧文件并迁移代码差异，再检查暂存内容。不要合并旧分支、推送旧提交或使用 `git push --mirror`，以免把已清理的历史带回来。
5. Windows 后续工作从新 `origin/mac` 建立 `codex/` 开头的任务分支，记录起点提交；Mac 后续继续使用 `mac`。验证命令见[客户端开发说明](../apps/desktop/README.md)。

本轮执行清理的 Mac 已单独备份内部文档与原 Git 历史；其他开发机仍须自行保留原目录。应用的正式任务数据库不在 Git 仓库中，本次操作不迁移或删除任务数据。

## 历史边界

公开分支的新历史不再包含上述文件或普通联系邮箱，但本次同时清理了新旧两个项目仓库的公开分支。其他人已有的克隆、GitHub 的旧提交缓存与历史 CI 记录不一定随分支重写消失。不要把分支清理理解为所有公开副本都已删除。GitHub 对缓存和引用的处理说明见[官方历史清理文档](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)。
