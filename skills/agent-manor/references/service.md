# 服务、安装与维护

用于用户要求启停、诊断或更新。普通查询按需启动后台；查询完不要停止用户服务。

```sh
am status --json
am start --wait-data --timeout 300 --json
am web --no-open --json
am ready --timeout 300 --json
am logs --lines 100 --json
am stop --wait --json
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
| stop / `--wait` | 用户要求关闭时执行；stopped=true 表示已停止，false 表示没有可停止实例，不等于失败 |
| logs / `--lines` / `--follow` | 默认100行，follow 持续读；JSON 为 path/text 或增量对象，避免把日志导入公共资料 |
| version / `--cli-version` | 命令返回 version/apiVersion/node/platform/arch；开关仅显示软件版本，与业务快照无关 |
| doctor | 不启动服务；返回运行环境、数据目录和 checks，检查失败退出非零 |
| update `--check` / `--to <version>` | 显式检查／升级公共 npm 版本；实际升级前核对目标、在途任务及恢复材料，按用户要求执行 |

start 关闭终端后仍运行；status、version、help、doctor、logs 不会隐式启动。`preparation.state` 的准备状态与 HTTP 可连接分开，已有数据可继续查询。自动刷新返回 skipped/disabled 无任务时不是执行失败；要主动同步用 `sessions refresh --mode quick --wait`。

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
