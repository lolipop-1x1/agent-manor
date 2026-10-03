# 历史归属 worktree 根查询

日期：2026-10-04

`associateSource()` 在一次来源关联调用内按规范化 cwd 缓存已验证的 worktree 根目录。现有 commonDir 检查仍先确认当前 cwd 与基线仓库属于同一 Git commonDir；`--show-toplevel` 成功后才保存其 canonical 路径。每个事件路径和片段路径仍分别规范化，并单独检查是否位于基线或该 worktree 根目录内。不同 cwd 使用不同缓存项，独立 clone 仍不能关联。

缓存只存在于当前 `associateSource()` 调用中，返回后即释放；下一次调用重新查询 Git 身份。失败的根查询不缓存，当前路径继续按原规则排除，后续路径仍可重试。事件、片段、覆盖与 gap 语义未改变，因此不需要更新 parser 规则版本。

## 固定样本对比

使用 Node 24.19.0 对已冻结的 A 来源缓存和同一版数据库 snapshot baseline 单独调用关联函数，没有重跑完整 Worker，也没有将来源正文输出或写入项目。来源含 2,587 条解析记录和 480 个候选事件。

| 指标 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 关联后事件 | 160 | 160 |
| 关联后片段 | 492 | 492 |
| `range_unknown` gap | 19 | 19 |
| `git rev-parse --show-toplevel` | 580 次 | 1 次 |
| `git rev-parse --git-common-dir` | 4 次 | 4 次 |
| 单次 `associateSource()` 耗时 | 17,145.656 ms | 284.519 ms |

修改前后返回对象的 JSON 序列化 SHA-256 均为 `ad061b98c80e1237a22b8c1f1500fd35fd4202f9b234a0077100da8bf0df9e66`。这是同一冻结输入的一次隔离关联测量；墙钟耗时受进程启动与文件系统缓存影响，不作为全刷新提速承诺。之前完整刷新观察约 24.2–24.5 秒且没有 phase 耗时，所以不能把完整任务时间全部归因于该查询。

## 存储与内存边界

本修改不改变数据库结构、snapshot 内容或版本保留。既有观测中两个仓库数据库合计约 213,352,448 字节，进程边界 RSS 采样最高约 1,239.2 MiB；这些数字不能拆分到单一表、字段或内存阶段。调用内缓存只短暂保存 cwd 到 worktree 根目录的字符串，不会减少持久化 snapshot、ParsedSource、历史片段或 JSON 序列化所占的存储和内存。

回归验证覆盖同 cwd 重用、同一来源跨不同 worktree、相同 remote 的独立 clone，以及两次调用之间 cwd 身份变化后的重新核验。`node --import tsx --test tests/history*.test.ts` 的 36 项测试通过，`npm run check:server` 通过。
