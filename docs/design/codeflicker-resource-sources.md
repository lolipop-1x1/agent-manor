# CodeFlicker 本地资源来源与核验边界

本矩阵描述已核验发行格式，补充 [通用资源支持矩阵](resource-support.md)。核验日期为 2026-10-08；读取源码和文件形态不证明当前运行客户端已加载，也不证明写操作已经生效。

## 版本与资源根

| 产品身份 | 核验发行版本 | 资源根与关系 |
| --- | --- | --- |
| CodeFlicker CLI | CodeFlicker CLI 0.7.19、MyFlicker CLI 0.3.26 | 两套 npm CLI 均使用 `.codeflicker` 用户与项目配置根；改名没有自动切换到 `.myflicker` |
| CodeFlicker 桌面版 | MyFlicker 2.260928.2 | 桌面版及其内置运行时使用 `.myflicker`；旧 `.codeflicker` 来源存在复制迁移，不属于当前默认扫描根 |

客户端标识保持现有 `codeflicker` 与 `codeflicker-desktop`。桌面发行包带有的运行时入口与独立 npm CLI 分开，不因都提供命令行能力就混用资源根。尚未核验的旧版本和配置根覆盖不按名称猜测，保留来源缺口或显式手动登记。

## Skill 静态来源

| 来源 | CLI | 桌面版 | 盘点及管理边界 |
| --- | --- | --- | --- |
| 用户资源 | `.codeflicker/skills` | `.myflicker/skills`、`.myflicker/user-skills`、`.agents/skills` | 普通独立目录可核验原生设置或隔离／恢复；共享本体不冒充单入口操作 |
| 已知项目 | 项目 `.codeflicker/skills`；启用兼容导入时读取项目 `.claude/skills`、`.agents/skills` | 项目 `.myflicker/skills`、`.myflicker/user-skills`、`.agents/skills` | 按已知项目分别计算发现与覆盖关系，不全盘扫描 |
| 自定义路径 | 顶层 `skillPaths` 字符串数组；旧式 `skills` 路径数组按新数组在前、旧数组在后拼接 | 全局 Agent 设置 `userCustomSkillDirs` 字符串数组 | 只读明确引用的本地路径；相对路径、无效值和不存在来源按原生规则核验，不使用服务 cwd 猜测 |
| 兼容导入 | `claudeImport` 默认开启，包含用户 `.claude/skills` 与 `.agents/skills` | `.myflicker/user-skills` 是有效兼容扫描根 | “兼容”不表示当前客户端正在运行，也不证明目录独占 |
| 远端安装材料 | `remoteSkills` 默认开启，读取 `.codeflicker/remote-personal-skills` 与 `remote-skills` | `.myflicker/remote-personal-skills` 是市场下载扫描根 | 盘点已有本地材料，保留托管来源保护；不下载或直接修改托管缓存 |
| 内置与插件 | 内置元信息、插件登记及 manifest／静态路径；动态 hook 无法静态确认时记缺口 | `.myflicker/internal/skills` 为内置根 | 保护、只读，不通过执行插件来盘点 |

桌面自定义目录来自 `.myflicker/agent-settings.yaml` 的根级 `userCustomSkillDirs` 项；设置项使用 `{ value, updatedAt }` 结构，`value` 为字符串数组。项目根由工作区另外推导，不从此设置中猜测项目。

CLI 使用加载顺序覆盖同名 Map 项；插件原生名称带插件命名空间。桌面运行时区分内置、用户拥有和市场来源的选择等级。各来源内部的排序和选择条件必须按实际消费者核验，无法确定的同级冲突保留诊断，不自行选一个“最新目录”。

CLI 的同名 Map 覆盖不套用于桌面的所有目录入口。桌面 `use_skill` 可按启用项的精确目录选择；只要原生路径仍能独立选择，同名资源就保留独立入口，不能仅因名称排序靠后而标为被覆盖。默认名称选择、目录选择及列表排序分别核验。

