# 用户明确要求后直接写入知识

仅当用户明确要求“记录／沉淀／更新知识”等操作时使用。当前 Agent 已整理的结论直接 write，无需另调生成模型。若要从历史对话重新提炼，转[会话沉淀](knowledge-extraction.md)。

## 创建与回读

将[创建示例](../examples/knowledge-create.json)复制到工作目录，按用户实际结论编辑，特别是 scope.project 和来源。示例为合成内容，不应写进真实知识库。

```sh
am knowledge write --input knowledge-create.json --json
am knowledge get <entryId> --review all --availability all --json
am knowledge revision <entryId> <latestRevisionId> --json
```

`--input -` 可读 stdin，`--data` 仅用于短 JSON；输入对象结构如下。

| JSON 字段 | 类型、必填及含义 |
|---|---|
| `title` | 必填非空字符串，最多512字符；简明描述可复用结论 |
| `body` | 必填非空字符串，最多524288字符；包含结论、条件、方法与验证边界，支持 Markdown |
| `scope` | 必填对象：全局 `{ "kind":"global" }`；项目 `{ "kind":"project", "project":"/workspace/example" }`。global 不可指定 project |
| `subject` | personal / project / general；主体归属，与适用范围不是同一个字段 |
| `type` | fact / preference / constraint / decision / procedure / lesson / event / open_question |
| `language` | zh-CN 或 en；正文按用户所需语言写，CLI 的 lang 不会自动翻译正文 |
| `tags` | 字符串数组，最多64项，每项非空且≤128字符；用于分类搜索 |
| `summary` / `applicability` | 可选摘要／适用条件，各≤16384字符 |
| `validUntil` / `occurredAt` | 可选 YYYY-MM-DD 或带时区时间；知识有效期／事件发生时间 |
| `resolved` | 可选布尔值；true 仅适用于 open_question |
| `sources` | 来源对象数组，最多128项；每项 kind 为 agent/manual/extraction，可附已核验 sessionId、sourceVersion、messageId、branch、excerpt 等 |
| `author` / `changeReason` | 可选作者／变更理由；不填未知身份，不把私人信息写进共享示例 |
| `idempotencyKey` | 可选稳定字符串，同一次同内容重试沿用；新内容用新键，不可把不同操作混用 |

未知字段会被拒绝，整个对象不得超过2 MiB。写入不能传 review=reviewed；来源不确定时只填 kind，不编造消息 ID 或 available 状态。

写入默认返回 `id`（entryId）、`latestRevisionId`、`revision.id/version/review` 和 availability；**不回显正文**。必须用 revision 回读核对已存内容。结果应为 pending，报告“已记录，待审”，不表述为人工已确认。

## 修改、并发与历史恢复

```sh
am knowledge get <entryId> --review all --availability all --json
am knowledge revise <entryId> --input knowledge-revise.json --json
am knowledge revisions <entryId> --json
am knowledge revision <entryId> <revisionId> --json
am knowledge restore <entryId> --data '{"revisionId":"<historicalRevisionId>","baseRevisionId":"<latestRevisionId>"}' --json
```

[修订示例](../examples/knowledge-revise.json)是**完整快照**，不支持只传局部 body。`baseRevisionId` 取刚读取的 latestRevisionId，scope、tags、sources 等仍需保留需要的值；不要把 get 的整个返回对象原样当 draft 提交。

`CONTENT_STALE` 表示期间有新修订：读取最新内容比较，再决定合并或重做，不能自动覆盖。restore 的 revisionId 是待恢复的历史版本，baseRevisionId 仍是当前最新版本；恢复会新建 pending，不回滚审阅历史。需要人工批准时读[审阅流程](knowledge-review.md)。

完成条件：回读具体修订，核对正文、范围、语言、来源与 pending 状态；向用户给出 entryId/revisionId。普通任务即使发现经验，也不自行调用此流程。
