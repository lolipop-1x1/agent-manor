# 代码活动、覆盖与回放

用于了解哪些代码曾被读取／修改、追踪工具原始证据及观察缺口。代码覆盖来自已采集活动，不表示代码质量或测试覆盖。

## 登记 → 版本 → 文件与证据

```sh
am repositories list --json
am repositories register /workspace/example --wait --json
am coverage <repositoryId> --json
am events <repositoryId> --version <repositoryVersion> --page-size 5 --json
am file <repositoryId> src/example.ts --version <repositoryVersion> --json
am evidence <repositoryId> <eventId> --version <repositoryVersion> --json
am repositories gaps <repositoryId> --version <repositoryVersion> --json
```

新登记只在用户要求分析该仓库时执行；返回 repository.id 和 job，`--wait` 等准备完成。原有仓库从 repositories 列表取 id；events 取稳定 eventId，不用序号猜测。

| 参数 | 规则 |
|---|---|
| `--version` | 仓库分析版本，取 coverage/events 返回 version；不是会话索引或 Git SHA |
| `--client` / `--from` / `--to` | 客户端／ISO时间范围，起点≤终点；下钻沿用原筛选 |
| `--categories` | 逗号分隔 source/config/docs/unknown，默认 source |
| `--directory` / events `--path` / file `<path>` | 仓库内相对路径，不传外部绝对路径 |
| `--session-client` + `--client-session-id` | 必须成对；此处用原生客户端会话 ID，非内部 sessions.id |
| events `--kind` | read/edit/search/other；分页从1开始，摘要默认20条；full 未指定时默认50条，最大200 |
| hotspots `--metric` / `--limit` | read/edit/activity（默认activity），limit 默认20、最大1000 |

| 核心字段 | 含义与下一步 |
|---|---|
| `repository.id/name/path/version/stale` | 仓库身份及快照状态，后续命令复用版本 |
| coverage `summary/files` | 汇总／文件范围；readExact/readNear/editExact/editNear 分开计数 |
| `readCount/editCount/activityCount/searchCount/failedCount/unknownCount` | 活动身份／类别／状态计数，可能重叠，不能直接相加当总事件数 |
| `gapCount` | 缺口数，具体原因用 repositories gaps，不为0就假设全部可见 |
| events `id/tool/kind/status/path/mapping/sourceCount` | 可供选择的活动摘要，不含完整调用载荷 |
| file `content/contentStale`（存在时） | 文件正文与当前内容是否变化；旧范围不能强行高亮到不同内容 |
| evidence 的输入、输出、fragments、records／unavailable | 原始调用、源码片段与回读状态；以实际可用证据核查成功失败 |

只查没有观测到的代码可用 `am unobserved <repositoryId>`；热点用 `hotspots`；未关联来源用 `sources`，经用户确认后 `associate <repositoryId> <sourceId> --wait`。刷新用 `refresh <repositoryId> --wait`；异步结果的 job.id 可交给 `jobs <jobId> --wait`。

## 回放必须保留两套版本

```sh
am repositories replay-sessions <repositoryId> --json
am repositories replay <repositoryId> --session-id <sessionId> --version <repositoryVersion> --session-version <sessionVersion> --json
am repositories replay-evidence <repositoryId> --session-id <sessionId> --version <repositoryVersion> --session-version <sessionVersion> --event-id <eventId> --json
```

sessionId 取 replay-sessions 中内部会话选项，version/sessionVersion 都取同次返回；eventId 取 replay 返回的活动。普通 `repositories sessions` 用于仓库会话统计，其原生会话标识不能代替 replay 所需内部 ID。

`orderKnown=false` 表示来源未证明顺序；不同并行轨道不保证全局因果关系。回放展示按活动顺序，不证明真实执行耗时。没有原始来源的事件要说明 unavailable。不要把摘要中的路径、工具名称当作已读完整证据。

完成条件：给出仓库版本、范围、观察结果和事件证据；精确与附近命中、成功与未知分开说明。删除登记 `repositories remove <id>` 保留源代码，但属于管理动作，不能作为查询收尾习惯执行。
