# 从历史会话沉淀知识

用户明确要求从指定会话或时间范围提炼时使用。此流程会调用生成模型；直接保存已整理的结论应使用[直接写入](knowledge-write.md)。

## 选范围并预览

```sh
am sessions search "缓存" --page-size 5 --json
am sessions turns <sessionId> --version <sessionVersion> --json
am knowledge settings get --json
am knowledge extraction preview --input extraction-preview.json --json
am knowledge extraction preview-get <previewId> --full --json
```

先从 sessions 返回值取真实 ID、轮次，复制[预览示例](../examples/extraction-preview.json)，替换 sessionIds 和轮次。整段会话去掉 turnStart/turnEnd；不要为方便而删掉 sessionIds 扩大到全部历史。也可从 settings.config.automatic.scope 复制范围，再明确替换用户选择的字段。

| scope 字段 | 类型与语义 |
|---|---|
| `timeRange` / `recentDays` | unset / all / recent；recentDays 为1..36500整数；没有指定 sessionIds 时 unset 会拒绝 |
| `sessionIds` | 可选会话 ID 字符串数组；指定会话仍与其他筛选取交集，匹配不到时核对过滤器 |
| `turnStart` / `turnEnd` | 可选非负整数，使用 turns 实际 position（通常从1开始）；闭区间、起点≤终点；不填写即整段 |
| `clients` / `projects` / `models` | 字符串数组，空数组不限制；项目用完整标识 |
| `relationship` | all / exclude_children / children / forks / unknown |
| `executionMode` | all / exclude_quiet / quiet / unknown |
| `title` | 标题筛选文本，空串不限制 |
| `branch` | current / all 或实际分支标识；不要把 Git 分支名当作会话分支 |
| `force` | 布尔，默认增量；true 重新处理已覆盖消息，可能重复计费，仅明确需要时使用 |

## 预览字段与预算

| 字段 | 含义及操作 |
|---|---|
| `id` / `fingerprint` | 冻结的预览身份及设置指纹；start 使用此 id，不传 sessionId |
| `sessionCount` / `turnCount` | 完整待处理范围，不是本页数量 |
| `estimatedTokens` / `estimatedOutputTokens` | 预计输入／输出，含规划和归并开销；不是历史客户端累计用量 |
| `contextTokens` / `plannedChunks` | 上下文估算／预计提炼分片数；一轮可能有多条消息并产生多片 |
| `estimatedCost` | 依据配置单价估算；null 表示未计价，不代表免费 |
| `pendingMessages` / `skippedMessages` | 待处理／已覆盖而跳过消息数；force 会改变覆盖处理 |
| `targetCount` / `targetsTruncated` | 所有目标数／默认最多20个目标是否截断；审阅完整清单加 full |
| `targets[]` | 各会话标题、ID、版本、轮数、分片估算；完整模式还含 messageIds、hashes |
| `limitations` | 来源、正文省略及证据限制；不把未读工具正文当作执行已验证 |

核对会话、轮次、分支、预计用量和费用，再在用户已授权的范围内 start。范围过大、费用不明时缩小预览；不在普通查询时创建抽取任务。

## 启动、观察与取结果

```sh
am knowledge extraction start <previewId> --idempotency-key <sameOperationKey> --json
am knowledge extraction get <jobId> --json
am knowledge extraction pause <jobId> --wait --json
am knowledge extraction resume <jobId> --wait --timeout 300 --json
am knowledge extraction list --page 1 --page-size 10 --json
am knowledge extraction get <jobId> --full --json
am knowledge list --task-id <jobId> --review pending --json
```

| 返回字段 | 含义 |
|---|---|
| `id` / `previewId` | 后台 jobId／来源预览；start 的结果 id 后续用于 get/pause/resume/retry |
| `status` / `phase` | queued/running/paused/complete/partial/failed/budget_stopped；阶段 planning/extracting/merging/saving/complete |
| `completedSessions` / `totalSessions`、`completedChunks` / `totalChunks` | 会话与分片进度，不能混为同一个百分比 |
| `createdEntries` / `updatedEntries`、`duplicates`、`noValue`、`needsContext` | 新增／修订／重复／无价值／上下文不足计数；成功可以产出0条 |
| `usage` | 已发生调用、Token、估算费用，实际与估算及缓存字段按模型可用性提供 |
| `resultCount` / `eventCount` / `failedSessionCount` | 摘要数量；full 的 results[] 给 knowledgeId/revisionId，events[] 给过程 |
| `error` / `failedSessions` | 失败诊断；完整模式查失败会话，修正后才 retry |

`--wait` 默认120秒，超时只停止等待；继续用 jobId 查状态，不重新 start。pause 等待至 paused，resume 才继续；retry 不是绕过预算或重新授权的捷径。来源或配置变化导致预览失效时重新 preview。

完成条件：核实终态、实际用量和新增／修订数，读取产出修订及来源；结果仍是待审，走[人工审阅](knowledge-review.md)。complete 且 noValue>0 可表示正常过滤无价值内容，不能为了凑数强行写入。
