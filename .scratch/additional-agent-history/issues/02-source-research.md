# 来源与源码核验

Type: research
Status: resolved

## Scope

只读核验七个客户端的原生来源、格式、身份、工具过程、模型及用量、父子与分支关系、标题与项目元信息、来源副本与刷新一致性。公开材料仅保存匿名结构和支持结论；需要证据定位时使用公开源码版本或项目源码行号。

## 已确认事实

- DSH 本机来源存在 V3／V4 格式及 Zstandard 压缩。官方源码将会话格式代际分开保存；投影缓存不是独立会话正文。
- 项目已有客户端与格式分开的内置注册；当前会话索引的来源指纹及部分规范化逻辑仍包含既有客户端特例，新增来源需验证两个功能入口的共同适配边界。
- Pi 的原生 `parentId` 连接同一会话内的事件树节点；头部 `parentSession` 则描述跨会话分支来源。两者不能都解释为子 Agent 父会话。
- Pi 安装包的恢复逻辑以最后保存的事件作为当前叶节点；只移动运行时叶指针但尚未追加事件时，不会写出该切换。浏览器只能还原已保存的当前分支。
- OpenCode 安装版对应的官方任务工具会创建带父身份的子会话，分叉创建路径不设置该父字段；此字段不能用作所有分叉血缘的统一证据。已有本地源码检出版本与安装版不同，必须用相匹配的官方版本核验。
- ZCode 任务索引的原生任务身份可与消息库会话身份关联，不能把两库条数相加为会话数。实际桌面进程怎样启动内部引擎尚未取得包内调用证据。
- WorkBuddy 的会话库保留来源模式字段，安装包也包含 CodeBuddy 执行文件；共享引擎本身不能证明产品身份相同。

## 格式与语义核验

| 客户端 | 已核验来源与格式 | 模型／用量 | 关系及过程要点 |
| --- | --- | --- | --- |
| DeepSeek Harness | `~/.dsh/sessions/` 中 V3／V4 的压缩事件流；投影缓存仅作补充元信息 | 助手及尝试中的模型、输入／输出和可选缓存桶；缺失缓存字段不是零 | `parentSession` 表示分叉来源；`origin`／`delegationDepth` 可证明委派类别；继承前缀、失败尝试及压缩替换必须区分 |
| Pi | `~/.pi/agent/sessions/` JSONL，安装包 0.87.1，格式版本 3 | 助手 `usage`，独立用量、压缩／分支摘要用量；工具结果的专用用量不直接并入模型用量 | entry 的 `parentId` 为会话内树；头部 `parentSession` 是分叉来源文件；当前叶为最后保存事件。`compaction`、`branch_summary`、`custom_message` 和 `context_edit` 不是新用户请求 |
| OpenCode | 数据目录 SQLite 的 `session`／`message`／`part`；安装版 1.18.31 | 助手和步骤中的模型、Token、缓存及成本字段；消息级与步骤级汇总不能重复累计 | Task 子会话设置 `parentID`；fork 不设置同一字段。工具 `callID`、状态与结果可配对；压缩／回退按原生消息及会话字段核验 |
| WorkBuddy | `~/.workbuddy/` 原生 SQLite 元信息与项目目录 JSONL；正文、reasoning、`function_call` 和 `function_call_result` 分别保存 | `providerData.model`、`message.usage`、`providerData.usage` 及 `rawUsage`；缓存记录存在，字段大小写及口径有多种形态 | 工具按会话身份与 `callId` 配对；`isCompactInternal`／`isCompacted`／`isMeta`／`isSummary` 可辅助识别上下文；不把共享引擎当作相同产品 |
| ZCode | `~/.zcode/v2/tasks-index.sqlite` 与 `~/.zcode/cli/db/db.sqlite`；任务元信息、消息及工具 part 合并 | 消息 tokens、`model_usage` 请求／尝试记录、`turn_usage` 汇总、`tool_usage` 执行记录；缓存与耗时有原生字段 | 原生任务／会话身份可关联；`forked_from_task_id`、`parent_id` 等字段的语义和委派分类分别核验，不能直接套用 OpenCode 的源码规则 |
| CodeBuddy | `~/.codebuddy/projects/` JSONL；本机样本仅有用户输入 | 本机样本未记录模型、用量、缓存或工具过程；不表示产品永远不支持这些数据 | 消息 `parentId` 不是已证实的父会话身份；保留产品身份，不猜测写入的产品形态 |
| Qoder | `~/.qoder/projects/` JSONL；首行 `workspace-directories` 的文件也包含会话正文，另有带 agent 元信息的文件 | 标题／目录／模型字段及助手 `message.usage` 的输入、输出、缓存读写字段；需逐格式核验输入桶关系 | 已记录 tool-use／tool-result 可配对；带 `agentId` 的样本 `isSidechain` 为 false，`parentUuid` 未关联到现存主记录，不能据此宣称已证实子 Agent 或父关系 |

