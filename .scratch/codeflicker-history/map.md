# CodeFlicker 历史接入讨论

Type: task
Status: claimed

日期：2026-10-04。目标是在现有代码活动地图中支持 CodeFlicker；本轮先明确需求与证据边界，不代表已经实现。

## 设计树

1. 产品范围：已确认 C1。
   - 接入 Agent 会话的读取、修改、活动次数、证据回查及 Web／CLI 筛选。
   - 代码补全与编辑预测不纳入本轮。
2. 采集边界：已确认 C2。
   - 只读分析已有本机历史，缺少证据时保留采集缺口。
   - 本轮不增加采集 Hook；额外采集作为后续独立功能。
3. 历史来源与格式：正在只读核查。
   - 本机持久会话来源、格式版本、工具调用与结果配对。
   - 客户端归属、父子会话、分叉与跨仓库活动。
   - 原始证据能够支持的读取内容和修改范围。
4. 接入方案和真实验收：依赖以上结论。
   - 新客户端贯通发现、解析、API、CLI、Web 与证据回查。
   - 已知样本与真实仓库分别验收，重复刷新不增加同一活动次数。
5. 更多客户端扩展：已确认 C3。
   - 集中客户端声明与内置适配器注册，共用统计、匹配和查询层。
   - 同一历史格式可以复用，客户端身份保持独立。
   - 本轮不支持可单独安装的第三方插件。
6. 首版历史范围：本次实施授权采用推荐 C4。
   - 先覆盖 `~/.codeflicker/projects` 主会话及能确认关系的子会话。
   - `requests/` 不独立计数，SQLite 与 MyFlicker 作为后续独立格式候选。

## 已作决策

- 用户明确提出新增 CodeFlicker 支持，并调用 `grill-with-docs` 讨论需求。
- 延续 [现有领域术语](../../CONTEXT.md) 与 [本地分析服务决策](../../docs/adr/0002-local-analysis-service.md)；尚未提出替换架构的决定。
- C1：Agent 会话读写与现有全部查询入口；CodeFlicker 独立筛选，沿用精确／近似口径。
- C2：只读已有本机历史，缺失保留采集缺口；本轮不增加采集 Hook。
- 用户要求整体架构方便后续接入更多 Code Agent，纳入本次接入设计。
- C3：采用内置适配器注册，统一贯通各入口；历史格式与客户端身份分别表示，暂不增加第三方插件加载机制。
- 2026-10-05：用户授权开始开发，采用 C4 推荐范围；要求扩展性、数据正确性、端到端测试与完成后推送。按照此前直接在 main 开发的要求集成，子任务使用隔离 worktree。

- 2026-10-05：02 完成客户端声明与格式适配边界；[客户端接口](../../src/clients.ts)、[格式接口与内置注册](../../src/history/adapters/index.ts) 供 03 / 04 扩展。Codex / Claude 解析身份与证据保持基线一致，历史与索引 60 项回归通过；CodeFlicker 具体格式和端到端验收由后续任务完成。

## 待澄清问题

- 格式相关问题先核对环境事实，再确定下一轮需要用户选择的事项。
- C4 推荐范围已作为本次实施范围；SQLite 与 MyFlicker 后续独立适配。

## 已核对事实

- 当前 `Client` 只有 `codex` 和 `claude`；发现根、解析分支、API 客户端校验、CLI 帮助及 Web 筛选均需贯通第三客户端。
- Web 的部分客户端标签把所有非 Codex 值显示成 Claude Code；新增客户端时须显式处理显示名称，避免错误归属。
- 通用事件、原始记录引用、工具证据、覆盖与内容对应模型可以沿用；相同历史格式或工具名不证明属于同一个 Agent 客户端。
- 本机已发现 `~/.codeflicker/projects` 持久 JSONL，包含项目会话、`requests/` 与 `agent-*.jsonl`。代表主会话使用 `config/message` 记录；样本有 `sessionId`、`uuid`、`parentUuid`、`promptId`、`version`，未见 `cwd`。
- 代表主会话中 33 个 `tool_use` 与 33 个 `tool-result` 可通过 `id`／`toolCallId` 配对；结果包含 `llmContent`、`returnDisplay` 等字段，已核对物理行与记录哈希可回查。1 个结果有 `isError=true`，其余 32 个未明确标成功或失败；成功语义尚待核对，不能凭结果出现默认成功。
- 样本中的工具有 `read`、`bash`、`grep`。本轮尚未确认真实执行中的编辑前后内容；请求记录中的 `old_string/new_string` 不证明它们是实际执行的修改。
- 同项目 `requests/` 的样本可通过 `promptId` 与主会话关联，含模型请求体与响应头；不能把其中重放的内容当成独立工具执行。首版推荐只以执行记录计数。
- `agent-*.jsonl` 存在会话和工具字段；精确父子关系与分叉去重仍待核对。归档位置也尚未确认。
- 另有 `~/.codeflicker/data/codeflicker/session_data.sqlite`、`data/vscode/session_data.sqlite` 和 `~/.myflicker/sessions`，与主 JSONL 的身份及重复关系未确认；暂不能统一导入。
- CodeFlicker 主 JSONL 的消息包装与结果结构区别于 Claude；客户端身份与格式适配器分别表示。MyFlicker 的代表样本具有 Claude 风格结构，但尚未确认它和 CodeFlicker 的产品关系。
- SQLite 保存通用 JSON，没有按客户端固定列或 SQL CHECK；仅新增客户端身份无需数据库表结构迁移。
- 来源根配置以普通对象经 `workerData` 传给 Worker。适配器实现由 Worker 加载，不将函数放入 Worker 配置。
- 当前证据回查使用物理行与记录哈希；适配边界需要包含来源引用与原始证据回读，避免以后在查询层写入更多格式分支。

相关代码：`src/contracts.ts`、`src/history/types.ts`、`src/history/index.ts`、`src/service/input.ts`、`src/cli.ts`、`web/App.tsx`。本轮尚未运行 CodeFlicker 解析或真实仓库验收。

来源核查是代表样本调查，没有全量解析历史；目录清点不代表这些记录均可进入覆盖统计。验收仓库须从实际来源元数据或路径证据确定，不能只反解项目目录 slug。本轮发现 AgentManor 名称未匹配到 CodeFlicker 项目目录，不能用本仓库现有 Codex 结果代替 CodeFlicker 验收。

## 推荐接入边界

- 客户端声明：稳定 ID、显示名称及可供 Web／CLI／API 共用的客户端信息。
- 客户端来源发现：默认目录、显式目录配置和来源归属。
- 历史格式适配：元数据、调用与结果配对、增量状态、父子关系、原始记录引用与证据回读。
- 工具证据转换：按实际字段提取成功、失败、缺失、读取、修改和搜索证据；能够复用通用规则时复用。
- 分析核心：继续统一处理仓库归属、内容对应、去重覆盖、结果版本与查询，不依赖原始客户端格式。
- 验收：增加客户端注册时，Web／CLI／API 可获取同一客户端信息；新适配器有独立格式样本和真实闭环，已有客户端行为保持一致。

## 任务

- [01：来源核查与接入需求](issues/01-requirements.md)
- [02：客户端与格式适配边界](issues/02-client-adapters.md)
- [03：CodeFlicker 原始历史](issues/03-codeflicker-parser.md)，依赖 02。
- [04：查询入口](issues/04-query-entrypoints.md)，依赖 02。
- [05：数据正确性与端到端验收](issues/05-validation.md)，依赖 03、04。
