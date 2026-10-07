# 使用指南

需要 Node.js 24、Git 和浏览器。下文使用 `agent-manor`；本地安装时可以换成安装目录中的 `node_modules/.bin/agent-manor`，也可直接 `node /absolute/install/node_modules/agent-manor/dist/cli.js`。所有命令都可以在仓库外的工作目录运行。

## 从交付包安装

```sh
mkdir -p ~/agent-manor-local
cd ~/agent-manor-local
npm install /absolute/path/agent-manor-0.1.0.tgz
./node_modules/.bin/agent-manor --version
```

tarball 包含 CLI、后台、长期 Worker、Web 静态资源与 Agent Skill，无需安装 TypeScript／Vite 或再次构建。当前没有 npm 公共发布；不要用同名 registry 包替代本地交付包。`better-sqlite3` 安装使用预编译原生扩展；没有兼容预编译包时可能需要 Python、C/C++ 编译工具链。安装错误与 Node 版本、平台和网络情况需要分别核对。

## 登记、查询和版本

```sh
agent-manor register /absolute/path/to/repository --wait --json
agent-manor repositories --json
agent-manor coverage <repositoryId> --json
agent-manor web
```

登记返回 `{repository, job}`。`--wait` 等待完成；检查 `job.status` 为 `completed` 后使用 `job.version`，失败时有 `job.error`。普通查询会连接现有后台或按需启动，启动时检查已登记仓库；如果返回 `ANALYSIS_NOT_READY`，先查询任务或执行 `refresh --wait`。

覆盖率返回 `version`、`baselineHash`、`createdAt`、`stale`、`filters`、`summary`、`files` 和 `gaps`。将返回的版本与相同筛选带入文件、活动和证据查询，避免把不同刷新结果混在一起：

```sh
agent-manor coverage <repositoryId> --client codex --categories source --directory src --json
agent-manor file <repositoryId> src/example.ts --version <analysisVersion> --client codex --categories source --directory src --json
agent-manor events <repositoryId> --path src/example.ts --version <analysisVersion> --client codex --categories source --directory src --page 1 --page-size 50 --json
agent-manor evidence <repositoryId> <eventId> --version <analysisVersion> --client codex --categories source --directory src --json
```

查询参数 `--version` 是分析结果版本；程序版本用 `--cli-version`／`-V`，单独执行 `agent-manor --version` 也支持。

## 显示语言

顶栏语言菜单提供“自动（跟随浏览器）”“简体中文”和“English”。首次使用自动模式，按浏览器语言列表中首个支持的中文或英文系列选择；其他语言回退英文。切换立即生效，保留当前页面、筛选、选中项、分页及地图视野。其他已打开页面在重新获得焦点时同步。

Web 手动选择保存在当前数据目录的 `preferences.json`，CLI 每次启动也读取它；服务重启或清除历史索引不会删除偏好。选择自动会清除手动覆盖：Web 跟随浏览器，CLI 跟随系统。不同 `--home`／`AGENT_MANOR_HOME` 数据目录各自独立。

CLI 优先级为 `--lang` → `AGENT_MANOR_LANG` → 共享手动偏好 → 系统语言 → 英文。参数和环境变量接受 `zh-CN`、`en`、`auto`，只覆盖本次执行，不保存偏好。显式 `auto` 忽略较低优先级的手动设置，按第一个非空的 `LC_ALL`、`LC_MESSAGES`、`LANG` 检测；未支持语言及 `C`／`POSIX` 回退英文。无效覆盖值和偏好保存失败会明确报错。

```sh
agent-manor --lang en --help
agent-manor coverage <repositoryId> --lang zh-CN
AGENT_MANOR_LANG=en agent-manor sessions --help
agent-manor --home /absolute/path/to/data --lang auto --help
```

