# 修复真实历史刷新 Worker 内存耗尽

Type: task
Status: resolved
Blocked by:

## Scope

定位真实历史全量刷新触发的 Worker 堆内存耗尽，修复造成超量保留的数据或生命周期问题。保持统计与证据口径不变，不通过跳过历史制造成功结果。

## Acceptance

- 记录真实服务失败、历史输入规模及可以重复执行的失败反馈。
- 用最小回归验证根因，并检查完整结果发布与失败恢复。
- 修复后以同一批本机历史刷新成功，Web 与 CLI 能读取完成的结果。

## Comments

- 2026-10-05：4317 服务中的本机仓库尚无结果版本；刷新任务在约 55 秒后报 Worker terminated due to reaching memory limit: JS heap out of memory。实际仓库及任务标识不公开。
- 2026-10-05：受限堆回归先复现同样错误；未关联会话完整正文、批量旧缓存与共享事件副本造成内存放大。新增归属元数据缓存和按来源读缓存／查事件，相关来源完整证据重读；Worker 失败后下一次刷新可恢复。

## Answer

修复在 main 完成。完整 128 项测试、类型检查、构建和 diff 检查通过。现有默认历史首次重建成功，最终增量约 74 秒；CLI/API 同版本统计一致，原始证据回读和浏览器页面验收通过。数据目录、仓库登记及原始会话保留。

验收记录：[refresh-worker-memory.md](../../../docs/validation/refresh-worker-memory.md)。
