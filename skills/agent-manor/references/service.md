# 服务、安装与维护

用于用户要求启停、诊断或更新。普通查询按需启动后台；查询完不要停止用户服务。

```sh
am status --json
am start --wait-data --timeout 300 --json
am web --no-open --json
am ready --timeout 300 --json
am logs --lines 100 --json
am stop --json
```

| 命令／参数 | 意义与返回值 |
|---|---|
| start / restart | 启动或重启后台，返回 instance、version、url、logPath；首次自动等待完整历史、索引、用量及默认总览缓存，已有可查询历史的旧目录快速返回；start 复用健康实例，restart 会停止后再起 |
| `--port <number>` | 默认从16666尝试，冲突递增；0 用系统分配。以返回 url/instance.port 为准，不自行猜端口 |
| `--wait-data` | start/restart/web 显式等待本轮启动准备；首次本来就自动等待，已有数据时可用此参数等待后台增量检查 |
| ready | 按需连接服务并等准备完成，返回 preparation、activeTasks 等；timeout 默认120秒，最大3600 |
| status | 不启动后台；running=false 不足以认定已停止，结合 state 区分 stopped/starting/unreachable/foreign；instance 表示发现的实例记录，身份可用性仍看 state；嵌套 status 含 preparation/activeTasks/关键计数 |
| serve | 前台运行，终端关闭会受影响；后台持续运行用 start |
| web / `--no-open` | 首次准备完成后取得真实 URL；默认打开浏览器，no-open 只返回地址，仍遵循首次等待规则 |
| stop / `--wait` | 用户要求关闭时执行；默认取消任务并停止，`--wait` 才等任务先完成。stopped=true 表示已停止，false 表示没有可停止实例，不等于失败 |
| logs / `--lines` / `--follow` | 默认100行，follow 持续读；JSON 为 path/text 或增量对象，避免把日志导入公共资料 |
| version / `--cli-version` | 命令返回 version/apiVersion/node/platform/arch；开关仅显示软件版本，与业务快照无关 |
| doctor | 不启动服务；返回运行环境、数据目录和 checks，检查失败退出非零 |
| update `--check` / `--to <version>` | 显式检查／升级公共 npm 版本；实际升级前核对目标、在途任务及恢复材料，按用户要求执行 |

start 关闭终端后仍运行；status、version、help、doctor、logs 不会隐式启动。`preparation.state` 的准备状态与 HTTP 可连接分开，已有数据可继续查询。自动刷新返回 skipped/disabled 无任务时不是执行失败；要主动同步用 `sessions refresh --mode quick --wait`。

默认停止有2秒清理宽限期，超时由后台自身退出；已提交结果保留，未完成任务后续恢复或重试。停止默认超时5秒，`--wait` 默认30秒；`--timeout <seconds>` 调整命令等待上限，不改变2秒清理宽限期。身份核验失败时先查状态与日志，不按旧 PID 杀进程。旧后台重启为新版本后才具有独立控制通道。

空库首次 `start`/`web` 默认不限数据等待时间，显式 `--timeout <seconds>` 可以缩短；`ready` 默认120秒。已有可查询历史的旧目录即使没有新标记也快速返回；首次初始化中断留下准备中标记时，仍等待全部结果。人读模式持续显示进度：按客户端列出扫描目录及候选来源数，汇总最终选中数；导入展示当前来源、已解析与复用数及解析线程数，仓库阶段包括完成数、当前名称、阶段及阶段进度；JSON 模式保持单个结果，不输出人类进度。`preparation.initial=true` 表示尚未完成首次准备，已有会话版本也可能处于此阶段。失败或超时先检查状态及日志，不反复重建；终端结束等待不停止后台。空目录没有登记仓库，不需要先配置代码地图。

## 配套 Skill 的目标与覆盖

```sh
am skills install --target codex --scope user --json
am skills install --target claude --scope project --project-directory /workspace/example --json
am skills install --target custom --directory /workspace/skills --json
am skills status --target codex --scope user --json
am skills update --target codex --scope user --json
am skills remove --target custom --directory /workspace/skills --json
```

| 参数／结果 | 含义 |
|---|---|
| `--target` | codex/claude/custom；交互安装可不填，由用户选择 |
| `--scope` | user/project；custom 目标通过 directory 指定目录，不传 scope custom |
| `--directory` | 自定义 Skill 的**父目录**，最终加 agent-manor 子目录 |
| `--project-directory` | 项目范围根目录；省略则用执行时当前目录 |
| `--overwrite` | 用户明确要求覆盖时才用；修改过的内容先备份，返回备份位置 |
| 返回的 targetPath/status/version 等 | 以实际返回安装位置、状态和备份路径为准；状态指安装副本，不等于服务状态 |