语言只影响产品界面、帮助、人类摘要和错误提示。会话标题与正文、资源描述、工具／模型名称、路径和配置值保持原文；数字、日期和日历使用当前显示语言，但查询边界与统计含义不变。默认 pretty JSON 和 `--json` 输出都保留稳定字段、枚举、数值及原始诊断。新产品提示可附带 `messageDescriptor` 或对应字段；旧记录和外部错误以“原始详情”展示，不因语言切换重建索引。

## 全局会话库

网页顶部选择“会话库”。左侧筛选客户端、项目与时间，中间切换简易／完整／轨迹，右侧以“概览／调用／用量”查看统计。三栏各自滚动，操作区保持可见；侧栏可以折叠与拖动调宽，小窗口通过“会话列表／会话统计”打开抽屉。

默认列表收起有明确委派证据的子 Agent 会话，勾选“显示子 Agent 会话”可查看全部。搜索始终包含子记录并标明所属父会话；父会话的画像或轨迹提供子任务入口，子详情可返回父会话。明确委派但父记录缺失时标注“父会话未记录”，仍可通过子 Agent 筛选、搜索和直接链接查看；关系不明确时保留独立入口。子任务缺少正式标题时使用任务路径名称、Agent 名称或编号，并标明来源。

对话每页显示 10 个完整轮次，使用首轮／末轮、上一轮／下一轮、轮次编号或页码导航。初始上下文随第一页返回，不计用户轮次；完整模式默认折叠过程，轨迹显示紧凑事件表。搜索或请求定位会自动展开。用户与 AI 正文支持 Markdown，长内容可展开；图片只显示替代文字。全局搜索默认覆盖标题及用户／AI 正文，过程内容可额外选入；会话内命中显示在浮层中，清除搜索恢复原阅读位置。点击用量图、请求编号、工具或资源名称可回到证据记录。

有会话内分支时，“阅读分支”可选择当前分支、全部分支或保存的叶分支。简易默认当前分支，完整／轨迹默认全部；已保存真实对话不会因压缩摘要而消失。切换分支仅改变阅读视野，画像和代码活动仍统计全部实际活动；有原生复制依据的继承前缀排除重复统计。CLI 对应 `--branch current|all|<分支ID>`，消息 API 对应 `branch`。

轨迹上方的三行时间线覆盖整段会话，可切换事件顺序、轮次和记录时间；悬停查看节点信息，点击节点或用左右方向键定位到对应页。下方详情可切换工具参数／返回结果、预览／原始正文。Codex 注入优先按客户端分类识别，旧日志再从完整包格式推断，并说明依据；上下文不进入简易版，也不计为用户提问，过程搜索仍可检索。总览 API 为 `GET /api/v1/sessions/:id/timeline`，只返回同版本定位元信息。

请求用量趋势覆盖当前画像范围的全部已记录请求，显示从零开始的 Token 纵轴。鼠标悬浮查看请求编号、模型、时间和输入／缓存读取／输出数值；未记录与零值分开。Tab 聚焦图表后，可用左右方向键切换请求、Home／End 到首末请求、Enter／空格定位消息。明细表每页 12 条，可直接跳到首页或末页。

```sh
agent-manor sessions refresh --wait --json
agent-manor sessions refresh --client codeflicker --wait --json
agent-manor sessions refresh --client codex --mode full --wait --json
agent-manor sessions status --json
agent-manor sessions list --client codeflicker --page 1 --page-size 50 --json
agent-manor sessions list --include-subagents --json
agent-manor sessions search "状态检查" --json
agent-manor sessions search "工具关键词" --kinds user,assistant,tool_call,tool_result --json
agent-manor sessions messages <sessionId> --mode brief --json
agent-manor sessions messages <sessionId> --mode trace --message-id <messageId> --json
agent-manor sessions profile <sessionId> --include-children --json
agent-manor sessions cacheclear --wait --json
```

