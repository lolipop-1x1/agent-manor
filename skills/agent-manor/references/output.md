# 公共参数、返回值与恢复

## 命令与输入约定

下文命令中的 `<sessionId>` 等是占位符，不要把尖括号传给 shell。先从上一步 JSON 取值；路径含空格时作为一个参数传入。布尔开关如 `--json`、`--wait` 不接值；形如 `--include-speed <value>` 的选项必须显式传 `true` 或 `false`。以实际 `--help` 的占位符为准。

| 参数 | 用法及含义 |
|---|---|
| `--json` | stdout 输出当前命令的结果对象，不包一层 data；失败 JSON 在 stderr，退出码非零 |
| `--full` | 跳过摘要投影及 CLI 默认分页／节点上限注入，未指定时采用端点默认值；不取消分页。messages 默认会返回整条正文，可能很大 |
| `--home <path>` | 本次数据目录；影响服务发现和配置。隔离测试必须同时隔离客户端历史来源 |
| `--lang en` / `--lang zh-CN` | 本次显示语言；API 字段、ID、枚举及 JSON 不翻译；auto 跟随偏好 |
| `--query '<JSON对象>'` | 查询参数补充，使用 camelCase API 键；同名专用参数优先。不是写入正文 |
| `--input <file>` / `--input -` | 从 UTF-8 JSON 文件／stdin 读**对象**，最大 2 MiB；不接受数组或 null |
| `--data '<JSON对象>'` | 与 input 二选一，短内容可用；复杂正文、换行和路径优先用文件避免转义错误 |
| `--wait --timeout 120` | 等待后台任务终态；秒数必须 >0 且 ≤3600，默认120；超时不会取消后台任务 |

示例使用 POSIX shell 单引号；Windows PowerShell 遇到 JSON 转义差异时，改用 UTF-8 文件加 `--input`。执行 CLI 的程序应直接传参数数组，不拼 shell 命令。

```sh
am sessions list --page 1 --page-size 5 --json
am usage report --clients '["codex","claude"]' --json
am sessions list --query '{"pageSize":5}' --page-size 2 --json
```

第三条实际每页2条。不是所有过滤器都支持数组：`--project` 是单个路径，`--projects` 才是 JSON 字符串数组；`--kinds`、`--categories` 是逗号分隔文本。

## 返回值怎样继续使用

| 字段 | 语义及下一步 |
|---|---|
| `version` | 当前结果快照；继续翻页／读详情传回同一版本，不能用软件版本代替 |
| `total` / `page` / `pageSize` | 完整匹配数量／从1开始的当前页／每页上限；不是本页数组长度 |
| `hasMore` | 有后续页；未提供时按 total 和当前分页判断。不同命令数组名可能为 sessions、items、events、jobs、prices |
| `id` | 当前对象身份；session、entry、revision、preview、job、resource ID 不可互换 |
| `stale` / `partial` | 数据过期或覆盖不全，须检查来源及缺口；不能当作完整当前事实 |
| `null` / 缺失字段 | 未知／当前摘要未提供，不能当作0、免费、空正文或没有证据 |

例如 `sessions list` 的 `sessions[].id` → `sessions messages <id> --version <version>`；知识 `items[].id` → `knowledge get`，不是传 `revision.id`。来源已变化时先重新取得版本，不能仅删掉 version 掩盖跨快照问题。

`messages[].textTruncated=true` 时保持同一 session、version、mode、messageId，使用返回的 `nextTextOffset` 继续。数组后续页与单条正文续读是两件事；只有 `nextTextOffset` 消失才读完该条正文。偏移按 Unicode 字符计，不自行按字节累加。

以下是省略了可选字段的合成示例，ID 和版本值只用于说明，不能直接调用：

```json
{
  "version": "snapshot-example",
  "sessions": [{"id":"session-example","title":"缓存验证","client":"codex","project":"/workspace/example","updatedAt":"2026-01-01T10:00:00Z"}],
  "total": 12,
  "page": 1,
  "pageSize": 5,
  "hasMore": true
}
```

此时 total=12 是完整筛选数量，sessions 是本页对象；下一页保留 version 并传 page=2，读正文则使用 sessions[0].id，不传标题或项目名。

## 失败与后台任务

失败形态示例：`{"error":{"code":"CONTENT_STALE","message":"...","messageDescriptor":{...},"details":{...}}}`；部分字段可能不存在。判断 `error.code` 和退出码，不匹配中英文句子。退出0仅代表这次命令成功：异步任务可能还在 queued/running。

| 错误／状态 | 下一步 |
|---|---|
| `INVALID_INPUT`、Commander 缺参错误 | 核对参数类型、JSON 对象、必填 ID、枚举与本 reference；不盲目重试 |
| `VERSION_NOT_FOUND` / `CONTENT_STALE` | 重新查询快照／最新修订，重建预览；修订冲突先比较最新内容再决定提交 |
| `ANALYSIS_NOT_READY` | 读相应 status 或 jobs；首次准备可用 ready 等待，不解释为空结果 |
| `SOURCE_NOT_FOUND` | 查来源／采集缺口；ID 可能过期或源文件已删除，保留此限制 |
| `CONFIRMATION_REQUIRED` | 返回了具体操作及 digest；交给用户核对，获得该次授权后才传 authorize，不自行批准 |
| `WAIT_TIMEOUT` | 继续用任务 ID 查询；不要重复创建相同任务，也不要当作已停止 |
| `paused` | 暂停成功；resume 才继续，不是 complete |
| `partial` / `failed` / `budget_stopped` | 检查任务错误、失败会话与用量，再决定缩小范围、修配置或 retry |

任务状态名因类型不同而不同：普通任务 complete/completed，知识索引 ready；带 `--wait` 的暂停到 paused 即成功。知识任务完整 events/results 需要 `--full`。完成汇报要同时给对象、范围、关键结果和剩余缺口。
