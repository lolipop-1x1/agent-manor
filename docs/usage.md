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

## 命令表

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

覆盖、热点、未观察读取、文件、活动、证据和来源查询支持 `--version`、`--client codex|claude`、`--from`、`--to`、`--categories`、`--directory`。时间须为 ISO 8601；起止边界均包含，默认全部可用历史。类别为逗号分隔的 `source,config,docs,unknown`，默认 `source`。来源清单描述该版本的采集来源，客户端筛选可缩小清单；时间／目录／类别筛选不改写来源级计数。热点和未观察读取响应的 `files` 已筛选，`summary` 保持所选范围的分母。

## 正确解释结果

文件覆盖率用 `summary.readExact.files / summary.fileCount`，行覆盖率用 `summary.readExact.lines / summary.lineCount`；修改使用对应的 `editExact`。分母为零时显示无统计文件／行，不生成百分比。近似覆盖单列，不混入精确覆盖；行范围是一基闭区间 `{start,end}`。

`readCount`／`editCount` 是成功活动次数，未知当前范围仍可能有活动；`activityCount` 按事件身份去重。搜索、失败与未知列可能重叠，不能相加当总活动。`unobserved` 只表示当前观测窗口与采集覆盖下没有观察到成功读取。

`file.contentStale` 为 true 或 `content` 为 null 时，不使用旧范围解释当前代码；先 `refresh --wait` 再取得新版本。刷新失败保留上一完整版本并标过期。来源记录追加不使旧记录引用失效；改写、删除或移动后的旧路径可能不能回查，查看 `unavailable`。单条原始证据回读限额为 16 MiB。

格式兼容按证据结构判断，不保证所有 Codex／Claude 版本：直接工具、可识别 Shell 和明确的调用结果可提取；复杂脚本、未配对结果、重复位置、缺失或截断内容保持未知。详见 [历史支持矩阵](design/history-support.md)、[基线规则](design/baseline-rules.md) 与 [匹配规则](design/matching-rules.md)。

## 数据目录、后台与缓存

| 环境变量／选项 | 默认与用途 |
| --- | --- |
| `AGENT_MANOR_HOME` 或全局 `--home <path>` | `~/.agent-manor`；SQLite 索引、实例信息与锁 |
| `AGENT_MANOR_CODEX_DIR` | 覆盖默认 `~/.codex/sessions` 和 `~/.codex/archived_sessions` |
| `AGENT_MANOR_CLAUDE_DIR` | 覆盖默认 `~/.claude/projects` |
| `AGENT_MANOR_PORT` 或 `serve --port N` | 默认随机空闲端口；仅绑定 `127.0.0.1` |

历史目录环境变量须在后台启动前设置；已有后台使用它启动时的环境。需要切换时先显式 `stop`，再以新环境启动。隔离测试应使用独立 `AGENT_MANOR_HOME`，防止连接日常后台。

```sh
agent-manor refresh <repositoryId> --wait --json
agent-manor cacheclear <repositoryId> --wait --json
agent-manor stop --json
```

清缓存不会删除原始历史，也不抹去仓库登记或手动关联。分析缓存中包含所需历史源码片段，应按本机敏感数据保管；原始会话只读。服务没有开机启动或持续文件监听，关闭网页后继续运行；需要释放进程时显式停止。分析不上传日志、不调用模型。浏览器仅允许同服务 Origin，API 限制 Host 和写入类型，不提供任意绝对路径读取接口。

## 将查询能力交给 Agent

包内 `skills/agent-manor/SKILL.md` 给出固定版本的 JSON 查询、文件与证据回读流程。将整个 `skills/agent-manor/` 目录按客户端约定复制或引用到 Skill 发现目录，并保证 `agent-manor` 命令或安装后的 CLI 绝对路径可用。安装包不会自动改写客户端 Skill／MCP 配置。
