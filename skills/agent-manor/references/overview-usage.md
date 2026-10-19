# 总览、用量与费用

用于统计活动投入、客户端／项目／模型用量及请求依据。先小范围聚合，再按对象下钻，不直接加载全量 report。

## 总览快照与面板

```sh
am overview snapshot --window 30 --timezone UTC --json
am overview panel --window 30 --panel core --json
am overview panel --window 30 --panel distribution --dimension project --json
am overview detail --window 30 --detail '{"view":"resources","page":1,"pageSize":5}' --json
am overview review --window 30 --json
am overview review-detail --window 30 --detail '{"kind":"sessions","page":1,"pageSize":5}' --json
am overview evidence --window 30 --evidence '{"kind":"requests","page":1,"pageSize":5}' --json
```

上面的入口示例各自取当前快照；要比较同一次结果，在后续命令显式复用 snapshot 返回的 `version`、`priceVersion`、`timezone`、`range.today`（作为 `--anchor-day`）及原筛选。

| 参数 | 值与规则 |
|---|---|
| `--window` | 7/30/90/365/year/all/custom，默认365；日期为 YYYY-MM-DD |
| `--from` / `--to` / `--anchor-day` | 起止日及稳定基准日；自定义范围使用 window custom |
| `--clients` / `--projects` / `--models` | JSON 字符串数组，如 `'["codex"]'`；models 只影响用量区域／用量洞察 |
| `--panel` | 必填 core/usage/resources/process/repositories/insights/distribution/delegation/facets |
| `--dimension` | 仅 distribution 接受且必填：client/project/model |
| `--detail` | JSON 对象；detail 的 view 支持 resources/resource/ranking/months/transitions/observations/combinations；resource 需 resourceId；分页在对象内，pageSize≤100 |
| review-detail `--detail` | JSON 对象的 kind 为 sessions/sessionRounds/rounds/cache/compressions/tools/agents/models/reasoning/prompts/activity/uncompressed |
| `--evidence` | JSON 对象，kind 如 activity/sessions/requests/resources/tools/failures/combinations/observations/delegation；分页在对象内，pageSize≤200 |

snapshot 本身是版本／筛选定位信息，不含实际统计；panel 返回 `snapshot/panel/data`（可能有 counts），detail/evidence 返回 `rows/total/page/pageSize`。report 返回完整报告，常规问题优先选择所需 panel，避免无关数据占用上下文。

## 用量报告 → 单个会话请求

```sh
am usage status --json
am usage report --clients '["codex"]' --group-by model --interval week --page-size 5 --json
am usage requests --session-id <sessionId> --version <version> --price-version <priceVersion> --request-page 1 --request-page-size 20 --json
```

sessionId 取 report.sessions[].session.id；也可用 sessions list 的内部 ID。请求明细 **session-id 必填**，version/priceVersion 及筛选沿用报告。普通报告页与请求明细页相互独立。

| 参数 | 类型、默认及依赖 |
|---|---|
| `--clients/--projects/--models` | JSON 字符串数组；各自 exclude-clients/exclude-projects/exclude-models 为排除集合 |
| `--from` / `--to` | 都用 YYYY-MM-DD 或都用带时区 ISO 时间；不可混用，起点≤终点 |
| `--timezone` | 有效 IANA 时区；不随显示语言改变统计范围 |
| `--relationship` | all/main/child；`--session-type` 为 all/interactive/automation/fork |
| `--coverage` / `--pricing` | all/complete/partial/missing；分别表示用量与价格覆盖 |
| `--metric` / `--group-by` | tokens/cost/requests；分组 project/model/client |
| `--interval` / `--sort` / `--direction` | hour/day/week/month；tokens/cost/requests/recent；asc/desc |
| `--page` / `--page-size` | 报告会话列表，从1开始，摘要默认20，最大200 |
| `--request-page` / `--request-page-size` | 请求页从1开始，默认1/100，最大每页200；示例显式缩到20 |
| `--min-tokens/--max-tokens` | 非负安全整数；min≤max |
| `--min-cost/--max-cost` | 非负费用数；min≤max |
| `--include-speed true` | 开启速度分析；speed-group（单值）/speed-groups（JSON数组）依赖此项 |

| 核心返回字段 | 含义 |
|---|---|
| `version` / `priceVersion` | 会话用量快照／价格快照，后续保持一致 |
| `totals` | 选定范围的 Token、请求、估算费用等汇总，不是当前一页的和 |
| `buckets` / `groups` | 时间桶趋势／所选维度聚合；默认省略旧 days 与 facets，必要时 full |
| `undated` / `missingUsageSessions` | 无可定位日期的统计／缺失用量的会话数量，不能直接当作0 |
| `sessions` / `totalSessions` / `page` / `pageSize` | 本页会话用量与总数，默认不含各请求正文 |
| `pricing` | 单价来源和覆盖程度；缺价不代表免费 |
| requests `requests` / `total` / `page` / `pageSize` | 单会话请求列表及独立分页；不要用报告 page 去续读 |

速度指标按来源支持解释；历史时间戳不一定是请求开始或首 Token 时间。估算费用与供应商实际账单分别表达，不能把全部 Token 计数都当作实际计费输入。

## 价格配置

```sh
am usage pricing get --json
am usage pricing list --model example-model --page-size 5 --json
am usage pricing refresh --json
am usage pricing set --input pricing.json --json
```

get 返回 `version/configuration/priceCount` 等，完整目录用 list，延续版本时传 `--version <priceVersion>`。refresh 会请求公开价格源。修改价格需用户要求，JSON 为 `{ "overrides": [...], "mappings": [...] }`，不是 patch；参考[价格示例](../examples/pricing.json)。override 必填 model/input/output（非负、每百万 Token 单价），可选 provider/cacheRead/cacheWrite/reasoning/inputAudio/outputAudio；mapping 必填 model/targetModel/targetProvider。

完成条件：说明统计区间、对象、版本、汇总和缺失／估算边界；请求细节核对同一版本，不能用当前页数量代替总体。
