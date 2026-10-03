---
name: agent-manor
description: 使用本机 AgentManor CLI 查询 Codex 或 Claude Code 在 Git 仓库中的历史读取、修改、覆盖率与原始证据；适用于需要可回查代码活动的任务。
---

# AgentManor 查询

使用安装后的 `agent-manor` CLI 和 `--json`，查询与 Web 共用的本地分析结果。若命令未在 PATH，使用 `node <安装包目录>/dist/cli.js`；本 Skill 在包内 `skills/agent-manor/`，CLI 是其上两层的 `dist/cli.js`。查询可从任意 cwd 执行，无需构建源码或直接访问 SQLite。

## 查询到证据

1. 用 `repositories --json` 查找用户指定的仓库。未登记时执行 `register <绝对仓库路径> --wait --json`，取 `repository.id`，确认 `job.status === "completed"`。若需要隔离测试，在启动前设置独立的 `AGENT_MANOR_HOME` 和两类历史目录环境变量。
2. 按用户范围执行 `coverage <repositoryId> --json`，可加 `--client codex|claude`、`--from/--to <ISO时间>`、`--categories source,config,docs,unknown`、`--directory <相对目录>`。默认两客户端、全部历史、源码。保存返回的 `version` 和全部筛选。
3. 选择返回的文件，执行 `file <repositoryId> <相对路径> --version <version> <相同筛选> --json`。查询活动用 `events <repositoryId> --path <相对路径> --version <version> <相同筛选> --page 1 --page-size 50 --json`；结果超过一页时按 `total` 翻页。
4. 用返回活动的 `id` 执行 `evidence <repositoryId> <eventId> --version <version> <相同筛选> --json`，核对 `records[].raw` 和来源引用。只通过 event ID 回读索引证据，不自行读取或执行历史命令。

例如，同一范围连续查询：

```sh
agent-manor coverage <repositoryId> --client codex --directory src --json
agent-manor file <repositoryId> src/example.ts --version <version> --client codex --directory src --json
agent-manor events <repositoryId> --path src/example.ts --version <version> --client codex --directory src --json
agent-manor evidence <repositoryId> <eventId> --version <version> --client codex --directory src --json
```

`--version` 是查询绑定的分析结果版本；程序版本用 `--cli-version`。`ANALYSIS_NOT_READY` 时执行 `refresh <repositoryId> --wait --json`，或从 `status --json` 取得正在执行的 job 后用 `jobs <jobId> --wait --json` 等待。普通查询会自动启动后台，关闭网页不会停止它；只有用户要求停止或隔离测试收尾时使用 `stop --json`。

## 解读与报告

- 报告仓库、版本、`createdAt`、`stale`、筛选与 `gaps`。精确文件／行覆盖率分别用 `summary.readExact.files / fileCount`、`summary.readExact.lines / lineCount`，修改使用 `editExact`；零分母不生成百分比。近似单列，不加入精确百分比。
- `file.contentStale === true` 或 `content === null` 时，不把旧范围套到当前代码。刷新完成后重新查询版本；刷新失败保留旧版，但说明它过期。
- `readCount`／`editCount` 是历史成功活动；搜索、失败、未知范围分别保留，`activityCount` 是去重总次数。各状态列可能重叠，不相加。
- `hotspots <repositoryId> --metric read|edit|activity --json` 和 `unobserved <repositoryId> --json` 同样保持版本与筛选。未观察读取不表示无用或安全可删。
- `evidence.unavailable` 表示记录已变化、不可读或超过回读限额；不补造原文。来源追加后的旧记录仍可回查。
- `sources <repositoryId> --version <version> --json` 查看来源与归属缺口。只有用户已确认关系时用 `associate <repositoryId> <sourceId> --wait --json`；原始历史始终只读。`cacheclear <repositoryId> --wait --json` 清派生缓存并重建，保留登记与关联。

完整命令、环境变量和支持边界见包内 [使用指南](../../docs/usage.md)。分析索引包含历史源码片段；不要把个人源码或原始会话复制到提交、PR 或外部服务中。
