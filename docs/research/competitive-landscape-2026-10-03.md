# Coding Agent 历史与环境管理：竞品全景

调查与整理日期：2026-10-03。范围为公开 GitHub 项目与官方资料；没有竞品安装、性能测试、真实会话导入或用户需求验证。

## 结论

历史归档、搜索、调用统计、文件热点、Web、CLI、Skill/MCP 接口、闲置清理和配置同步均已有相邻或直接项目。不能把这些单项能力当成空白市场。

AgentManor 值得验证的方向是把配置来源、跨项目使用、历史证据和可恢复调整组织成一个持续可用的管家流程。它不是已证明的独有能力或市场缺口，详见 [产品定位与范围](../product/vision-and-scope.md)。

## 项目分组

下表“公开能力”是 README/官方文档声明；标为源码的边界来自同日关键实现核验，不代表运行验证。

| 方向 | 项目 | 公开能力与来源 | 需要保留的边界 |
| --- | --- | --- | --- |
| 多客户端复盘工作台 | [agentsview](https://github.com/kenn-io/agentsview) | 统一归档、会话浏览、检索、工具统计、用量与 Recall | 时间热图与文件地图不同；Recall、部分成本和部署功能标实验，见 [专项](agentsview-and-cass.md) |
| 多客户端检索底座 | [cass](https://github.com/Dicklesworthstone/coding_agent_session_search) | CLI/TUI、混合检索、证据回读、Skill/MCP、静态归档 | Tools 主要按 Agent 汇总，Coverage 是 Token 测量覆盖；许可证带 Rider，见 [专项](agentsview-and-cass.md) |
| 文件活动与规则提示 | [workspace-heatmap](https://github.com/fulf/workspace-heatmap) | 历史 mine、目录/文件热度、未读文档、CLI/HTML | [mine.mjs](https://github.com/fulf/workspace-heatmap/blob/main/src/mine.mjs) 识别工具路径；[report.mjs](https://github.com/fulf/workspace-heatmap/blob/main/src/report.mjs) 未读集合限定 Markdown 文档；调用不自动证明成功 |
| 工具与文件复盘 | [claude-code-devtools](https://github.com/takattowo/claude-code-devtools) | 工具时间线、回放、Web、插件 Skill | [heatmap.ts](https://github.com/takattowo/claude-code-devtools/blob/main/packages/server/src/routes/heatmap.ts) 累计 Read/Write/Edit 和错误；Codex 等在调查时为未来 adapter |
| 规则诊断与统计 | [token-dashboard](https://github.com/nateherkai/token-dashboard)、[claude-view](https://github.com/tombelieber/claude-view)、[checkyouragent](https://github.com/TarekAwwad/checkyouragent)、[sniffly](https://github.com/chiphuyen/sniffly) | Claude 历史、成本/活动分析、错误和行为调查；部分项目有文件热点或洞察 | README 对功能、实验性和来源的说明不同；未全量核验每个项目，也未证明分析等价于任务质量 |
| 历史查询与工作流挖掘 | [claude-historian-mcp](https://github.com/Vvkmnn/claude-historian-mcp)、[agent-history-mcp](https://github.com/Monishkumarvr/agent-history-mcp) | 按文件、错误、工具序列找历史；实体关系和 Skill 候选 | 文本实体和启发式关系不是完整工具事件；Skill 候选不是已生成、验证的 Skill |
| 经验提炼层 | [cass-memory](https://github.com/Dicklesworthstone/cass_memory_system) | 在历史检索之上维护经验、规则和反馈 | 与 cass 是不同项目，不能混入 cass 功能清单 |
| Skill/MCP 使用审计与整理 | [skillreaper](https://github.com/thousandflowers/skillreaper)、[skill-kit](https://github.com/crafter-station/skill-kit)、[codex-skill-admin](https://github.com/zjp1997720/codex-skill-admin) 等 | 历史驱动的候选、停用、隔离或删除 | 解析精度、跨客户端覆盖、恢复能力不同，见 [管理专项](skill-mcp-management.md) |
| Skill/MCP 用量展示 | [tokenscope](https://github.com/HduSy/tokenscope) | Claude 历史、模型/MCP/Skill 拆分和估算成本 | 当前核验未发现低频清理配置；缓存裁剪不是 MCP 移除 |
| 跨客户端配置管理 | [rulesync](https://github.com/dyoshikawa/rulesync)、[agent-rules-sync](https://github.com/dhruv-anand-aintech/agent-rules-sync) | 规则、Skill、MCP 等配置的生成、转换或同步 | 本项以官方 README 声明为依据，本轮未验收同步或历史驱动清理 |

## 从调研得到的设计启示

1. 人工浏览和 Agent 查询可以共享事实，但不同入口的查询能力要分别说明；启动 CLI 不等于完整统计 CLI。
2. 历史回填与安装后采集分开描述。只能看到安装后的调用时，不能据此把之前已使用的配置判为闲置。
3. 文件路径事件、项目文件清单与历史内容匹配分别保留；时间热图不能替代源码读取图。
4. 配置整理需要知道来源和作用范围。多个项目使用不同，不宜用全局低频直接决定单项目调整。
5. 操作是否生效、恢复是否可靠和统计是否完整，需要真实样本对照。代码中存在写配置函数不足以确认管理流程可用。
6. 可选模型分析、共享和远端同步需要说明数据流；本地数据库不代表所有功能完全离线。

## 如何继续验证

在获准的同一份历史与同一项目上，对照少量竞品回答“哪些工具调用最多”“某项在何处使用”“哪些文件反复读取”“怎样恢复调整”等查询。记录正确性、证据定位、缺失能力和完成管理任务所需步骤。

当前研究能确认已有供给和开发者尝试；Star、作者的样例、源码存在或项目数量不能证明持续需求、效果或付费意愿。下一步的用户验证标准见 [产品文档](../product/vision-and-scope.md#验证标准)。

## 资料维护

- 元数据与深入比较只维护在专项文档，避免复制多个会漂移的 Star 表。
- 需要实施时固定源代码版本，并按客户端真实样本复核适配能力。
- 对未检查的功能使用“未确认”，对未找到的入口使用“本次未发现”，不推断整个项目不存在该能力。