### Token 口径

- DeepSeek Harness 的 `inputTokens` 为未缓存输入，缓存读取／写入是另外两个互斥桶；`reasoningTokens` 是输出子集。`totalTokens` 可缺失或因不一致而省略，不能强行填零。
- Pi 的已核验模型适配器把未缓存输入、缓存读和缓存写分开；`reasoning` 为 output 子集，`cacheWrite1h` 为 cacheWrite 子集。独立 usage、compaction 和 branch_summary 可记录额外请求，不应只统计助手正文事件。
- OpenCode 1.18.31 的 `getUsage()` 将 input 中缓存桶扣除后保存，把 reasoning 从 output 分离。故其 reasoning 与 output 需要合并为归一化总输出，不能照搬 Pi／DeepSeek Harness 的子集规则。
- 某些来源可能在字段缺失时自行写入零；AgentManor 展示的是来源记录值，不能将其扩大为提供商已完整报告的保证。所有比例均说明可核验记录范围。

### 公开源码定位

- [DeepSeek Harness 源码快照](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc)：`packages/core/session/src/types.ts` 的头部与事件类型；`packages/llm/llm/src/types.ts` 的 TokenUsage；`packages/core/session/src/fork.ts` 与 `packages/subagent/` 的继承／委派边界；`packages/compaction/` 的摘要和替换操作。
- [Pi 官方仓库](https://github.com/earendil-works/pi)：实际核验基于本机安装包 0.87.1 的 `session-manager.d.ts`／`session-manager.js`、pi-ai 类型及模型适配器；安装包未提供 gitHead，不宣称对应仓库某一提交。
- [OpenCode 1.18.31 Task](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/tool/task.ts#L144-L181)、[fork](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/session.ts#L653-L691)、[用量归一化](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/session.ts)。本地旧检出版本与安装版不一致，未用于推断新版行为。

## 能力限制

- ZCode 桌面启动内部引擎的调用链，以及 CodeBuddy／Qoder 部分历史由哪种产品形态写入，尚不能确定；这些限制不阻止按已确认产品身份接入原生记录。
- WorkBuddy 的 `source_mode` 记录为 coding／craft／working，不是 CLI／桌面枚举；`session_usage` 的 used／size／credit_json 不能直接当作 Token 或缓存指标，应优先正文中可核验的请求记录。
- WorkBuddy 的工具请求存在少量未记录结果，ZCode 的工具 part 与执行用量表也非全部一一匹配；缺少结果或执行统计是采集缺口，不按完整成功调用补造。
- Qoder 的 agent 字段与父消息字段尚不足以确认本机样本的委派身份；无明确证据时正常展示。CodeBuddy 当前样本没有助手／工具／用量，相关视图应说明来源未记录。
- WorkBuddy、Qoder、ZCode 的每一种提供商用量形态仍须在实现时依据 raw usage／可核验格式逐一归一化；无法确认分母时只展示记录字段，不计算缓存比例。
- 本研究为结构／源码核验，不表示已经实现适配器或完成浏览器端到端测试。

## Answer

七个客户端均已有可接入的本机来源，格式、产品身份和关键关系边界已核验。主 Agent 补查 WorkBuddy 全部本机 JSONL 的事件结构及工具配对，避免仅根据 SQLite 元信息误判工具／用量缺失；并以 `mode=ro` 一致快照核对 ZCode，包含已提交 WAL。初步 immutable 查询不作为最新全量计数依据。实现须按上述能力限制保留缺失，不能将相似格式当作相同语义。
