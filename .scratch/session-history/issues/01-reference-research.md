# 参考源码与现有会话能力

Type: research
Status: resolved

## Scope

- agentsview：列表、搜索、完整／简易显示和最终回答判定。
- DeepSeek Harness：消息轨迹含义、数据来源和支持边界。
- AgentManor：历史适配器、消息保留、来源发现、索引与查询的现有能力。
- 三者会话统计中的模型、Token、缓存及 Skill／MCP／Tool 证据与指标定义。

## Acceptance

- 以本地源码与文档为依据，记录版本、关键位置和未确认项；不以产品名推断能力。
- 把其他客户端历史无法重建的信息与可取得消息过程区分开。
- 不修改参考项目、不读取真实私有会话、不公开敏感信息。

## 当前项目核对

- 当前规范化事件为工具活动，`HistoryEvent` 没有完整消息角色、正文轮次、模型或用量字段：`src/contracts.ts:43-59`。
- Codex `token_usage_record` 当前作为已知非工具记录跳过：`src/history/adapters/codex.ts:63-90`。Claude 与 CodeFlicker 也未把普通对话、模型、用量和缓存作为索引对象。
- 来源发现覆盖现有三个客户端，但完整分析结果按已登记仓库保存；未关联来源可只保留元数据：`src/index/refresh.ts:47-110,189-213`、`src/history/index.ts:192-204`。
- 现有 `/events` 为仓库工具事件分页筛选，Web 搜索为文件路径过滤；没有独立全局会话目录或消息全文检索：`src/server.ts:156-183`、`web/App.tsx:314,345-353`。
- SQLite 当前保存来源缓存、快照 JSON 及分块，尚无消息表／消息文本索引：`src/index/store.ts:56-77,120-140,288-308`。本地服务与数据库基础可沿用，消息索引需补充设计。
- 只查当前代码与声明为合成的 fixtures；样本未包含用量等字段，不能据此断言真实客户端不会记录。原始记录值、估算和缺失边界沿用 `docs/design/metrics-and-evidence.md:83-90`。

## agentsview

本地版本：`1148d7f25e0cd89e3fc1c716e092d76172770a99`。未运行参考应用。

- 会话列表分批加载并虚拟渲染；大于 3000 条消息的会话先取最新 1000 条再向上分页。行内子会话仅请求最多 1000 条，不能把它视为无限完整：`frontend/src/lib/stores/sessions.svelte.ts:594-643`、`frontend/src/lib/stores/messages.svelte.ts:237-302`、`frontend/src/lib/components/content/SubagentInline.svelte:51-85`。
- 跨会话搜索可跳到命中消息；短查询只过滤已加载会话，达到字符阈值才请求后端。会话内搜索会补齐历史，并受 Focused 与内容块过滤影响：`frontend/src/lib/components/command-palette/CommandPalette.svelte:53-102`、`frontend/src/lib/stores/inSessionSearch.svelte.ts:70-102,220-255`。这些限制属于参考行为，不自动成为本项目规格。
- Focused 隐藏工具组和中途通知，按顺序、工具关系与 provider 标记保留候选最终回答，是启发式选择：`frontend/src/lib/utils/transcript-mode.ts:19-89`。思考和工具输入／输出默认折叠。
- 会话模型徽标选择出现最多的模型；用量可按步骤展示，成本区分报告值与估算。会话面板不提供缓存命中率：`frontend/src/lib/utils/model.ts:3-24`、`frontend/src/lib/components/layout/SessionBreadcrumb.svelte:264-292,317-388`。
- Usage 缓存比例为缓存读取除以缓存读取加未缓存输入，未纳入缓存写入；另一 Stats API 针对 Claude 的分母纳入缓存写入。两种口径不能直接混用：`internal/service/usage.go:539-554`、`internal/db/session_stats.go:952-977,1035-1056`。
- 工具统计来自 tool_calls；Skill 名可由明确参数或读取 SKILL.md 推断，不能都视为已确认执行；MCP 分类依赖各 parser：`internal/db/analytics.go:3067-3125`、`internal/parser/skill_inference.go:39-83`、`internal/parser/taxonomy.go:70-76`。

## DeepSeek Harness

本地版本：`5badb15009ae1756c3afe0ae0cef1faafc290ccc`。本轮仅参考交互，不新增该历史来源。

