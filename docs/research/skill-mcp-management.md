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

管理价值需要建立在可信证据上，优先验证下面的流程。下列为初始调研建议，已确认的首版范围见 [资源管理规格](../../.scratch/resource-management/spec.md)。

1. 盘点来源、作用范围、共享引用和客户端支持情况，避免仅以名称归并配置。
2. 先展示观测窗口、有效会话数、解析覆盖和证据强弱，再生成闲置或低频候选。
3. 为候选解释“在哪个项目、多久没观察到、历史是否完整”，同时保留调用失败和冷门关键用途。
4. 预览具体操作，区分停用、隔离、移除注册与永久删除；优先验证可恢复的调整。
5. 检查客户端实际状态及恢复效果，不能只确认配置写入成功。配置后来发生变化时，恢复不能静默覆盖用户新改动。

统计细节只在 [指标与证据口径](../design/metrics-and-evidence.md)维护。调用次数可以回答使用频率，不能直接证明 Skill 被有效遵循，也不能单凭低频认定应删除。渐进加载、工具搜索、缓存和客户端配置范围均会影响实际上下文收益。

## 研究边界

本轮是公开项目样本调查，没有得出“市场上不存在完整方案”的结论。除 skillreaper 外，上述源码链接为核验时分支入口，后续可能变化；实施前需要固定提交并用获准的样本重测。Star 高低不能替代功能验收、活跃度或用户需求判断，许可证也应在代码复用前逐项核对。

## agentsview 与 skills-manager：补充核验

核验日期：2026-10-07。下面依据本地参考仓库的固定提交只读检查，没有运行参考软件或验证其在本机的管理效果。

### agentsview：历史分析

固定提交：`1148d7f25e0cd89e3fc1c716e092d76172770a99`。

分析看板确有工具统计、Skill 排行和趋势实现；列表最多展示八项，趋势按前六项与 Other 汇总。见 [分析页面](https://github.com/kenn-io/agentsview/blob/1148d7f25e0cd89e3fc1c716e092d76172770a99/frontend/src/lib/components/analytics/AnalyticsPage.svelte#L728)、[Skill 列表](https://github.com/kenn-io/agentsview/blob/1148d7f25e0cd89e3fc1c716e092d76172770a99/frontend/src/lib/components/analytics/TopSkills.svelte#L81)和 [趋势](https://github.com/kenn-io/agentsview/blob/1148d7f25e0cd89e3fc1c716e092d76172770a99/frontend/src/lib/components/analytics/SkillTrend.svelte#L12)。

统计从历史工具记录按 Skill 名称聚合，解析器也会根据 SKILL.md 路径推断名称；它没有用当前安装清单补齐零调用项，因此不能据此判断某个已安装 Skill 从未使用。见 [统计查询](https://github.com/kenn-io/agentsview/blob/1148d7f25e0cd89e3fc1c716e092d76172770a99/internal/db/analytics.go#L3103)和 [名称推断](https://github.com/kenn-io/agentsview/blob/1148d7f25e0cd89e3fc1c716e092d76172770a99/internal/parser/skill_inference.go#L376)。自有记忆 Skill 的安装入口与归档 MCP 服务不等于通用的第三方资源管理。

### skills-manager：本地清单与部署

固定提交：`200ab519afbba7cbad3cfebb6e4a853399db9904`。

扫描器发现含 SKILL.md 的资源，保存来源路径及内容指纹，按名称与指纹归组；导入复制到中心库，部署可使用链接或复制。可参考它对用户、Agent、项目来源及部署状态的分层，但管理身份仍需区分真实目标与入口，不能只靠内容相同合并。见 [扫描](https://github.com/xingkongliang/skills-manager/blob/200ab519afbba7cbad3cfebb6e4a853399db9904/src-tauri/src/core/scanner.rs#L88)、[导入](https://github.com/xingkongliang/skills-manager/blob/200ab519afbba7cbad3cfebb6e4a853399db9904/src-tauri/src/commands/scan.rs#L14)和 [部署](https://github.com/xingkongliang/skills-manager/blob/200ab519afbba7cbad3cfebb6e4a853399db9904/src-tauri/src/core/sync_engine.rs#L260)。

页面的 Available 表示未加入当前选中的配置组合，不表示未使用；只读源码检查未发现基于真实 Skill 调用次数的统计。见 [页面筛选](https://github.com/xingkongliang/skills-manager/blob/200ab519afbba7cbad3cfebb6e4a853399db9904/src/views/MySkills.tsx#L285)。

项目停用会移入备用目录并可恢复；中心库删除会处理记录的部署入口和中心副本，项目删除则删本地文件。Git 备份针对中心库快照，不能直接当作任意客户端来源的通用回收区。见 [项目停用与恢复](https://github.com/xingkongliang/skills-manager/blob/200ab519afbba7cbad3cfebb6e4a853399db9904/src-tauri/src/commands/projects.rs#L326)、[中心库删除](https://github.com/xingkongliang/skills-manager/blob/200ab519afbba7cbad3cfebb6e4a853399db9904/src-tauri/src/commands/skills.rs#L743)、[项目删除](https://github.com/xingkongliang/skills-manager/blob/200ab519afbba7cbad3cfebb6e4a853399db9904/src-tauri/src/commands/projects.rs#L1227)和 [快照恢复](https://github.com/xingkongliang/skills-manager/blob/200ab519afbba7cbad3cfebb6e4a853399db9904/src-tauri/src/core/git_backup.rs#L849)。它还有 [操作记录](https://github.com/xingkongliang/skills-manager/blob/200ab519afbba7cbad3cfebb6e4a853399db9904/src-tauri/src/core/audit_log.rs#L1)，可参考回查交互。

### 对当前规格的影响

- 使用排行来自历史证据，本地清单来自配置发现；两者关联时保留未关联、未知和部分记录，不将未部署解释为未使用。
- 共享链接、同名不同来源、插件管理和作用范围需分别处理；只移动入口不动共用目标。
- 保留完整可查询的统计与分页明细，参考项目的 Top N 展示不是本产品数据上限。
- 每次操作先预览影响并保存恢复材料；备用、回收与永久清除分开，恢复冲突不覆盖用户的新改动。
- 现有画像可识别 Skill 显式调用、成功正文读取及结构化 MCP 调用；外层脚本中的嵌套代码不是独立执行证据。耗时与请求 Token 的归属边界继续沿用指标文档。

当前 Claude 官方文档说明 MCP 的停用选择可按项目保存，插件提供的 MCP 也可单独切换；插件本体的安装、卸载与单资源停用需要分开。因此管理适配需核验实际客户端能力，不将「插件资源」一律视为可改普通文件，也不一律宣称无法单独停用。见 [MCP 停用](https://code.claude.com/docs/en/mcp#disable-a-server-without-removing-it)与 [插件 MCP](https://code.claude.com/docs/en/mcp#plugin-provided-mcp-servers)。

两个参考仓库均为 MIT 许可，复用代码时保留相应许可与版权要求；管理器的许可不代表被管理的第三方 Skill 的许可。见 [agentsview 许可](https://github.com/kenn-io/agentsview/blob/1148d7f25e0cd89e3fc1c716e092d76172770a99/LICENSE)与 [skills-manager 许可](https://github.com/xingkongliang/skills-manager/blob/200ab519afbba7cbad3cfebb6e4a853399db9904/LICENSE)。
