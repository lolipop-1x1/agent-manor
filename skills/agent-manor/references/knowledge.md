# 知识读取与来源核查

用于查项目规则、个人偏好或经验；普通读取不顺带记录新知识。参数及错误共用[公共契约](output.md)。

## 搜索 → 正文 → 来源

```sh
am knowledge facets --json
am knowledge search "缓存失效" --mode keyword --review reviewed --availability active --page-size 5 --json
am knowledge get <entryId> --json
am knowledge revisions <entryId> --json
am knowledge revision <entryId> <revisionId> --json
```

从 search 的 `items[].id` 取得 entryId；`revision.id` 是修订 ID，不能代替 entryId。默认 list/search/get 选择已审阅且有效内容；查待审使用 `--review pending`，查全部版本状态使用 `--review all --availability all`。

| 参数 | 值、默认及用途 |
|---|---|
| search `<text>` / list `--q` | 关键词文本；search 为必填位置参数，list 可无搜索词 |
| `--mode` | keyword（默认）或 semantic；后者须配置并构建知识向量索引，不会自动退回关键词 |
| `--view` | all（默认）、personal、project、general；描述知识归属 |
| `--project` | 单个完整项目标识，优先从 facets.projects 取得，不用目录名猜测 |
| `--client` / `--tag` / `--type` | 单个客户端／标签／知识类型，按来源或元数据筛选 |
| `--review` | reviewed（默认）、pending、rejected、all |
| `--availability` | active（默认）、deprecated、expired、superseded、resolved、all |
| `--from` / `--to` | 可解析日期／时间；限制知识更新时间，不是来源消息轮次 |
| `--task-id` | 限定某个抽取任务的产物，值为 extraction 的 job.id |
| `--page` / `--page-size` | 从1开始，默认每页20；pageSize 最大200 |
| get `--revision-id` | 指定快照修订；可直接使用 revision 子命令避免与默认审阅筛选混淆 |

知识类型：fact事实、preference偏好、constraint约束、decision决策、procedure方法、lesson教训、event事件、open_question未决事项。标签可跨类型使用。

## 核心返回字段

| 字段 | 含义 |
|---|---|
| `items`、`total`、`page`、`pageSize` | 命中条目与分页；列表只供挑选，不含正文 |
| `id`、`latestRevisionId`、`publishedRevisionId` | 条目／最新提交／最近人工通过的修订；后两者可能不同 |
| `revision` | 当前查询选出的版本；reviewed 查询可继续显示旧的已审阅内容 |
| `pendingRevision` | 另有待审版本时的简短身份，不表示已生效 |
| `revision.body`、`applicability`、`scope` | 正文、适用条件和项目／全局范围 |
| `revision.review` / `availability` | 人工核对状态与条目有效性，互相独立 |
| `revision.sources[]` | 来源类型、sessionId/messageId/sourceVersion/branch、可用状态 |
| `sourceCount`、`changedSourceCount`、`missingSourceCount` | 来源总数／已变化／缺失数量；来源可读不代表结论已验证 |
| `score` / `snippet` | 搜索相关性／命中摘要，可能不提供；不等于可信度 |

来源指向会话时，使用 `sessionId` → `sessions messages`，带 `sourceVersion`、`messageId` 和 branch 回查；需要完整 excerpt、hash、来源限制时对知识 get/revision 加 `--full`。如果版本失效或 source.status=changed/missing，重新查可用历史并说明差异，不能假称看过当时证据。

完成条件：给出适用结论、具体 entryId/revisionId 和来源；待审、过期、冲突或仅特定版本适用的内容须明确标记。结果为0时先检查默认 reviewed/active 筛选，不直接断定知识库没有记录。