- 轨迹是共享 Session 状态的投影，可展示用户、助手、系统／上下文、工具、subtool 和压缩节点；工具请求与结果按调用身份关联：`packages/client/ui-trajectory/src/client/trajectory-record.ts:8-17`、`packages/client/ui-trajectory/src/client/definitions/trajectory-tool-definition.ts:34-72`。
- step/start 对应模型调用步骤，request/header 等事件记录配置、工具定义和可见上下文材料；不是服务商实际收到的逐字节 HTTP 请求：`packages/core/agent-loop/src/agent.ts:404-436`、`packages/core/session/src/types.ts:234-263`、`docs/subsystems/session.zh.md:181-210`。
- 请求详情展示 provider／model；用量区分未缓存输入、缓存读取、缓存写入、输出和推理，缺失用量显示未报告。未发现缓存命中率或费用统计：`packages/llm/llm/src/types.ts:170-188`、`packages/client/ui-trajectory/src/client/components/TrajectoryTable.tsx:777-829,3121-3149`。
- 思考、压缩与时序来自已记录字段；子 Agent 完整过程位于独立 Session。已有日志缺这些材料时，不能从普通文本补造完整请求轨迹。
- 显式 Skill 工具与 skill-invocation 来源、MCP 名称可提供使用证据，但轨迹没有通用 Skill／MCP 统计面板：`packages/skill/tool-skill/src/index.ts:163-203`、`packages/mcp/mcp-client/README.zh.md:71-85`。

## 补充用量核对

本节于 2026-10-05 补充核对上述本地 agentsview 版本，并查阅 Codex 官方公开协议；官方链接指向可变化的分支，不视为本机客户端已记录这些字段的证明。

| 客户端 | 可取得证据 | 统计约束 |
| --- | --- | --- |
| Codex | 参考 parser 读取模型及 `info.last_token_usage`；官方协议区分 `total_token_usage`、`last_token_usage`，以及响应、轮次与线程用量 | 累计值不逐条求和，不把同一用量的不同呈现重复计入；缓存读取属于输入的子集，不能额外加到总输入 |
| Claude Code | 参考 parser 读取 `message.model`、`message.usage` 的输入、输出、缓存写入与读取；上下文量为输入加缓存写入加缓存读取 | 同一消息可有累计快照或增量块，需按消息身份合并；不同客户端的 input 字段不能直接当作相同分母 |
| CodeFlicker | 本项目与合成样本已取得时间、消息和工具记录结构，未取得模型／用量格式依据 | 真实历史的模型、缓存及用量字段仍待核验；当前实现未提取不等于客户端未记录 |

- 本地 Codex parser 的最近一次用量读取与相邻 payload 摘要去重：`internal/parser/codex.go:557-593`、`internal/parser/codex_cursor.go:375-386`。相同用量数值本身不是请求身份，不能把参考摘要策略直接视为完整去重方案。
- 本地 Claude 同消息合并及模型／用量提取：`internal/parser/claude.go:2048-2093,2728-2762`。合并需区别流式快照与独立内容块，不能把每条流式记录当作独立请求用量。
- [Codex 官方协议](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs) 定义了累计、最近一次及响应／轮次／线程用量，并以输入减缓存读取得到未缓存输入；[重复用量报告问题](https://github.com/openai/codex/issues/14489) 展示某些历史版本因限流更新重复发射用量的风险。后者是公开问题报告，不据此断言所有当前版本仍有同一问题。
- 后续真实验收需检查字段存在性、版本和计数粒度；缺少关联证据时，不强行将会话级用量分摊到具体步骤、Skill 或 MCP。输出与推理 Token 若属于包含关系，也不能直接相加。

## Answer

- 建议借鉴分页、虚拟消息列表、过程折叠和步骤联动；具体范围及显示语义仍由需求讨论决定。
- 需要补充独立全局会话、消息与用量索引；现有仓库工具事件查询不足以覆盖新需求。
- 最终回答、缓存比例、Skill／MCP 使用与 Token 估算必须定义口径，不直接继承参考项目启发式或混用不同统计分母。
- 参考行为结论来自上述本地版本的代码与文档，用量补充另查 Codex 官方公开协议；未进行参考应用运行验证，未检查真实私有历史的字段覆盖率。
