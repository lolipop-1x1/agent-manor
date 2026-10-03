# 实施契约

共享类型以 src/contracts.ts 为准；本文件给出最小协议约束。行范围为一基闭区间 {start, end}，路径相对仓库，版本为字符串，时间为 ISO 8601。
客户端 codex | claude；类别 source | config | docs | unknown；事件类型 read | edit | search | other；结果 success | failure | unknown。

## 领域产物

- Repository：id、绝对 path、Git commonDir、名称、最新 version、stale。
- SourceReference：sourceId、path、recordLine、hash、可选 callId。
- HistoryEvent：id、client、sessionId／parentSessionId、occurredAt、tool、kind、status、cwd、path、fragments、sources、input、output、reason。
- EvidenceFragment：实际返回或修改 content、historicalStart、完整行标识；修改区分新增／删除／上下文，只有改变行可对应当前修改。
- ParsedSource：sourceId、client、path、hash、sessionId、cwd、parentSessionId、events、gaps、completeBytes、可序列化 cursor。
- BaselineFile：path、category、lineCount、hash、content；Baseline：repository、hash、createdAt、Git 状态、files、excluded 路径和原因。
- Mapping：eventId、filePath、exactRanges、nearRanges、unknownReason、ruleVersion，保留 read/edit 类型。
- Filters：client?、from?、to?、categories?、directory?。默认两客户端／全部历史／source。
- FileCoverage：path、category、lineCount、hash、readExactLines、readNearLines、editExactLines、editNearLines、readCount、editCount、searchCount、failedCount、unknownCount、四组范围。
- CoverageResult：repository、version、baselineHash、createdAt、stale、filters、files、summary（文件／行分子分母及四组覆盖）、gaps、previousVersion?。
- FileDetail：版本信息、file、content、contentStale、events（含对应范围）。内容变化不能套旧高亮。
- Job：id、repositoryId、status（queued/running/completed/failed）、phase、progress、startedAt、finishedAt、error?、version?。
- Gap：kind、message、sourceId?、count?，来源缺失／范围未知／格式不支持／歧义分别描述。
- AnalysisSnapshot：repository、version、baseline、sources、events、mappings、gaps、createdAt、previousVersion?。供索引发布和查询使用。

## API v1

| 方法与路径 | 结果 |
| --- | --- |
| GET /api/v1/status | 服务实例、版本、登记仓库与任务 |
| POST /api/v1/stop | 显式停止 |
| GET /api/v1/repositories | {repositories} |
| POST /api/v1/repositories {path} | {repository, job}，登记后刷新 |
| GET /api/v1/repositories/:id/coverage | CoverageResult |
| GET /api/v1/repositories/:id/file?path=... | FileDetail |
| GET /api/v1/repositories/:id/events | {version, events, total, page, pageSize} |
| GET /api/v1/repositories/:id/evidence/:eventId | {version, event, records, unavailable} |
| GET /api/v1/repositories/:id/sources | {version, sources, unassociated, gaps} |
| POST /api/v1/repositories/:id/associations {sourceId} | 刷新 job |
| POST /api/v1/repositories/:id/refresh | {job} |
| DELETE /api/v1/repositories/:id/cache | 清派生索引，保留登记，返回刷新 job |
| GET /api/v1/jobs/:id | {job} |

查询共用 version、client、from、to、categories（逗号分隔）、directory。
API 错误为 {error: {code, message}}。版本缺失、内容过期、输入错误可区分。
活动先筛选后并集；所有下钻维持同筛选和同版本。
后台只监听 127.0.0.1，限制 Host／Origin，不能返回任意未登记绝对路径的内容。

## 模块接口

02 定义最终共享类型后，后续 implementer 遵循类型并在票据结论记录实际导出。
history：discoverSources(roots)、parseSource(path, client, previous?)、associateSource(source, baseline)。
analysis：scanRepository(path)、matchEvent(event, file)、buildCoverage(snapshot, filters)。
index：AnalysisStore 与长期 Worker 调度，暴露登记／查询／来源与关联／刷新任务／清缓存／关闭。
service：API 共用 index／analysis 查询；CLI 只通过 API。
默认历史目录 ~/.codex/sessions、~/.codex/archived_sessions、~/.claude/projects。
验收可用 AGENT_MANOR_CODEX_DIR、AGENT_MANOR_CLAUDE_DIR 指定临时来源目录；AGENT_MANOR_HOME 指定数据目录。
命令名 agent-manor，一个 npm 包包含 dist 后台、Worker、Web 以及 skills。
