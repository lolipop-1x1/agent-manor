# AgentManor

本地优先的 Agent 管家：看懂 Agent 的历史，打理 Agent 的环境。

面向使用多种 AI 编程客户端的开发者，统一查看配置与使用历史，并根据可回查的证据整理 Skill、MCP 和项目活动。

## 项目状态

项目处于初始化和需求研究阶段，尚无可运行功能。本文档中的产品能力是方向或候选范围，不是已实现功能。开源许可证尚未选定。

已确定项目名称、独立仓库和本地优先定位。首版产品规格已确认：聚焦 Codex／Claude Code 历史在当前仓库中的代码活动地图，采用本地后台、Web、CLI 与 Skill，先在 macOS 验收。语言、存储和 UI 技术尚未选择。

## 文档导航

| 阅读目的 | 文档 |
| --- | --- |
| 理解目标用户、产品方向、首版建议和验证标准 | [产品定位与范围](docs/product/vision-and-scope.md) |
| 查看当前代码活动地图的首版规格与验收标准 | [首版规格](.scratch/repository-activity-map/spec.md) |
| 统一需求、统计和界面用语 | [领域术语](CONTEXT.md) |
| 了解独立于外传保护的项目边界 | [ADR 0001](docs/adr/0001-independent-project-boundary.md) |
| 了解 Web、CLI 和 Skill 共用本地后台的决定 | [ADR 0002](docs/adr/0002-local-analysis-service.md) |
| 查看市场已有能力和差异化假设 | [竞品全景](docs/research/competitive-landscape-2026-10-03.md) |
| 深入了解 agentsview、cass 的功能与证据 | [重点项目分析](docs/research/agentsview-and-cass.md) |
| 比较历史驱动的 Skill/MCP 管理项目 | [Skill/MCP 管理调研](docs/research/skill-mcp-management.md) |
| 定义调用、文件活动、覆盖率和成本统计 | [指标与证据口径](docs/design/metrics-and-evidence.md) |
| 评估 agent-guardian 中可复用部分 | [复用评估](docs/research/guardian-reuse-assessment.md) |
| 导入 XMind 查看功能结构 | [agentsview 导图](docs/research/function-maps/agentsview.md)、[cass 导图](docs/research/function-maps/cass.md) |

## 阅读约定

研究文档标注调查日期，并区分项目声明、源码核验和运行验证。Star 与创建时间是元数据快照；当前没有竞品运行验收或用户需求验证的结论。

术语由 `CONTEXT.md` 定义，统计规则由指标文档定义，项目边界由 ADR 记录。工程协作和本地任务跟踪沿用 [AGENTS.md](AGENTS.md)。
