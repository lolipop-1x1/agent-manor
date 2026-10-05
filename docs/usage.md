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

## 全局会话库

网页顶部选择“会话库”。左侧筛选客户端、项目与时间，中间切换简易／完整／轨迹，右侧以“概览／调用／用量”查看统计。三栏各自滚动，操作区保持可见；侧栏可以折叠与拖动调宽，小窗口通过“会话列表／会话统计”打开抽屉。

对话每页显示 10 个完整消息组，使用首末组、上一轮／下一轮、组编号或页码导航。初始上下文和未知轮次也可能单独成组，因此组位置与用户轮次编号可能不同。完整／轨迹默认折叠过程，搜索或请求定位会自动展开。用户与 AI 正文支持 Markdown，长内容可展开；图片只显示替代文字。全局搜索默认覆盖标题及用户／AI 正文，过程内容可额外选入；会话内命中显示在浮层中，清除搜索恢复原阅读位置。点击用量图、请求编号、工具或资源名称可回到证据记录。

请求用量趋势显示从零开始的 Token 纵轴。鼠标悬浮查看请求编号、模型、时间和输入／缓存读取／输出数值；未记录与零值分开。Tab 聚焦图表后，可用左右方向键切换请求、Home／End 到首末请求、Enter／空格定位消息。

```sh
agent-manor sessions refresh --wait --json
agent-manor sessions status --json
agent-manor sessions list --client codeflicker --page 1 --page-size 50 --json
agent-manor sessions search "状态检查" --json
agent-manor sessions search "工具关键词" --kinds user,assistant,tool_call,tool_result --json
agent-manor sessions messages <sessionId> --mode brief --json
agent-manor sessions messages <sessionId> --mode trace --message-id <messageId> --json
agent-manor sessions profile <sessionId> --include-children --json
agent-manor sessions cacheclear --wait --json
```

会话刷新任务完成状态为 `complete`，与仓库任务的 `completed` 区分。首次启动会自动检查全部历史，无须先登记仓库；首次索引未完成可通过 `sessions status` 查看进度，或 `sessions refresh --wait` 等待。列表／搜索／消息和画像支持 `--version`，同一浏览流程沿用返回的完整版本。`--project none` 筛选无项目会话。

API 为 `GET /api/v1/sessions`、`/sessions/search`、`/sessions/:id/messages`、`/sessions/:id/profile`、`/sessions/status`，刷新用 `POST /sessions/refresh`，清除并重建用 `DELETE /sessions/cache`；会话任务沿用 `/jobs/:id` 查询。默认消息每页 50 条，最多 200。查询参数为 `client/project/from/to/q/kinds/page/pageSize/version`；`kinds` 只限定列表匹配与搜索范围，不删减消息上下文；消息另有 `mode/messageId`，画像另有 `includeChildren=true`。

消息 API 可选择 `pageUnit=turn`，此时默认每页 10 组，返回 `totalTurns`、当前页的 `turns` 元信息和完整消息；`total` 仍为当前视图消息数。`turnPosition` 为当前视图的一基组位置，`messageId` 定位优先于组位置。`toolName` 或 `resourceKind/resourceName/resourceServer` 可以定位首条调用／资源证据，返回 `focusMessageId`；过程记录不属于简易模式，需要完整或轨迹模式。未指定 `pageUnit` 时沿用按消息分页，现有 CLI 查询保持原有行为。

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

覆盖、热点、未观察读取、文件、活动、证据和来源查询支持 `--version`、`--client codex|claude|codeflicker`、`--from`、`--to`、`--categories`、`--directory`。省略客户端时查询全部客户端；CLI 帮助、API 校验与 Web 客户端选项共用客户端声明。时间须为 ISO 8601；起止边界均包含，默认全部可用历史。类别为逗号分隔的 `source,config,docs,unknown`，默认 `source`。来源清单描述该版本的采集来源，客户端筛选可缩小清单；时间／目录／类别筛选不改写来源级计数。热点和未观察读取响应的 `files` 已筛选，`summary` 保持所选范围的分母。

CodeFlicker 使用 `--client codeflicker`，Web 中选择 CodeFlicker，API 使用 `client=codeflicker`。例如 `agent-manor coverage <repositoryId> --client codeflicker --json`；后续文件、活动、证据查询沿用返回的 `version` 和相同筛选。首版历史范围为 `~/.codeflicker/projects` 中的主会话及能够确认关系的子会话；`requests/` 中的请求重放不作为独立活动来源。SQLite 与 `~/.myflicker` 暂未接入。

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
| `AGENT_MANOR_CODEFLICKER_DIR` | 覆盖默认 `~/.codeflicker/projects`；仍排除 `requests/` |
| `AGENT_MANOR_PORT` 或 `serve --port N` | 默认随机空闲端口；仅绑定 `127.0.0.1` |

历史目录环境变量须在后台启动前设置；已有后台使用它启动时的环境。需要切换时先显式 `stop`，再以新环境启动。隔离测试应使用独立 `AGENT_MANOR_HOME`，并把三类历史目录环境变量全部指向测试目录或空目录，防止连接日常后台或读取本机历史。

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
