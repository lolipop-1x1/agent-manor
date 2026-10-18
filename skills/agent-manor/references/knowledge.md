# 知识读取、写入与沉淀

当用户希望复用规则、偏好、经验，或把已确认结论留给下一次任务时使用。

## 读取

1. `am knowledge search "问题、对象或关键词" --json` 搜索；按命令帮助指定项目、归属、标签、审阅状态及关键词／语义模式。语义配置是可选增强，关键词搜索可独立使用。
2. 从结果取得实际 ID，`am knowledge get <entryId> --json` 读取正文、状态、适用条件及来源。默认优先使用人工已审阅且当前有效的知识；待审内容作为候选依据。
3. 有疑问时读取 `am knowledge revisions <entryId> --json` 和 `am knowledge revision <entryId> <revisionId> --json`，再按来源回到原会话核对。废弃、冲突或仅特定版本适用的结论不能当作当前通用规则。

## 当前 Agent 直接写入

先 `am knowledge write --help` 核对 JSON 契约，将标题、正文、知识类型、归属、适用项目／条件、语言、标签和可核查来源放入 JSON 文件，再执行：

```sh
am knowledge write --input knowledge.json --json
am knowledge revise <entryId> --input revision.json --json
```

输入也可用 `--input -` 从 stdin 读取。最小必填字段是 `title`、`body`、`scope`；下面是合成的结构示例，执行时填写任务的真实结论：

```json
{
  "title": "配置更新后的验证步骤",
  "body": "验证配置更新时，同时检查服务端新值与客户端实际读取值，并记录验证结果。",
  "type": "procedure",
  "scope": { "kind": "global" },
  "subject": "general",
  "language": "zh-CN",
  "tags": ["配置", "验证"],
  "sources": [{ "kind": "agent" }]
}
```

项目知识的 `scope` 改为 `{ "kind": "project", "project": "<实际项目标识>" }`，`subject` 为 `project`；个人偏好使用 `subject: "personal"`。`type` 支持 `fact`、`preference`、`constraint`、`decision`、`procedure`、`lesson`、`event`、`open_question`。`language` 为 `zh-CN` 或 `en`，正文保持用户所需语言。

修订提交包含完整正文与元数据，并附 `baseRevisionId`，值取最近一次读取的 `latestRevisionId`。重复提交可附稳定 `idempotencyKey`；同一键只用于同一份内容。来源只填写已核验的 `sessionId`、`messageId`、`sourceVersion`、`excerpt` 等字段，不能编造 ID 或默认标记来源可用。

直接写入不调用生成模型重复提炼。提交后读取返回修订，核对内容与来源，报告待审状态；普通 Agent 写入不直接变成人工审阅通过。

需要历史恢复时用 `am knowledge restore <entryId> --help`，恢复形成新的待审修订。

## 从历史会话提炼

1. `am knowledge extraction preview --help`，通过 `--input` 提交 `{ "scope": ... }`，指定实际 `sessionIds`、可选的 `turnStart`／`turnEnd`，并保留完整范围字段：`timeRange`、`recentDays`、`clients`、`projects`、`relationship`、`executionMode`、`models`、`title`、`branch`。默认范围从已保存的知识设置读取，明确替换选中的会话，不自行扩大为全部历史。读取预览的会话、输入估算、分片与预算。
2. 用户授权该次模型调用后，`am knowledge extraction start <previewId> --json` 创建任务。
3. `am knowledge extraction get <jobId> --json` 查看阶段、过程、用量与结果；历史用 `list`，控制用 `pause <jobId>`、`resume <jobId>`、`retry <jobId>`。
4. 读取实际产出的知识和来源，确认没有价值的信息可以不产出知识。模型输出和过程摘要不等同于原始执行证据。

## 人工审阅与有效性

`am knowledge review <entryId> <revisionId> <approve|reject>` 绑定具体修订。CLI 返回的操作摘要需由用户实际核对并明确授权；用户授权后才使用 `--authorize <digest>` 提交。`am knowledge availability <entryId> <active|deprecated|superseded>` 遵循同样流程。

不得把用户一般的“帮我沉淀”解释为批准所有修订，也不自行复用旧摘要授权另一项操作。未取得该次授权时，报告候选结果并等待用户审阅。