会话刷新任务完成状态为 `complete`，与仓库任务的 `completed` 区分。首次启动会自动检查全部历史，无须先登记仓库；首次索引未完成可通过 `sessions status` 查看进度，或 `sessions refresh --wait` 等待。列表／搜索／消息和画像支持 `--version`，同一浏览流程沿用返回的完整版本。`--project none` 筛选无项目会话。

刷新默认采用快速检查。Web 主按钮跟随客户端筛选：选中一个客户端时只刷新它，选中“全部客户端”时刷新全部；旁边菜单始终可刷新全部，并提供当前范围或全部的完整校验。项目、日期和搜索不限制刷新范围。CLI 用 `sessions refresh --client <client>` 指定范围，`--mode full` 完整校验；不指定参数时检查全部客户端。完整校验读取来源内容核对，未变索引仍可复用，与 `sessions cacheclear` 的全局重建不同。

局部刷新保留其他客户端索引及检查时间，成功后仍发布完整全局结果。进度与完成提示说明实际范围、方式、快速复用／内容复用／重新解析／缺失数及回退情况；各客户端最近成功检查独立显示，旧索引没有记录时显示未记录。只有完整依赖已核验的格式才快速跳过，其他格式和缺少检查记录的来源退回内容检查；SQLite/WAL 与相关元信息不能只看主文件。快速检查不能严格排除保留相同变化指示的内容改写，需要核对正文时使用完整校验。

API 为 `GET /api/v1/sessions`、`/sessions/search`、`/sessions/:id/messages`、`/sessions/:id/profile`、`/sessions/status`，刷新用 `POST /sessions/refresh`（可选 JSON `{ "client": "codex", "mode": "full" }`；省略为全部快速检查），清除并重建用 `DELETE /sessions/cache`；会话任务沿用 `/jobs/:id` 查询。默认消息每页 50 条，最多 200。查询参数为 `client/project/from/to/q/kinds/page/pageSize/version`；`kinds` 只限定列表匹配与搜索范围，不删减消息上下文；消息另有 `mode/messageId`，画像另有 `includeChildren=true`。

消息 API 可选择 `pageUnit=turn`，此时默认每页 10 轮，返回 `totalTurns`、当前页的 `turns` 元信息和完整消息；`total` 仍为当前视图消息数。`turnPosition` 为当前视图的一基轮次位置，`messageId` 定位优先于轮次位置。初始上下文 `position=0`，随第一页返回且不计入 `totalTurns`。`toolName` 或 `resourceKind/resourceName/resourceServer` 可以定位首条调用／资源证据，返回 `focusMessageId`；过程记录不属于简易模式，需要完整或轨迹模式。未指定 `pageUnit` 时沿用按消息分页，现有 CLI 查询保持原有行为。

浏览所需正文仅存本机索引，不上传、不调用模型；原始来源消失后新版排除，刷新失败继续显示上一完整版本。记录值、估算值与缺失的含义见 [会话统计口径](design/session-history.md)。

## 代码地图命令

| 命令 | 结果与常用选项 |
| --- | --- |
| `register <path>` | 登记 Git 仓库后刷新；`--wait` |
| `repositories` | 已登记仓库与最新版本 |
| `coverage <repositoryId>` | 范围内覆盖率与全部文件 |
| `hotspots <repositoryId>` | 热点；`--metric read\|edit\|activity`、`--limit N` |
| `unobserved <repositoryId>` | 未观察到成功读取的文件，不表示无用或安全可删 |
| `file <repositoryId> <path>` | 当前文件内容、范围和活动；路径相对仓库 |
| `events <repositoryId>` | 活动分页；`--path`、`--kind read\|edit\|search\|other`、`--page`、`--page-size`（最多 200） |
| `evidence <repositoryId> <eventId>` | 已索引来源中的原始物理记录与不可回查引用 |
| `sources <repositoryId>` | 已关联／待关联来源及采集缺口 |
| `associate <repositoryId> <sourceId>` | 手动关联已发现来源并刷新；`--wait` |
| `refresh <repositoryId>` | 主动刷新，返回任务；`--wait` |
| `jobs <jobId>` | 任务状态；`--wait` |
| `cacheclear <repositoryId>` | 清除派生缓存后重建，保留登记与手动关联；`--wait` |
| `status` | 实例、程序版本、仓库与任务 |
| `stop` | 显式停止；服务不存在时不会自动启动 |
| `web` | 打开本地页面；`--no-open` 只打印地址 |
| `serve` | 前台运行后台，便于诊断启动错误；`--port N` |

