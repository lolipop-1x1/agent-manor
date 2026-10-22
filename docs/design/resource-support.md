# 资源来源支持矩阵

本矩阵描述只读盘点能力。盘点读取现有文件，不运行 Skill 脚本、客户端命令或 MCP 服务，不判断运行客户端是否已经加载配置。历史统计覆盖全部已支持客户端；配置来源未核验不等于历史统计为零。

历史统计的逐客户端格式与缺失边界见 [Skill／MCP 历史解析](resource-history-parsing.md)。

豆包工作当前暂不支持，自动盘点、手动来源和相关页面入口均已停用；已保存的恢复材料不删除。其他客户端的共享入口仍按各自来源盘点，指向已核验豆包托管目录的资源保持只读。原因见 [来源调查](doubao-work-sources.md)。

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
| CodeFlicker CLI | 用户／已知项目 `.codeflicker/skills`、配置引用目录、兼容导入、远端已安装材料及插件登记 | 用户／项目 `config.json`、项目 `config.local.json` 的 `mcpServers`，静态插件声明 | 按持久配置层计算选择，动态 hook／虚拟内置来源保留缺口；插件及托管来源受保护 |
| CodeFlicker 桌面版 | `.myflicker/skills`、`user-skills`、`internal/skills`、市场材料、共享 `.agents/skills`、已知项目与自定义目录 | `.myflicker/config/mcp.json` 的 `mcpServers` | 普通独立 Skill 可核验操作；桌面 MCP 只读，未确认的设置字段保持状态未知 |
| WorkBuddy、ZCode | 标准自动来源待适配；可手动登记通用 Skill 目录 | 标准自动来源待适配；可手动登记 JSON／JSONC／TOML 注册文件 | 供应商或第三方目录线索不证明当前客户端 loader；不从历史目录猜配置目录 |
| Gemini CLI | 原生／`.agents` 用户与可信项目 Skill、静态扩展与系统来源 | 分层 settings 与独立 MCP enablement 文件 | 原生控制按规范化名字作用；远端管理策略及安装内置资源没有定位时保留缺口 |
| Qwen Code | 原生／`.agents`／custom、可信项目、扩展及插件 v1 | 用户、项目与扩展注册，配置摘要审批及原生排除名单 | 硬禁用、defaultDisabled、级别禁用与用户触发分开；审批与连接状态不混同 |
| Kimi Code CLI | 用户、generic、项目、配置 roots、条件递归 bundle 与插件 | 用户 `mcp.json`、项目 `.mcp.json`、cwd 原生 MCP 文件 | 普通 Skill 无逐项停用开关；插件受保护，普通入口可回收恢复 |
| Oh My Pi | native、opt-in foreign、项目、custom、插件和 skillshare | native 及兼容 provider，名字 deny／allow 与 enabled | YAML 原生名字控制；未启用 provider 不计有效入口；不同正文保留原生别名 |
| Grok Build | 用户、可信项目、兼容与已安装插件 | 用户／项目 TOML、插件及兼容来源 | MCP 项目从仓库根到 cwd 覆盖用户；个人停用写用户 disabled_mcp_servers 名单，注册回收独立；managed／插件保护 |
| Reasonix | 用户、项目、配置 roots 与插件包 | 用户／项目 plugins 与 `.mcp.json`，durable activation | 项目覆盖使用工作区身份，简单声明核验 digest；复杂变量／脚本展开不能确认时保持未知和只读 |
| Codewhale | 原生、配置根、项目、兼容与插件 | global、可信 project 与插件 | 当前格式 home 回退；普通 Skill 无逐项停用，插件受保护 |

用户目录由操作系统 home 决定。可明确传入 `CODEX_HOME`、`DSH_HOME`、`DSH_AGENTS_HOME`、`PI_CODING_AGENT_DIR`、`XDG_CONFIG_HOME`、`MYFLICKER_HOME` 的已核验覆盖值；测试传入人工 home，不修改进程 `HOME`。项目扫描只限已登记、历史中确认或手动声明的项目根，不遍历仓库寻找任意配置。不从目录编码或相近路径推导新项目；对已有项目 cwd，Grok MCP 与 Oh My Pi Skill 按已核验的原生规则纳入仓库祖先入口。

CodeFlicker CLI／桌面版的版本、资源根、配置字段与迁移边界见 [来源矩阵](codeflicker-resource-sources.md)。CLI 同名入口按加载顺序计算覆盖，用户默认及各已知项目的选择分别保留；全局实际入口合并展示，项目差异放在作用范围记录中。桌面可按精确目录选择的同名入口保持独立。未登记缓存和被覆盖来源进入诊断，不混入有效入口。来源格式核验不代表运行客户端已经加载或管理修改已生效。