Codex 用户级为用户 skills/agent-manor，项目级为 `.agents/skills/agent-manor`；Claude 对应 `.claude/skills/agent-manor`。复制整个目录，references 与 examples 一起可用。相同内容副本跳过；修改副本或外来同名目录默认冲突。remove 只允许有效产品安装记录，不把任意同名目录删掉。

完成条件：核实真实服务地址／状态或安装副本内容；升级后区分 CLI 版本、运行后台版本和已打开页面是否已刷新。测试必须用隔离 home、合成客户端历史、临时 Skill 目录，不能关闭或覆盖用户的真实后台。

## 版本检查、提醒与升级

版本检查查询产品发布元信息，不会同步会话或重建索引。`--home` 选择本次管理的后台与备份数据；自动检查开关、忽略版本和检查缓存则属于同一产品安装，各数据目录共用。

```sh
am update status --json
am update --check --json
am update settings get --json
am update settings set --data '{"autoCheck":false}' --json
am update settings set --data '{"ignoredVersion":"0.2.0"}' --json
am update settings set --data '{"ignoredVersion":null}' --json
am --home /workspace/example-data update --dry-run --json
```

| 命令／字段 | 含义与后续动作 |
|---|---|
| `update status` | 只读缓存，不联网、不启动后台；`checkState=unknown` 表示尚无结果，不能推断已是最新版 |
| `update --check` | 立即查询官方稳定版，失败退出非零；有／无更新都保存结果。`--to 0.2.0` 只检查该精确稳定版本，不改默认渠道 |
| `currentVersion/latestVersion` | 当前进程版本与目标发布；latestVersion 可空。`versionRelation` 为 unknown/current/ahead/behind；`updateAvailable=null` 表示未知，不等于无更新 |
| `checkedAt/stale/checkState` | 上次成功检查时间、是否过期和检查状态；failed 后可能仍保留旧元信息，不能按旧结果宣称最新 |
| `compatibility/selfUpdateSupported` | 运行环境是否兼容，以及当前安装能否自行升级；发现新版不代表当前 Node、系统或安装方式可升级 |
| `autoCheck/ignoredVersion` | 安装级自动开关与忽略的精确版本；忽略只关自动提醒，仍能手动检查和安装，更高版本重新提醒 |
| `update --dry-run` | 只预览，不停止后台、不安装。核对 targetVersion、home、installation、service、otherServices、blockers、backup、estimatedBackupBytes、availableBytes 与 dependencyFiles |
| `blockers/otherServices` | 阻断原因和其他目录后台的停止命令；不要擅自执行停止命令。仅目标后台任务可由 `--wait --timeout 300` 等待 |
| `update --to 0.2.0` | 交互展示预览并确认，拒绝降级与预发布；用户取消则返回 cancelled=true |
| `update --yes --wait --json` | 明确授权后安装；JSON 和非交互本身不表示同意，缺少 --yes 返回 CONFIRMATION_REQUIRED 与具体预览。仅用户要求安装后才能传 --yes |
| `updated/installationState/serviceState/preparationState` | 分别表示程序是否安装成功、安装状态、后台状态和数据准备状态；仅升级前在运行的后台才恢复，并保留原端口及等待本次准备完成 |
| `backup/logPath` | 数据及本地依赖文件恢复副本、npm 安装日志。失败保留材料，不承诺程序或数据库自动回滚；不要将本机日志复制到公开资料 |

默认每24小时最多一次自动联网；CLI 对同一目标版本每24小时最多一行提醒，仅用缓存，不影响业务返回或退出码。JSON、CI、非交互、帮助和纯状态不加提醒。`--no-update-check` 或 `AGENT_MANOR_NO_UPDATE_CHECK=1` 只关闭本次进程的自动行为；已有后台的周期任务须通过安装级设置关闭。

源码、临时运行及无法确认依赖归属的 workspace 支持检查，不自行覆盖程序。npm 升级前锁定精确目标、重新核验实例及本地清单，备份后才安装；确认期间目标后台或依赖文件变化会返回 UPDATE_PREVIEW_CHANGED，重新预览。UPDATE_FAILED/UPDATE_INTERRUPTED 后先读取错误 details、status 和 logs，核实当前安装、后台及准备状态，不盲目重试。升级产品不会静默覆盖复制到宿主的 Skill；需要更新副本时另按 `skills update` 的冲突保护流程执行。