全局 `--json` 输出一条 JSON，失败返回非零退出码；API 类错误通过 stderr 输出 `{error:{code,message}}`。刷新任务执行失败时 `--wait` 仍输出失败 job，并返回非零退出码。CLI 语法错误通过 Commander 显示；可先运行 `--help` 核对参数。等待默认 120 秒，可用 `--timeout <seconds>` 指定，最多 3600 秒。

覆盖、热点、未观察读取、文件、活动、证据和来源查询支持 `--version`、`--client <客户端ID>`、`--from`、`--to`、`--categories`、`--directory`。客户端 ID 包括 `codex`、`claude`、`codeflicker`、`codeflicker-desktop`、`dsh`、`pi`、`workbuddy`、`opencode`、`zcode`、`codebuddy`、`qoder`。省略客户端时查询全部客户端；CLI 帮助、API 校验与 Web 客户端选项共用客户端声明。时间须为 ISO 8601；起止边界均包含，默认全部可用历史。类别为逗号分隔的 `source,config,docs,unknown`，默认 `source`。来源清单描述该版本的采集来源，客户端筛选可缩小清单；时间／目录／类别筛选不改写来源级计数。热点和未观察读取响应的 `files` 已筛选，`summary` 保持所选范围的分母。

CodeFlicker CLI 使用 `--client codeflicker`，Web 中选择 CodeFlicker CLI，API 使用 `client=codeflicker`。例如 `agent-manor coverage <repositoryId> --client codeflicker --json`；后续文件、活动、证据查询沿用返回的 `version` 和相同筛选。历史范围为 `~/.codeflicker/projects` 中的主会话及能够确认关系的子会话；`requests/` 中的请求重放不作为独立活动来源。旧 IDE 的 SQLite 历史使用独立的桌面版身份。

CodeFlicker 桌面版接入新版 MyFlicker 桌面端，使用 `--client codeflicker-desktop` 或 API `client=codeflicker-desktop`。默认发现 `~/.myflicker/sessions/<会话ID>/message/cache.jsonl`；`MYFLICKER_HOME` 可替换客户端目录，AgentManor 的显式来源配置优先。代码地图与会话库共用这份主来源，不重复索引同会话的底层执行轨迹。`checkpoints/registry.json` 提供正式 cwd；本机 `MyFlicker/app.db` 的会话标题缓存只补充已发现会话的标题，不把未下载的服务端历史当成本机完整记录。模型只按明确消息 UUID 关联底层日志，未记录时保持缺失。刷新会检查标题、cwd 和模型旁路的变化，原始来源始终只读。

同一桌面版入口也默认发现 `~/.codeflicker/data/codeflicker/` 的旧桌面／IDE SQLite 历史：读取 `session_data.sqlite`、`composer_data.sqlite` 中已保存的会话，用同目录的 `index.sqlite` 补充标题。一个数据库里的多个会话独立索引，新库的同身份迁移副本优先。工作区缓存地址通过正式 `workspace.json` 关联项目，配置缺失时不将缓存目录当成仓库。读取返回支持 Tab／竖线编号，编辑仅按已接受的前后快照计算覆盖；只有参数、提案或没有确认终态时保留未知。主 UI 历史与 API 请求上下文副本不重复导入。旧格式缺少逐请求用量时显示未记录及内容估算，不把累计缓存转换成请求趋势。

