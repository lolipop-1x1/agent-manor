# 历史驱动的 Skill / MCP 管理调研

调查与元数据核验日期：2026-10-03。下表 Star 来自 GitHub 仓库接口，是当日快照。功能依据 README 与抽样源码，未安装这些产品，也未验证它们对当前客户端配置的实际修改效果。

## 已有项目

| 项目 | Star | 历史与统计 | 管理动作及边界 |
| --- | ---: | --- | --- |
| [skillreaper](https://github.com/thousandflowers/skillreaper) | 59 | 解析 Skill、Agent 与 MCP 调用；按窗口生成 KEEP / MUTE / REAP 建议 | Skill 隔离和恢复、描述静音、MCP 注册移除与恢复；各客户端覆盖需要分别验证 |
| [skill-kit / skillkit](https://github.com/crafter-station/skill-kit) | 77 | 多客户端 Skill 扫描、使用记录与上下文估算 | 默认预览；确认参数可删除目录，没有统一的自动备份与恢复流程 |
| [codex-skill-admin](https://github.com/zjp1997720/codex-skill-admin) | 11 | Codex 会话和归档中的 SKILL.md 路径证据，统计使用会话数 | 通过 app-server 接口停用和重新启用 Skill，保留备份与审计记录 |
| [skill-graveyard](https://github.com/sfrangulov/skill-graveyard) | 10 | Claude 的显式 Skill 调用及结果，估算闲置描述成本 | 默认预览；apply 尝试移除用户/共享 Skill 链接，插件项给出手动说明 |
| [prune-skills](https://github.com/Trkzi-Omar/prune-skills) | 4 | Claude/Codex 文本标记；大小、行数和使用提示 | 快照、隔离、恢复及清除；快照需要单独执行，使用证据不是通用结构化解析 |
| [token-optimizer-mcp](https://github.com/cocaxcode/token-optimizer-mcp) | 3 | Claude hook 捕获后续调用，SQLite 汇总 MCP 服务器使用情况 | 生成 allowlist、备份和回滚；写入的是审批配置，实际停用效果未确认 |
| [mcp-optimizer](https://github.com/o8n/mcp-optimizer) | 0 | Claude hook 捕获后续调用，按次数和最后使用时间找候选 | dry-run / apply 与备份；hook 字段和停用配置存在客户端兼容疑点 |
| [tokenscope](https://github.com/HduSy/tokenscope) | 249 | Claude 历史中的 Skill/MCP 调用、Token 和时间分布 | 主要是观察与分析，未发现对 Skill/MCP 配置的清理入口 |
| [claude-skill-cleaner](https://github.com/YuzuruS/claude-skill-cleaner) | 5 | 只读审计；显式调用、文件读取和文本提及等证据 | 输出报告与候选；项目明确不执行删除 |

这些项目已经覆盖“历史统计 → 闲置建议 → 某种配置调整”的部分流程。因此，历史清理本身不能作为 AgentManor 独有能力。更值得验证的是跨客户端的配置归属、可信的观测覆盖、项目范围、操作预览和可恢复性。

## 重点项目的实现区别

### skillreaper：最接近统一环境整理

本节源码固定到 [`1cfd85dce3ac922df37ff4c86f281ae3f695c8d8`](https://github.com/thousandflowers/skillreaper/tree/1cfd85dce3ac922df37ff4c86f281ae3f695c8d8)。默认观测 30 天，并使用最少会话数和安装宽限期保护新资源。Skill 的自动静音还结合估算描述大小与调用/会话比；该比值不是“使用过它的不同会话占比”。MCP 已使用则保留，未使用满足保护规则后可成为移除候选，不是统一的低频 MCP 静音。见 [判定规则](https://github.com/thousandflowers/skillreaper/blob/1cfd85dce3ac922df37ff4c86f281ae3f695c8d8/internal/report/verdict.go#L88)。

Skill 隔离会移动文件并记录原位置，恢复依赖清单。静音修改 frontmatter 描述；正文仍在，但是否继续被客户端发现需要运行验证。MCP 操作备份 JSON、移除对应 mcpServers 注册，再支持恢复；这不等于卸载服务器。Codex TOML、插件来源与 JSONC 等配置不能自动视为同样可处理。见 [隔离与 MCP 修改](https://github.com/thousandflowers/skillreaper/blob/1cfd85dce3ac922df37ff4c86f281ae3f695c8d8/internal/prune/prune.go#L107)、[静音实现](https://github.com/thousandflowers/skillreaper/blob/1cfd85dce3ac922df37ff4c86f281ae3f695c8d8/internal/mute/mute.go#L171)和 [MCP 配置扫描](https://github.com/thousandflowers/skillreaper/blob/1cfd85dce3ac922df37ff4c86f281ae3f695c8d8/internal/scan/mcp.go#L101)。

覆盖方面，Claude、Codex、Hermes JSONL 使用[相同的读取路径](https://github.com/thousandflowers/skillreaper/blob/1cfd85dce3ac922df37ff4c86f281ae3f695c8d8/cmd/reap/main.go#L564)，而[解析器](https://github.com/thousandflowers/skillreaper/blob/1cfd85dce3ac922df37ff4c86f281ae3f695c8d8/internal/usage/usage.go#L176)依赖 message.content 内的 tool_use。Codex 原生 response_item 格式不能仅凭扩展名和项目声明视为已覆盖。OpenCode 有独立数据库路径，仍未实测。安装清单也不能证明每次请求真的加载了全部描述；[成本估算](https://github.com/thousandflowers/skillreaper/blob/1cfd85dce3ac922df37ff4c86f281ae3f695c8d8/internal/cost/cost.go#L78)使用字符比例，不是 API 实测省费。

### skillkit：客户端范围广，但清理恢复较弱

源码[注册了 14 类连接器](https://github.com/crafter-station/skill-kit/blob/main/packages/cli/src/scanner/registry.ts#L33)，不代表每类使用信号都具有相同精度。Claude/OpenCode 可利用结构化 Skill 事件；[Codex 解析](https://github.com/crafter-station/skill-kit/blob/main/packages/cli/src/scanner/connectors/codex.ts#L37)从命令参数中的 SKILL.md 路径推断，并按来源文件收集使用信息，不能直接当作每次显式调用。

[prune](https://github.com/crafter-station/skill-kit/blob/main/packages/cli/src/commands/prune.ts#L119) 默认展示计划，带确认参数后可递归删除普通 Skill 目录，另处理 skills.sh 链接、锁文件和规范目录；插件来源跳过。未发现通用的自动备份与恢复闭环。[上下文估算](https://github.com/crafter-station/skill-kit/blob/main/packages/cli/src/commands/context.ts#L21)区分描述和按需正文，但“可回收”正文大小不能等同每次请求节省的 Token。

### codex-skill-admin：停用而非物理删除

独立仓库是技能发布入口；实际脚本来源为 [zhijian-skills 中的 codex_skill_admin.py](https://github.com/zjp1997720/zhijian-skills/blob/main/skills/codex-skill-admin/scripts/codex_skill_admin.py)。它扫描 Codex 会话和归档，用 SKILL.md 绝对路径找使用记录，统计的是不同来源文件/会话数；仅有函数参数不能证明对应读取成功。

默认 dry-run，排除系统与手动保留项。apply 先保存候选、配置与审计材料，再调用 skills/config/write 将 enabled 设为 false，恢复时重新启用。它不删除 Skill 目录；当前用户客户端版本是否支持该接口尚未验证。

### skill-graveyard 与 prune-skills：信号和恢复方式不同

skill-graveyard 使用 Claude 的显式 Skill tool_use，并关联结果。源码判定活跃时仍包含失败调用，不能把 README 中的“成功使用”直接带入指标；文件更新时间预筛也不是逐事件时间窗口。清理主要尝试 unlink 用户或共享入口，普通目录可能不能如此删除；没有自动恢复流程。见 [解析](https://github.com/sfrangulov/skill-graveyard/blob/main/packages/core/src/parser.ts#L164)与 [清理](https://github.com/sfrangulov/skill-graveyard/blob/main/packages/skill-graveyard/src/prune.ts#L48)。描述 Token × 未调用会话数属于加载假设下的估计，不能当作实际账单浪费。

prune-skills 从历史文本中的 Using `skill-name` 标记找使用提示，没有可用标记时停止使用判定。快照需要单独执行；隔离保存原位置并支持恢复，purge 则删除隔离内容。见 [使用信号](https://github.com/Trkzi-Omar/prune-skills/blob/main/scripts/usage.sh#L158)与 [管理命令](https://github.com/Trkzi-Omar/prune-skills/blob/main/scripts/prune.sh#L53)。行数和字节大小可用于排序，但不是实际上下文占用。

### 两个 MCP 优化器：需补客户端生效验证

token-optimizer-mcp 使用 Claude PostToolUse hook 记录安装之后的调用，不能自动回填全部旧历史。它按近 14 天使用情况形成服务器 allowlist，并提供备份、回滚和前后样本统计。[prune 实现](https://github.com/cocaxcode/token-optimizer-mcp/blob/master/src/cli/prune-mcp.ts#L50)写入 .claude/settings.local.json 的 enabledMcpjsonServers，且服务器盘点不读取所有 .mcp.json 来源。该字段用于项目 MCP 审批，与停用字段不同，因此不能确认输出 allowlist 后所有其他服务器都已停用。

mcp-optimizer 按累计调用低于阈值或较久未使用筛选，零调用项不一定具有足够观测期。[修改器](https://github.com/o8n/mcp-optimizer/blob/main/src/core/config-writer.ts#L64)写入 server.disabled，而 [hook 记录](https://github.com/o8n/mcp-optimizer/blob/main/src/commands/track.ts#L78)依赖 project_dir。这些字段与核验时 Claude 官方配置和 hook 的 cwd 说明存在差异，需要真实验证；其预置 Token 数也不是逐请求测量。

以上兼容判断依据 Claude 官方 [MCP 停用说明](https://code.claude.com/docs/en/mcp#disable-a-server-without-removing-it)与 [PostToolUse 输入说明](https://code.claude.com/docs/en/hooks#posttooluse-input)。这是源码与文档对照结果，没有运行失败结论。历史采集成功、配置文件成功写入、客户端实际停用是三项不同验收。

### tokenscope 与 claude-skill-cleaner：观察和审计方向

tokenscope 从 Claude 历史增量汇总 Skill/MCP 与用量，可参考其 [存储](https://github.com/HduSy/tokenscope/blob/main/src-tauri/src/store.rs#L182)和 [解析](https://github.com/HduSy/tokenscope/blob/main/src-tauri/src/parser.rs#L209)。内部数据的 prune 不等于删除用户 Skill 或 MCP。

claude-skill-cleaner 的 [审计脚本](https://github.com/YuzuruS/claude-skill-cleaner/blob/main/scripts/skill-cleaner.ts)区分显式调用、文件读取和弱文本信号，输出报告而不删除资源。字节比例 Token 估算仍需保留估计标签。

## 对 AgentManor 的建议

管理价值需要建立在可信证据上，优先验证下面的流程，具体首版范围仍待确认。

1. 盘点来源、作用范围、共享引用和客户端支持情况，避免仅以名称归并配置。
2. 先展示观测窗口、有效会话数、解析覆盖和证据强弱，再生成闲置或低频候选。
3. 为候选解释“在哪个项目、多久没观察到、历史是否完整”，同时保留调用失败和冷门关键用途。
4. 预览具体操作，区分停用、隔离、移除注册与永久删除；优先验证可恢复的调整。
5. 检查客户端实际状态及恢复效果，不能只确认配置写入成功。配置后来发生变化时，恢复不能静默覆盖用户新改动。

统计细节只在 [指标与证据口径](../design/metrics-and-evidence.md)维护。调用次数可以回答使用频率，不能直接证明 Skill 被有效遵循，也不能单凭低频认定应删除。渐进加载、工具搜索、缓存和客户端配置范围均会影响实际上下文收益。

## 研究边界

本轮是公开项目样本调查，没有得出“市场上不存在完整方案”的结论。除 skillreaper 外，上述源码链接为核验时分支入口，后续可能变化；实施前需要固定提交并用获准的样本重测。Star 高低不能替代功能验收、活跃度或用户需求判断，许可证也应在代码复用前逐项核对。
