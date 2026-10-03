# Issue tracker: Local Markdown

本仓库的需求、规格和任务使用 `.scratch/` 下的 Markdown 文件管理。

## 文件约定

- 每个功能使用独立目录：`.scratch/<feature-slug>/`。
- 规格文件：`.scratch/<feature-slug>/spec.md`。
- 每个任务单独成文：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`。
- 任务编号从 `01` 开始，不将多个任务合并成一个文件。
- 在任务文件顶部附近用 `Status:` 记录分诊状态，
  状态字符串见 `triage-labels.md`。
- 评论和讨论追加到文件底部的 `## Comments` 下。

## 发布与读取

Skill 要求“发布到任务跟踪系统”时，在对应功能目录创建文件；
目录不存在时按需创建。

Skill 要求“获取相关任务”时，读取用户指定路径或编号对应的文件。

## Wayfinder 约定

- 地图：`.scratch/<effort>/map.md`，记录笔记、已作决策和待澄清问题。
- 子任务：`.scratch/<effort>/issues/NN-<slug>.md`。
- 用 `Type:` 记录类型：`research`、`prototype`、`grilling` 或 `task`。
- 用 `Status:` 记录 `claimed` 或 `resolved`。
- 用 `Blocked by: NN, NN` 记录依赖；
  所列任务全部为 `resolved` 后才解除阻塞。
- 查找下一任务时，筛选未完成、未认领且无阻塞的任务，按编号选择。
- 开始工作前，先写入 `Status: claimed` 并保存。
- 完成后，在 `## Answer` 下追加结果，设置 `Status: resolved`，
  并将结论摘要和文件链接追加到地图的已作决策部分。