活动与证据查询保留已删除文件的历史，按路径分类，覆盖分母仍只包含当前文件。目录搜索按当前或历史后代文件与所选类别的交集筛选，不把整个目录算作读取。没有具体文件路径的活动类别为 `unknown`，用 `--categories unknown` 或全部类别查看；目录筛选依据已核验的 cwd，不推断搜索命中或覆盖行。

Claude 头部发现仍限于 64 KiB／前 32 条记录，会在同一会话中继续补齐首个可靠 cwd；完整解析也补齐来源 cwd，并保留每条活动自己的 cwd。解析规则 3 会重建规则 2 的旧游标，以修正缺失的来源归属。

## 正确解释结果

文件覆盖率用 `summary.readExact.files / summary.fileCount`，行覆盖率用 `summary.readExact.lines / summary.lineCount`；修改使用对应的 `editExact`。分母为零时显示无统计文件／行，不生成百分比。近似覆盖单列，不混入精确覆盖；行范围是一基闭区间 `{start,end}`。

`readCount`／`editCount` 是成功活动次数，未知当前范围仍可能有活动；`activityCount` 按事件身份去重。搜索、失败与未知列可能重叠，不能相加当总活动。`unobserved` 只表示当前观测窗口与采集覆盖下没有观察到成功读取。

`file.contentStale` 为 true 或 `content` 为 null 时，不使用旧范围解释当前代码；先 `refresh --wait` 再取得新版本。刷新失败保留上一完整版本并标过期。来源记录追加不使旧记录引用失效；改写、删除或移动后的旧路径可能不能回查，查看 `unavailable`。单条原始证据回读限额为 16 MiB。

格式兼容按证据结构判断，不保证所有客户端版本：直接工具、可识别 Shell 和明确的调用结果可提取；复杂脚本、未配对结果、重复位置、缺失或截断内容保持未知。客户端身份与历史格式分别保存；格式相同不表示客户端相同。详见 [历史支持矩阵](design/history-support.md)、[基线规则](design/baseline-rules.md) 与 [匹配规则](design/matching-rules.md)。

## 数据目录、后台与缓存

| 环境变量／选项 | 默认与用途 |
| --- | --- |
| `AGENT_MANOR_HOME` 或全局 `--home <path>` | `~/.agent-manor`；SQLite 索引、实例信息与锁 |
| `AGENT_MANOR_CODEX_DIR` | 覆盖默认 `~/.codex/sessions` 和 `~/.codex/archived_sessions` |
| `AGENT_MANOR_CLAUDE_DIR` | 覆盖默认 `~/.claude/projects` |
| `AGENT_MANOR_CODEFLICKER_DIR` | CodeFlicker CLI 来源，覆盖默认 `~/.codeflicker/projects`；仍排除 `requests/` |
| `AGENT_MANOR_CODEFLICKER_DESKTOP_DIR` | CodeFlicker 桌面版来源目录，覆盖默认新版 JSONL 与旧 IDE SQLite 两个目录 |
| `AGENT_MANOR_CODEFLICKER_DESKTOP_DB` | 可选的桌面标题缓存 `app.db` 路径；自定义来源不会自动读取默认标题库 |
| `AGENT_MANOR_DSH_DIR` | DeepSeek Harness，默认 `~/.dsh/sessions`，只读 V3／V4 压缩事件流 |
| `AGENT_MANOR_PI_DIR` | Pi，默认 `~/.pi/agent/sessions`，保留事件树分支 |
| `AGENT_MANOR_WORKBUDDY_DIR` | WorkBuddy，默认 `~/.workbuddy/projects`；按原生身份补充邻近 SQLite 元信息 |
| `AGENT_MANOR_OPENCODE_DIR` | OpenCode，默认 `~/.local/share/opencode`，读取 `opencode.db` |
| `AGENT_MANOR_ZCODE_DIR` | ZCode，默认 `~/.zcode/cli/db`，读取 `db.sqlite` 并关联桌面任务索引 |
| `AGENT_MANOR_CODEBUDDY_DIR` | CodeBuddy，默认 `~/.codebuddy/projects` |
| `AGENT_MANOR_QODER_DIR` | Qoder，默认 `~/.qoder/projects` |
| `AGENT_MANOR_PORT` 或 `serve --port N` | 默认随机空闲端口；仅绑定 `127.0.0.1` |

