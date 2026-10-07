# 资源来源支持矩阵

本矩阵描述只读盘点能力。盘点读取现有文件，不运行 Skill 脚本、客户端命令或 MCP 服务，不判断运行客户端是否已经加载配置。历史统计覆盖全部已支持客户端；配置来源未核验不等于历史统计为零。

历史统计的逐客户端格式与缺失边界见 [Skill／MCP 历史解析](resource-history-parsing.md)。

## 来源与范围

| 客户端 | Skill 来源 | MCP 来源 | 边界 |
| --- | --- | --- | --- |
| Codex | 用户 `.agents/skills`、兼容 `.codex/skills`；已知项目 `.agents/skills` | 用户／已知项目 `config.toml` 的 `mcp_servers` | 兼容目录表示已发现来源，不承诺全部版本原生加载；项目配置需要客户端信任 |
| Claude Code | 用户／已知项目 `.claude/skills` | 用户 `.claude.json` 的 `mcpServers`、`projects[项目].mcpServers`；项目 `.mcp.json` | 用户、项目私有和项目共享注册分别保留；批准与连接状态不推断 |
| DeepSeek Harness | 用户 `.dsh/skills`、`.agents/skills`；项目 `.dsh/skills`、`.agents/skills`；支持根下平铺 Markdown | Cordis YAML／overlay 待适配 | 不把 Cordis 配置当作 `mcpServers` JSON；bundled／自定义 roots 未声明时不猜测 |
| Pi | 用户 `.pi/agent/skills`、`.agents/skills`；项目 `.pi/skills`、`.agents/skills` | 用户 `.pi/agent/mcp.json`、项目 `.pi/mcp.json` | 当前官方格式可读；扩展可能替换原生 MCP 加载，运行状态未知 |
| OpenCode | 用户 `.config/opencode/skill(s)`；用户／项目 `.agents/skills`、`.claude/skills`；项目 `.opencode/skill(s)` | 用户／项目 `opencode.json`、`opencode.jsonc` 的 `mcp` | 使用 JSONC parser，不运行会安装依赖或获取远端内容的配置 loader |
| CodeBuddy | 用户／项目 `.codebuddy/skills` | 用户 `.codebuddy/.mcp.json` 优先，其次 `mcp.json`、旧 `.codebuddy.json`；项目 `.mcp.json` 优先，其次 `mcp.json`；旧用户文件的项目私有项 | 同范围首个存在文件优先，不合并备用文件；JSONC 只读 |
| Qoder | 用户／项目 `.qoder/skills` | 用户 `.qoder/settings.json`；项目 `.qoder/settings.json`、`.mcp.json`、`.qoder/settings.local.json` | 分层注册分别保留，不推断最终 override／审批结果 |
| CodeFlicker CLI、CodeFlicker 桌面版、WorkBuddy、ZCode | 标准自动来源待适配；可手动登记通用 Skill 目录 | 标准自动来源待适配；可手动登记 JSON／JSONC／TOML 注册文件 | 供应商或第三方目录线索不证明当前客户端 loader；不从历史目录猜配置目录 |

用户目录由操作系统 home 决定。可明确传入 `CODEX_HOME`、`DSH_HOME`、`DSH_AGENTS_HOME`、`PI_CODING_AGENT_DIR`、`XDG_CONFIG_HOME` 的已核验覆盖值；测试传入人工 home，不修改进程 `HOME`。项目扫描只限已登记、历史中确认或手动声明的项目根，不遍历仓库寻找任意配置。当前盘点不额外推导 nested 项目或祖先加载层。

手动来源记录客户端、Skill／MCP、绝对路径、作用项目及格式；MCP 可声明注册 map 的 key path。它不接收命令、URL 或凭证值，也不会因为手动选择了客户端就宣称该客户端正在加载来源。

## 身份、状态与保护