手动来源记录客户端、Skill／MCP、绝对路径、作用项目及格式；MCP 可声明注册 map 的 key path。它不接收命令、URL 或凭证值，也不会因为手动选择了客户端就宣称该客户端正在加载来源。

## 身份、状态与保护

- Skill 与 MCP 总览按记录的完整 Skill／服务器名称跨 Agent、项目及路径汇总，每个名称一行，使用客户端与使用项目用于筛选历史；位置范围与位置项目独立筛选当前入口，不裁剪名称级历史统计；主列表同时展示调用次数与使用会话数，默认按调用次数降序。Skill 调用次数合计显式调用与成功正文读取，MCP 按工具请求计数；使用会话数按会话并集去重。原始调用、读取、项目分布、工具及全部历史来源保留在详情；名称中的插件前缀不自动去除。MCP 同名汇总不证明注册、地址或服务实例相同，旧来源查询继续保留精确客户端、项目和来源范围。
- 使用地图沿用名称身份与完整统计范围，默认按调用次数决定线性面积，可切换使用会话数；次数按使用事件计数，会话指标在同一会话中只计一次，最近使用由任何使用证据确定。零值和未知不占面积；地图颜色、小块或会话数上限不改变整理候选规则和管理保护。点击名称仍须选择实际本体／注册，历史身份不能直接作为写入目标。旧 Web 调用／读取指标或排序兼容为合并调用次数，原上限清除；切换指标时清除上限。API／CLI 原有 calls、reads、sessions 指标保持不变，新增 uses 表达合并使用事件次数。
- 概览最近三条证据绑定当前历史范围与完整版本，按发生时间倒序选择，独立于使用记录分页及工具筛选；有效时间在前，时间缺失保留未知。更新期间保留旧概览和范围标签并暂停下钻，新统计、范围标签和最近证据一起替换；失败显示错误及重试。证据 API 显式 `sort=recent` 时按时间排序分页，未指定时保留既有事件顺序。
- 入口与本体分开：真实路径确认相同的 Skill 共享一个本体，保留每个客户端入口及符号链接原文。名称或内容相同的独立目录不合并本体。
- 使用排行的名称标识与具体历史来源标识分开；旧来源链接仍可回查。历史关联逐来源核验，汇总中只有部分来源关联当前入口时保留“部分未关联”；管理操作仍选择具体本体或入口。
- 缺失名称的占位文案不证明同一 Skill，保持实际来源范围，不据此跨 Agent 合并。
- 断链、不可读及缺失项目直接保留状态或缺口；缺失默认配置目录表示未发现来源，不表示安装资源数已完整确认。未知来源的适配边界保留在盘点契约中；日常界面不把缺失默认目录、缺失项目和待适配来源逐项报为用户待办。
- `contentFingerprint` 的范围是 `SKILL.md` 文档，`fingerprintScope=skill-document`。它不证明附带脚本、素材或整个资源包相同，也不能独立决定管理身份。
- Skill YAML 元信息使用受限 alias 数量的正式 parser。MCP 只公开服务名、transport 类型、设置状态和配置 key 定位；命令、URL、环境变量、headers 及未知注册值不进入快照。
- `observedAt` 表示此次观察时间，`modifiedAt` 表示入口修改时间；二者不冒充安装时间。长期首次发现由独立管理状态保留。
- `.system` 下 Skill 受保护。Codex／Claude 已知插件 cache 中有 manifest 的来源，以及 Claude 安装登记引用的来源保留插件归属；扫描缓存不证明插件启用。插件 manifest 路径必须位于声明根内，URL、bundle 和未支持的混合形态保持待适配。
- 只读盘点层所有写操作能力为 false。管理层必须根据来源、保护条件与已核验操作另行开放；通用目录／配置解析能力不是写入许可。

## 原生设置定位

用户级普通 Codex Skill 的停用 selector 使用 canonical `SKILL.md` 文件路径，位于用户 `[[skills.config]]` 中；项目和插件 Skill 不套用该用户开关。用户级 Codex MCP 使用 `mcp_servers.<name>.enabled`。普通 Claude Skill 的已记录 `skillOverrides[name]=off` 可以投影为停用设置；插件 Skill 不套用它。Claude 项目 MCP opt-out 位于用户文件 `projects[项目].disabledMcpServers`，它不等于用户全局停用，也不是 `.mcp.json` 审批列表。

CodeFlicker CLI Skill 使用 `skills.disabled`／`userOnly`／`enabled` 名单；仅用户触发与停用分开。配置型 MCP 使用单数 `disable`，停用与恢复只编辑所选规则。桌面普通 Skill 使用 `.disable` 标记；共享目标无法独立修改时保持只读。桌面 MCP 的 Daemon 写协议留待单独适配，不直接修改配置或 SQLite 模拟客户端管理。

上述状态表示配置中的设置，不能代替客户端生效反馈。只读发现不改变文件；管理操作完成后若没有独立运行信号，显示待重新加载。

