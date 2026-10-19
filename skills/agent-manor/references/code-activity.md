# 代码活动与证据

用于查代码覆盖、热点、修改轨迹和具体历史依据。

1. `am repositories --json` 找到已登记仓库。用户要求登记时执行 `am register <absoluteRepositoryPath> --wait --json`，确认任务成功并保存 repository ID。
2. `am coverage <repositoryId> --json` 读取版本、范围和缺口数量；缺口正文用 `am repositories gaps <repositoryId> --version <version> --json`。可用 `--client`、`--from/--to`、`--categories`、`--directory`，以帮助列出的稳定客户端 ID 为准。
3. `am file <repositoryId> <relativePath> --version <version> --json` 读取文件结果，`am events <repositoryId> --path <relativePath> --version <version> --json` 找到活动；后续始终带相同范围与数据版本。
4. `am evidence <repositoryId> <eventId> --version <version> --json` 回读原始证据。热点用 `hotspots`，未观察范围用 `unobserved`，来源与归属用 `sources`；轨迹用 `am repositories replay --help`。

回放证据先通过 `repositories replay-sessions` 和 `repositories replay` 取得实际会话、事件及双版本，再执行 `repositories replay-evidence`；同时提供 `--event-id`、`--session-id`、`--version` 和 `--session-version`，不同分析版本的标识不能混用。

`events` 默认每页20条活动摘要，文件详情也只嵌入活动摘要；原始工具输入输出、片段和来源明细通过同版 `evidence` 按活动 ID 读取。文件正文及过期校验字段保留。完整列表字段用 `--full`，翻页继续带同一 version，避免为寻找一个活动先拉取全部调用正文。

精确读取与修改分别计算，不把近似范围加到精确覆盖率。各状态可能重叠，活动去重总数不能靠各列相加。未观察读取不表示无用或安全可删；搜索命中不等于打开文件，历史改动不自动证明作者归属。

`contentStale` 或内容缺失时，不把旧行范围套在当前源码上。需要刷新时 `am refresh <repositoryId> --wait --json`，成功后重新取得版本；失败保留旧版并说明过期。`evidence.unavailable` 表示来源变化或不可读，不补造原文。

只有用户已确认关系时才执行 `associate`；删除仓库登记、重建缓存等管理入口先核对帮助和影响，原 Git 与原始会话保持只读。不要将本机源码或原始对话复制到公开提交或外部服务。