- Skill 与 MCP 总览按记录的完整 Skill／服务器名称跨 Agent、项目及路径汇总，每个名称一行，Agent 用于筛选；主列表统一展示使用会话数，默认按会话并集排序。调用、成功读取、项目分布、工具及全部历史来源保留在详情；名称中的插件前缀不自动去除。MCP 同名汇总不证明注册、地址或服务实例相同，旧来源查询继续保留精确客户端、项目和来源范围。
- 使用地图沿用名称身份与完整统计范围，统一按使用会话数决定线性面积，同一会话中的多次调用和成功读取不增加面积，最近使用由任何使用证据确定。零值和未知不占面积；地图颜色、小块或会话数上限不改变整理候选规则和管理保护。点击名称仍须选择实际本体／注册，历史身份不能直接作为写入目标。旧 Web 调用／读取指标或排序兼容为会话数，原次数上限清除；API／CLI 仍保留原指标和证据口径。
- 入口与本体分开：真实路径确认相同的 Skill 共享一个本体，保留每个客户端入口及符号链接原文。名称或内容相同的独立目录不合并本体。
- 使用排行的名称标识与具体历史来源标识分开；旧来源链接仍可回查。历史关联逐来源核验，汇总中只有部分来源关联当前入口时保留“部分未关联”；管理操作仍选择具体本体或入口。
- 缺失名称的占位文案不证明同一 Skill，保持实际来源范围，不据此跨 Agent 合并。
- 断链、不可读及缺失项目直接保留状态或缺口；缺失默认配置目录表示未发现来源，不表示安装资源数已完整确认。未知来源显示待适配。
- `contentFingerprint` 的范围是 `SKILL.md` 文档，`fingerprintScope=skill-document`。它不证明附带脚本、素材或整个资源包相同，也不能独立决定管理身份。
- Skill YAML 元信息使用受限 alias 数量的正式 parser。MCP 只公开服务名、transport 类型、设置状态和配置 key 定位；命令、URL、环境变量、headers 及未知注册值不进入快照。
- `observedAt` 表示此次观察时间，`modifiedAt` 表示入口修改时间；二者不冒充安装时间。长期首次发现由独立管理状态保留。
- `.system` 下 Skill 受保护。Codex／Claude 已知插件 cache 中有 manifest 的来源，以及 Claude 安装登记引用的来源保留插件归属；扫描缓存不证明插件启用。插件 manifest 路径必须位于声明根内，URL、bundle 和未支持的混合形态保持待适配。
- 只读盘点层所有写操作能力为 false。管理层必须根据来源、保护条件与已核验操作另行开放；通用目录／配置解析能力不是写入许可。

## 原生设置定位

用户级普通 Codex Skill 的停用 selector 使用 canonical `SKILL.md` 文件路径，位于用户 `[[skills.config]]` 中；项目和插件 Skill 不套用该用户开关。用户级 Codex MCP 使用 `mcp_servers.<name>.enabled`。普通 Claude Skill 的已记录 `skillOverrides[name]=off` 可以投影为停用设置；插件 Skill 不套用它。Claude 项目 MCP opt-out 位于用户文件 `projects[项目].disabledMcpServers`，它不等于用户全局停用，也不是 `.mcp.json` 审批列表。

上述状态表示配置中的设置，不能代替客户端生效反馈。只读发现不改变文件；管理操作完成后若没有独立运行信号，显示待重新加载。

## 依据与核验边界

核验于 2026-10-07。Codex、Claude 官方文档和官方源码解释核心格式；已固定的 DeepSeek Harness／OpenCode 源码验证其他格式。Pi 文档来自当前官方主干，未固定安装版本，运行效果仍待客户端验收。

- [Codex Skills](https://developers.openai.com/codex/skills)、[MCP](https://developers.openai.com/codex/mcp)、[skills config selector](https://github.com/openai/codex/blob/main/codex-rs/config/src/skills_config.rs)。
- [Claude Skills](https://code.claude.com/docs/en/skills)、[MCP](https://code.claude.com/docs/en/mcp)、[插件 manifest](https://code.claude.com/docs/en/plugins-reference)。
- [DeepSeek Harness Skill filesystem](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/skill/skill-filesystem/src/index.ts)、[MCP-client](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/mcp/mcp-client/README.md)。
- [Pi Skills](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)、[Pi MCP](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/mcp.md)。
- [OpenCode Skill loader](https://github.com/anomalyco/opencode/blob/3c96bf84688fa5e56977a1ff95a0b920f1749983/packages/opencode/src/skill/index.ts)、[MCP schema](https://github.com/anomalyco/opencode/blob/3c96bf84688fa5e56977a1ff95a0b920f1749983/packages/opencode/src/config/config.ts)。
- [CodeBuddy Skills](https://www.codebuddy.ai/docs/cli/skills)、[MCP](https://www.codebuddy.ai/docs/cli/mcp)。
- [Qoder Skills](https://docs.qoder.com/cli/Skills)、[MCP reference](https://docs.qoder.com/cli/mcp-reference)。

合成验证覆盖普通 Skill、共享链接、断链、同文档不同实例、系统／插件保护、项目私有注册、手动来源、缺失项目、JSONC 优先配置和敏感值投影边界。真实本机盘点属于只读验收；写能力及客户端加载效果须单独验证。
