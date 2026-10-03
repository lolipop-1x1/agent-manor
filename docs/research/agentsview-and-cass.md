# agentsview 与 cass：核心功能与证据

调查与元数据核验日期：2026-10-03。功能分析基于下列固定的原始克隆版本；没有安装、运行产品或索引用户真实会话。

## 元数据与版本

| 项目 | Star 快照 | GitHub 创建时间 UTC | 北京时间 UTC+8 | 功能核验基线 |
| --- | ---: | --- | --- | --- |
| [kenn-io/agentsview](https://github.com/kenn-io/agentsview) | 6,041 | 2026-02-19 19:33:24 | 2026-02-20 03:33:24 | `1148d7f25e0cd89e3fc1c716e092d76172770a99`；本地描述为 `v0.44.0-118-g1148d7f2` |
| [Dicklesworthstone/coding_agent_session_search](https://github.com/Dicklesworthstone/coding_agent_session_search) | 1,159 | 2025-11-21 01:22:15 | 2025-11-21 09:22:15 | `fbc174545df641e713ce5c8fea77a455f71644f9`；Cargo.toml 为 `0.10.0` |

元数据来源为两仓库的 GitHub REST 仓库接口：[agentsview](https://api.github.com/repos/kenn-io/agentsview)、[cass](https://api.github.com/repos/Dicklesworthstone/coding_agent_session_search)。创建时间是仓库的 created_at，不代表项目首次发布、开发开始或产品上线时间。

核验时 agentsview 当前 main 与分析基线相同。cass 当前 main 已为 [`306d6e254de767918db41b7f4f28839a77e40932`](https://github.com/Dicklesworthstone/coding_agent_session_search/commit/306d6e254de767918db41b7f4f28839a77e40932)，晚于功能分析版本；本文没有把新提交的能力自动合入旧分析。

## 核心定位

agentsview 将多客户端历史组织成便于人复盘的本地工作台：会话浏览、搜索、工具和文件编辑观察、用量与活动分析，再开放 CLI/API/MCP/Skill。cass 将异构历史组织成可搜索、可回读、可引用的统一档案，主要人工入口为 CLI 和 TUI，并提供 Agent 接口及静态 Web 导出。

| 用户关心的能力 | agentsview 核验结果 | cass 核验结果 |
| --- | --- | --- |
| 历史接入 | 多种客户端、增量同步、导入与来源管理 | 多种连接器、归一化归档与索引、SSH/rsync 来源 |
| 搜索 | 全文、中文、正则；可选语义与混合搜索 | 词法与可选本地语义搜索、默认混合模式、TUI 与自动化输出 |
| 工具调用统计 | 具体工具名、类别、次数和会话数；工具详情与趋势 | Tools 查询按 Agent/workspace 聚合调用量，不能等同具体工具名排行 |
| 文件观察 | Recent Edits 汇总 Edit/Write 并回到源消息 | 可检索文件上下文；未发现逐源码文件读取统计入口 |
| 热图与覆盖 | 日历及每周小时活动热图 | 每日活动 Heatmap；Coverage 指 API Token 测量覆盖 |
| 挖掘 | Quality 规则建议、可选模型洞察、实验 Recall | pack 证据抽取、限定运维类别 incidents、仓库元数据 lessons |
| 人工与 Agent 入口 | Web/桌面、CLI、HTTP API、MCP、Skill | CLI/TUI、Robot JSON、stdio MCP、Skill；Web 主要为导出归档 |

详细功能结构见 [agentsview 导图](function-maps/agentsview.md)与 [cass 导图](function-maps/cass.md)。附件只使用标题层级，可直接作为 XMind Markdown 导入材料；本轮未操作 XMind 或验收导入结果。

## agentsview 的关键证据

以下链接固定到功能核验 SHA。

- [用量接口](https://github.com/kenn-io/agentsview/blob/1148d7f25e0cd89e3fc1c716e092d76172770a99/internal/server/huma_routes_usage.go#L19)：summary、comparison、pairwise、top-sessions 等查询。
- [活动与 analytics](https://github.com/kenn-io/agentsview/blob/1148d7f25e0cd89e3fc1c716e092d76172770a99/internal/server/huma_routes_analytics.go#L19)：时间热图与活动信号入口。
- [Recent Edits](https://github.com/kenn-io/agentsview/blob/1148d7f25e0cd89e3fc1c716e092d76172770a99/internal/db/recentedits.go#L93)：Edit/Write 汇总，不是读取覆盖率。
- [Recall 接口](https://github.com/kenn-io/agentsview/blob/1148d7f25e0cd89e3fc1c716e092d76172770a99/internal/server/huma_routes_recall.go#L35)与 [Recall 文档](https://github.com/kenn-io/agentsview/blob/1148d7f25e0cd89e3fc1c716e092d76172770a99/docs/recall.md)：知识条目、查询、提取、人工审阅与实验边界。
- [MCP](https://github.com/kenn-io/agentsview/blob/1148d7f25e0cd89e3fc1c716e092d76172770a99/internal/mcp/server.go#L24)与 [Skill 安装](https://github.com/kenn-io/agentsview/blob/1148d7f25e0cd89e3fc1c716e092d76172770a99/cmd/agentsview/skills.go#L49)：存在独立 Agent 查询入口。

用量来自客户端记录，成本可能估算。Quality 属于启发式，不能把“completed”或健康分直接当作业务验收。Recall、部分桌面/镜像功能标实验；项目映射工作区需要特定构建开关。可选 embeddings、洞察、分享或远端同步存在数据外发路径，默认本地档案不等于完全离线。

## cass 的关键证据

以下链接固定到原始功能核验 SHA。

- [连接器](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/fbc174545df641e713ce5c8fea77a455f71644f9/src/connectors/mod.rs#L298)与 [README](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/fbc174545df641e713ce5c8fea77a455f71644f9/README.md#L392)：文档列 32 种连接器；Skill 说明仍列 23，存在说明漂移，未实测全部连接器。
- [检索模式](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/fbc174545df641e713ce5c8fea77a455f71644f9/src/search/query.rs#L911)：词法、语义及混合检索；双层渐进搜索当时未启用。
- [Tools 分组](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/fbc174545df641e713ce5c8fea77a455f71644f9/src/analytics/query.rs#L3682)：按 Agent 等维度汇总；[Token Coverage](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/fbc174545df641e713ce5c8fea77a455f71644f9/src/analytics/derive.rs#L13) 是有 API 用量记录的消息比例。
- [MCP 服务说明](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/fbc174545df641e713ce5c8fea77a455f71644f9/docs/SEARCH_SERVICE.md#L314)：search/status/reload/unload 及按配置开放的回读和语义能力；快照需 reload 刷新。
- [lessons 来源](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/fbc174545df641e713ce5c8fea77a455f71644f9/src/lib.rs#L10303)：当前来源是 Git、closed Beads、proof 等元数据，不是自动遍历原始对话提炼任意经验。

其 pack 为带来源的抽取证据包，incidents 类别受限；cass-memory 是另一仓库。静态网站和单会话 HTML 不能直接称为完整实时 Web 分析面板。读取地图“未发现”仅限核对过的产品入口，不证明整个生态不存在实验实现。

## 许可证与借鉴范围

agentsview 的 [LICENSE](https://github.com/kenn-io/agentsview/blob/1148d7f25e0cd89e3fc1c716e092d76172770a99/LICENSE) 为 MIT 文本。

cass 的 [LICENSE](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/fbc174545df641e713ce5c8fea77a455f71644f9/LICENSE#L12) 含额外 Rider，不能只概括为 MIT。文本将 OpenAI、Anthropic、关联方及代表其利益或受其指示的主体列为受限方，要求事先书面许可；对 use 的定义还列举分析、索引、测试、复制、修改等活动，并规定派生作品和分发继续携带 Rider。这里记录许可文本事实，不裁定具体主体是否获授权。

功能对照支持借鉴产品思路，不是把两项目代码直接融合的授权结论。本次文档未复制竞品源码；AgentManor 自身许可证和代码复用方案尚未确定。

## 对 AgentManor 的启示

复盘工作台和统一检索底座分别有清晰价值。AgentManor 可以从配置盘点与使用证据的关联出发，验证管理流程，而不是立即重建两项目全部功能。

代码热点需要独立的文件活动证据、项目基线和版本说明；统计与知识提炼分别呈现。实施前仍需验证中文检索、连接器覆盖、增量去重、性能和管理操作。