新增七个客户端的固定版本、原生控制及未验证范围见 [七个原生客户端来源](native-client-sources.md)。名字列表、布尔开关及 activation 通过具体目标编辑，恢复保留其他名称和后续配置变化。JSON、TOML、YAML 的复杂未核验写法保持只读；外部兼容本体不直接修改。原生禁用影响已知多层入口时，预览保留名字和控制文件的真实范围。

## 配置依据与作用范围

资源盘点不承担客户端安装检测，兼容目录也不证明某客户端已安装或正在使用资源。Skill 以真实文件位置为主体；仅现有配置明确匹配资源路径、名称、注册或 activation 身份时开放启停，不为默认兼容规则创建配置。桌面 Skill 不再凭目录创建停用标记；既有停用记录仍可恢复。MCP 直接注册按真实配置条目管理，跨配置控制须有明确资源依据。

控制范围单独记录为路径、项目或客户端全局配置，不能沿用所选文件的 scope。无法确定控制范围时只读。预览复用盘点，定向检查目标和依赖且单次复用相同路径的内容核验；执行前重新盘点与核验内容、引用和保护，写入完成后失效缓存，后续读取共享新盘点。历史收藏关联按当前索引及盘点版本复用，不因提速遗漏保护。

## 恢复材料与管理入口

统一名称清单采用三栏工作区，列表与地图共用筛选及右侧详情。详情分概览、文件／配置位置、使用记录；写入动作属于具体文件、链接或注册，名称汇总只用于阅读。管理预览在同一详情栏提供安全投影的配置项与前后值或路径变化，不向 API 暴露整份配置正文和注册值。历史独有、系统、插件及未适配来源保持可见的只读原因。可操作入口只显示已核验动作，恢复与永久清除仍需独立预览。

原生停用保留 Skill 本体，配置恢复材料进入持久数据目录的 `resource-vault/backups/`。隔离 Skill 入口或移除 MCP 注册的材料进入 `resource-vault/trash/`。两处按资源类型、安全名称与来源标识、操作 ID 分层；Skill 身份使用原入口路径，MCP 使用配置位置与注册项，不按同名或共享目标混合入口。目录与文件使用受限权限，路径与备份正文不进入公开清单。

符号链接回收只保存并移除所选链接，恢复按原始链接文本重建，包括原本断开或目标后来缺失的链接，不要求目标存在，也不重建目标文件。恢复中心直接表达链接移除记录，恢复预览与结果区分链接还原和目标 Skill 文件可读取性；原位置占用及材料变化仍阻止写入。永久清除仅删除所选记录的恢复材料，保留目标文件、其他链接与操作历史。

页面通过恢复中心合并尚未还原且记录了恢复材料的停用、备用与回收记录，按变更时间排序；已还原或清除的记录留在操作历史。列表不承诺当前可还原，预览时核验材料完整性与原位置；材料被外部删除或改动后保留变更记录并展示冲突，不静默隐藏。`archives?state=recoverable` 提供合并结果，旧状态查询继续兼容。旧动作、档案和原路径继续兼容，单独恢复或永久清除，不自动删除。迁移整体数据目录时核对数据库与材料，改写管理材料位置、使旧预览失效，并保留原数据；外部资源位置及配置正文保持原样。恢复遇到占用或配置变化继续报冲突，不覆盖现有内容。

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

## Skill 描述展示

列表使用已盘点的原始 Skill 描述，提供两行预览与悬停／键盘聚焦全文，点击资源可在详情阅读对应本地来源全文。描述不参与使用次数或历史身份归并。同名资源有多种描述时不任意挑选；历史独有且无本地元数据的资源不补造描述。

资源详情及证据复用同版总览已确认的名称身份，不再次全库查找；证据接口独立访问时沿用原来的身份解析。历史统计按索引版本、资源类型、使用客户端、使用项目及日期范围缓存压缩的来源统计与会话集合，不保存原始事件正文。本地盘点变化仅重新关联当前入口，阈值、排序、分页和收藏在返回时重新投影。每个缓存最多保留八个范围，历史版本变化时失效。

正式服务通过一个按需启动的只读 Worker 计算资源历史，首次聚合不阻塞 HTTP 主线程；同版、同范围、同盘点的并发请求合并，最多接受十六个待完成请求，失败可重试，关闭服务时回收连接与 Worker。每轮盘点按实际 Skill 文件复用解析和内容指纹，管理能力计算共用来源和引用索引；执行前仍重新盘点并检查完整引用、保护和内容冲突。操作后清单与位置更新，同版使用证据复用，不重新请求无关扫描状态。相对链接额外显示解析后的实际目标位置，目标缺失仍按真实文件状态展示，不补造目标文件。

缺口来源与客户端的归属复用修订元数据缓存，修订写入、移除与清理时失效，保留来源未知和按客户端归属的覆盖语义。