历史目录环境变量须在后台启动前设置；已有后台使用它启动时的环境。需要切换时先显式 `stop`，再以新环境启动。隔离测试应使用独立 `AGENT_MANOR_HOME`，并把所有客户端的历史目录环境变量指向测试目录或空目录，防止连接日常后台或读取本机历史。

已有开发历史却全零时，先用 `sources <repositoryId> --json` 核对是否只接入了测试样本，再检查启动环境中的历史目录覆盖。使用默认目录后重启并刷新；仓库目录的文件清单正常不代表开发会话已经接入。已删除 worktree 的恢复需要会话中的成功创建与 Git 清单证据，支持边界见 [历史支持矩阵](design/history-support.md)。

```sh
agent-manor refresh <repositoryId> --wait --json
agent-manor cacheclear <repositoryId> --wait --json
agent-manor stop --json
```

清缓存不会删除原始历史，也不抹去仓库登记或手动关联。分析缓存中包含所需历史源码片段，应按本机敏感数据保管；原始会话只读。服务没有开机启动或持续文件监听，关闭网页后继续运行；需要释放进程时显式停止。分析不上传日志、不调用模型。浏览器仅允许同服务 Origin，API 限制 Host 和写入类型，不提供任意绝对路径读取接口。

未关联来源只缓存归属判断所需的身份、路径和关系证明，不长期保留工具返回正文。确认属于仓库、后补跨会话／历史 worktree 证明或手动关联后，会重新读取完整证据；来源内容变化也会重新解析。Worker 意外退出时，本轮及排队任务标失败，旧完整结果仍可查询；下一次主动刷新会重新创建 Worker，不自动循环重试失败任务。

## 将查询能力交给 Agent

包内 `skills/agent-manor/SKILL.md` 给出固定版本的 JSON 查询、文件与证据回读流程。将整个 `skills/agent-manor/` 目录按客户端约定复制或引用到 Skill 发现目录，并保证 `agent-manor` 命令或安装后的 CLI 绝对路径可用。安装包不会自动改写客户端 Skill／MCP 配置。

## 资源管理

顶部「资源管理」切换 Skill／MCP，两类资源首入口均为总览；另有本地资源、已停用、备用、回收和操作记录。总览按完整 Skill 名称或 MCP 服务器名称合并本地清单及历史使用，Agent 作为筛选；具体路径、本体和注册入口保留在详情中。相同服务器名称不证明注册、地址或服务实例相同。排行依据已索引的实际事件，使用会话数取并集；Skill 调用与成功读取分列，MCP 默认按调用次数排序，可下钻工具，统计已记录结果和执行耗时，并从证据跳回会话轨迹。请求 Token 不归因到资源。

默认全部已索引历史，两类总览按 Agent 和事件时间筛选，其他视图也支持项目筛选。来源、时间或安装归属缺失保持未知／部分记录；历史名称不能证明属于当前同名资源，缺失名称保留来源身份。整理候选提供使用会话数和未使用天数阈值，收藏与受管理资源受保护。首次发现不代表安装时间；新发现但观测不足的资源列为待检查。文档指纹只识别 `SKILL.md` 相同，不证明整个资源包相同。

总览提供全部、已使用、未发现使用、低频、长期未用、待检查与已收藏的计数快捷入口；计数对应当前 Agent、日期及搜索范围。未知或观测不足不补成零，保护资源不进入未使用、低频及长期未用整理候选。表格支持升降排序；分页支持首尾、页码、直接跳转及每页 20／50／100 条。名称收藏与独立本体收藏保留各自入口，取消名称收藏不移除本体收藏。

