# agent-guardian 复用评估

核验日期：2026-10-03。本地源码基线为 [`230ffe4b4021a9fa3f4d3c5d1c7d3247fd9059bc`](https://github.com/lolipop-1x1/agent-guardian/commit/230ffe4b4021a9fa3f4d3c5d1c7d3247fd9059bc)。相关解析、分析、地图、CLI 与账本文件没有工作区改动；仓库其他文件存在未提交改变。本轮只读核验，没有构建、运行验收或读取真实会话。

agent-guardian 仍是开发中的外传保护项目，只作复用参考。项目边界见 [ADR 0001](../adr/0001-independent-project-boundary.md)。

## 可复用和需重建部分

| 分类 | 现有能力或思路 | 对 AgentManor 的含义 |
| --- | --- | --- |
| 可评估复用 | Codex rollout 格式识别、文本提取、未知项和历史覆盖缺口报告 | 可提供格式处理经验；不等于已有完整事件解析器 |
| 可评估复用 | 源码快照、内容版本、确定性片段匹配、重复代码歧义处理 | 可用于源码预览和历史内容定位；不等于读取统计 |
| 可评估复用 | 路径边界、内容版本校验、按需源码下钻、文件地图展示 | 可作为安全读取与可视化原型；接口和 UI 技术需重新评估 |
| 需要独立建设 | 工具请求/结果模型、Skill/MCP 归属、调用统计 | 当前历史解析显式跳过工具调用，不能直接提供这些指标 |
| 需要独立建设 | 多客户端发现、跨会话搜索、活动聚合与增量索引 | 源码文本匹配和持久账本不能替代这些能力 |
| 需要独立建设 | 配置盘点、项目级建议、停用、隔离、恢复和状态核验 | 现有保护审批流程不是客户端配置管理流程 |
| 保持职责独立 | 请求网关、系统观察、外传审批、网络出口与提交账本 | 属于外传保护验收范围；避免成为历史管理的前置依赖 |

## 源码证据

- [history.rs](https://github.com/lolipop-1x1/agent-guardian/blob/230ffe4b4021a9fa3f4d3c5d1c7d3247fd9059bc/core/src/history.rs#L27) 要求单个 Codex rollout JSONL，提取消息和工具输出文本；[response_item 分支](https://github.com/lolipop-1x1/agent-guardian/blob/230ffe4b4021a9fa3f4d3c5d1c7d3247fd9059bc/core/src/history.rs#L78) 跳过 function_call、custom_tool_call 和 reasoning 等记录。
- [analysis.rs](https://github.com/lolipop-1x1/agent-guardian/blob/230ffe4b4021a9fa3f4d3c5d1c7d3247fd9059bc/core/src/analysis.rs#L149) 做历史文本与当前源码的范围匹配；[FileMap 初始化](https://github.com/lolipop-1x1/agent-guardian/blob/230ffe4b4021a9fa3f4d3c5d1c7d3247fd9059bc/core/src/analysis.rs#L339) 将 tool_read_count、system_open_count 和 system_write_count 设为 None。
- [CLI](https://github.com/lolipop-1x1/agent-guardian/blob/230ffe4b4021a9fa3f4d3c5d1c7d3247fd9059bc/core/src/bin/guardian.rs#L21) 的 map/source 提供源码快照分析及版本校验下钻；[C ABI](https://github.com/lolipop-1x1/agent-guardian/blob/230ffe4b4021a9fa3f4d3c5d1c7d3247fd9059bc/core/src/lib.rs#L36) 让原生宿主使用同一查询。
- [ProjectMapView.swift](https://github.com/lolipop-1x1/agent-guardian/blob/230ffe4b4021a9fa3f4d3c5d1c7d3247fd9059bc/macos/App/ProjectMapView.swift#L108) 展示地图与范围高亮，[未知提示](https://github.com/lolipop-1x1/agent-guardian/blob/230ffe4b4021a9fa3f4d3c5d1c7d3247fd9059bc/macos/App/ProjectMapView.swift#L140) 没有把缺失读取证据当成零。

history_occurrences 是匹配到某文件的历史文本记录数，重复可见文本不等于重复实际读取。会话可见源码、当前版本匹配、真实工具读取和已确认外发应继续区分。

## 旧说明与当前源码的差异

[历史地图开发说明](https://github.com/lolipop-1x1/agent-guardian/blob/230ffe4b4021a9fa3f4d3c5d1c7d3247fd9059bc/docs/development/history-map.md#L17) 写着持久账本、30 天明细和跨会话统计待实现。这条描述已经落后于本次检查的源码。

当前 [ledger.rs 历史导入](https://github.com/lolipop-1x1/agent-guardian/blob/230ffe4b4021a9fa3f4d3c5d1c7d3247fd9059bc/core/src/ledger.rs#L413) 已保存历史来源，[地图查询](https://github.com/lolipop-1x1/agent-guardian/blob/230ffe4b4021a9fa3f4d3c5d1c7d3247fd9059bc/core/src/ledger.rs#L476) 有按项目快照合并历史范围及 30 天事件明细维护，CLI 也有相关命令。应描述为“已有持久账本源码能力，当前未做独立运行验收”，而不是“没有任何持久化”。

这些能力服务于来源、匹配范围和保护证据，不等于已具备工具调用统计、统一检索或配置生命周期管理。复用账本思路与直接依赖现有保护账本是不同方案。

## 验收与实现边界

开发说明记录了合成源码匹配、路径越界、版本变化、分页文本和原生地图等验收。这些是原项目记录的有限证据，不是本次重跑结果，也不代表大仓性能、多客户端兼容或完整产品可用。

拆分前应选定原始事件和查询场景，检查哪些模块可独立于保护类型与原生宿主使用，再决定复制、提取共享包或只借鉴设计。Rust/Swift、Network Extension、签名和 Mac 首版约束不自动成为 AgentManor 的选择。

本次只写复用评估，没有抽离代码、创建共享依赖或修改 agent-guardian。