CLI 的 `skills.disabled`、`skills.userOnly`、`skills.enabled` 按名称列表消费，状态判定先检查 disabled，再检查 userOnly，再检查 enabled 及内置默认设置。已核验默认仅用户触发的原生名称为 `docs-shuttle`，同名用户目录覆盖后仍适用；显式 enabled 可以开启自动调用，带插件命名空间的名称另行判断。仅用户触发仍可由用户使用，不归类为停用。桌面 Skill 的 `.disable` 标记参与状态读取；实际写能力须核验独立入口及恢复冲突，不能覆盖共享目标后声称只影响一个入口。

## 插件与副本

CLI 的 `installed_plugins.json` 保存安装登记，登记的 `installPath` 指向版本材料；`known_marketplaces.json` 描述市场检出位置，`plugins/cache` 保存版本缓存。三个概念不能混用，市场检出或缓存存在不证明某个插件已安装／启用。

插件 manifest、Skill 与 MCP 文件引用在读取正文前核验真实目标位于登记根内；符号链接不能绕过边界，越界引用只保留无效状态与来源缺口。

本地列表包含已核验入口及已停用项。未被发现规则或安装登记引用的旧副本进入来源诊断；被覆盖入口按用户默认和每个已知项目分别保留覆盖关系。名称、文档指纹或复制迁移不证明两个独立目录是同一本体。移除当前入口可能重新露出下层同名项，预览须说明该影响。

## MCP 注册

| 产品身份 | 静态注册来源 | 设置状态与管理 |
| --- | --- | --- |
| CLI | 用户 `.codeflicker/config.json`，项目 `config.json`／`config.local.json` 的顶层 `mcpServers`；插件 manifest 的 MCP 声明 | 配置型注册用单数 `disable`；插件停用另有 `disabledMcpServers`。普通配置注册的写操作核验并通过隔离测试后开放；插件受保护 |
| 桌面版 | `.myflicker/config/mcp.json` 的顶层 `mcpServers`；原生设置／运行时另有相关管理状态 | Client Daemon 的管理操作带 expectedRevision；首版只读，不直接覆盖 JSON 或 SQLite 来模拟管理 |

CLI 配置按用户、项目、项目本地及更高层临时配置处理；后层同名服务器整体替换注册对象，不跨层深合并命令、环境或 headers。AgentManor 只计算已持久化且已发现的范围，未保存的命令行配置不推测。

桌面设置存储存在 SQLite 元信息，但注册同时涉及配置文件及 Client Daemon；不能归纳为“都在 SQLite”。已观察到配置含 `disabled` 字段，查到的运行时组件消费单数 `disable`；具体来源的消费者、版本与转换关系尚须核验。不根据字段相似推断设置，无法确认时状态未知；配置中的未知字段保留，不能静默纠正或删除。

注册投影只返回名称、类型、位置、可确认设置及缺口；命令、URL、环境变量、headers、配置正文及恢复材料不进入公开清单。

## 历史关联与验收

当前入口与历史使用分别存在，关联依据保存路径和可核验的原生身份及客户端／项目范围。完整原生名称、插件前缀和历史路径保留，不把当前 frontmatter、迁移推测或同名配置当作历史安装证据。

来源调查审阅了 CLI 发行 `dist/cli.mjs` 的路径、配置合并、Skill loader、插件登记及 MCP 管理组件，以及桌面发行运行时、配置 schema 和 Daemon 桥接。发行压缩文件及二进制的定位需要结合版本和偏移，私人安装路径不进入公开材料；没有复制供应商实现或原始资源正文。

调查没有运行客户端、Skill、插件或 MCP，也没有验证真实写操作。实现验收使用合成来源测试状态／优先级／覆盖／恢复，真实本机只读核对；动态 hooks、未知旧格式和未确认消费者继续明确保留缺口。桌面 MCP 写适配与插件级管理作为后续独立任务。