Skill／MCP 总览可切换列表或地图，首次使用列表，随后保留视图选择。地图按当前完整筛选结果绘制，默认面积为调用次数，可切换使用会话数，Skill 另可选成功读取；面积保持线性比例。颜色表示任何已记录调用或成功读取的最近日期，与面积指标无关。零指标与待检查分别列在可折叠、独立分页的区域，零调用不表示从未使用。

地图支持滚轮缩放、拖动、全屏、适应窗口和定位所选；定位资源支持名称搜索，缩放只改变视野。悬停或键盘聚焦查看名称、数值、占比、最近使用和保护状态，点击打开详情及具体本地入口；全屏选择资源时退出全屏以展示详情。使用证据跳转返回同一范围时保留缩放与平移位置。地图的指标上限只筛选已知数值，切换指标清空上限，切回列表沿用列表范围；搜索与 Agent／时间／状态筛选同时作用于两种视图。数值口径和交互说明可通过地图帮助查看。

本地盘点只读取已核验来源、已知项目和手动路径，不执行 Skill、启动 MCP 或全盘扫描。支持范围见 [资源来源矩阵](design/resource-support.md)。每个入口显示自身可用动作；未经核验的来源与插件缓存只读。停用使用已核验原生设置，备用／回收是入口隔离或所选注册移除，不卸载服务。符号链接操作保留其共享目标。

```sh
agent-manor resources status --json
agent-manor resources overview --candidate unused --page 1 --page-size 50
agent-manor resources overview --kind mcp --client codex --page-size 50
agent-manor resources usage --kind skill --sort sessions --json
agent-manor resources usage --kind mcp --client codex --json
agent-manor resources local --candidate review --json
agent-manor resources detail <historyResourceId> --json
agent-manor resources evidence <historyResourceId> --page 2 --json
agent-manor resources favorite <resourceId> --json
agent-manor resources source-add /workspace/skills --kind skill --client codex --json
agent-manor resources preview standby --entry-id <entryId> --json
agent-manor resources apply <previewId> --confirm --json
agent-manor resources archives --state standby --json
agent-manor resources preview restore --operation-id <operationId> --json
agent-manor resources operations --json
```

写入必须先审阅该资源的具体预览，再确认对应 `previewId`；预览有效期为 15 分钟，执行前核验来源、共享入口和恢复材料。恢复不会覆盖原位置或目标注册中的新内容；冲突须重新检查。永久清除另行生成和确认 `purge` 预览，不自动清空回收区。成功仅表示本地修改完成，客户端显示待重新加载，不自动重启或探活。

资源 API 位于 `/api/v1/resources`，与 Web／CLI 共用服务：`status`、`overview`、`overview/:id`、`map`、`usage`、`usage/:id`、`usage/:id/evidence`、`local`、`local/:id`、`archives`、`operations`，以及 `refresh`、`favorites`、`sources`、`preview`、`apply`。分页只影响返回明细；所有历史事件参与相应范围统计。管理记录按资源范围筛选，不把历史使用日期当成操作日期。

`GET /api/v1/resources/map` 返回同一已发布版本下的完整轻量节点，包括正值、零值与待检查三个集合；复用总览缓存，仅在地图视图按需查询。支持 `kind`、`client`、`from`、`to`、`q`、`candidate`，以及地图专属的 `metric=calls|sessions|reads`、`maxValue` 非负整数；MCP 不支持读取指标。列表页码和排序不限制地图，不为绘图重新索引原始历史，也不返回 MCP 注册正文。

管理状态保存于数据目录的 `resources.sqlite`，恢复材料位于 `resource-vault/`，独立于 `index.sqlite`；收藏、手动来源、记录与恢复材料不随历史清缓存删除。管理库及材料使用受限权限，可能包含恢复所需的私密配置；不要上传或加入发布包。清除回收材料不声称其他系统备份也已清除。
