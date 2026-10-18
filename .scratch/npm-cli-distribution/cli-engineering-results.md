# CLI 工程实现与验证

Type: research
Status: resolved

## 工程

- `packages/cli/src/program.ts` 注册 Commander 命令树，`commands/` 按领域拆分，`api/` 管理查询、JSON 输入、任务等待与明确管理授权，`output/` 管理语言、摘要及增量日志。
- `src/cli.ts` 保留轻量执行入口与原有测试导出；普通导入不会启动后台。
- `src/sessions/export.ts` 为 Web 与 CLI 共用的完整对话读取及 Markdown 导出规则，固定会话版本与分支，失败不写半份文件。
- 业务命令仅调用已有 HTTP API；普通 JSON 输出稳定，语言不改变字段。凭据查看、人工审阅与可用性修改使用单次、短期、绑定精确请求内容的管理授权，不伪造浏览器请求头。

## 命令覆盖

| 领域 | 已实现入口 | 对应 API |
|---|---|---|
| 总览 | `overview snapshot/panel/review/review-detail/detail/report/evidence` | `/overview/*` |
| 会话 | 保留 `sessions status/list/search/messages/profile/refresh/cacheclear`，增加 `facets/gaps/groups/turns/matches/timeline/cost/locate/auto-refresh/export` | `/sessions/*`；导出复用 messages |
| 代码活动 | 保留全部顶层登记、覆盖、文件、事件、证据、任务命令；增加 `repositories list/register/remove/sessions/gaps/replay-sessions/replay/replay-evidence/auto-refresh` | `/repositories/*`、`/jobs/:id` |
| 用量 | `usage report/status/requests`、`usage pricing get/set/refresh` | `/usage*` |
| 资源 | 保留全部旧命令，增加 `resources map`，读取入口支持附加查询参数 | `/resources/*` |
| 知识 | `knowledge list/search/facets/get/write/revise/revisions/revision/restore/review/availability` | `/knowledge/entries*`、search、facets |
| 知识设置 | `knowledge settings get/defaults/set/key/test/try` | settings、test、prompts/try |
| 沉淀任务 | `knowledge extraction preview/preview-get/start/list/get/pause/resume/retry` | `/knowledge/extractions*` |
| 知识索引 | `knowledge index status/preview/build/pause/resume` | `/knowledge/index/*` |
| 会话语义 | `semantic facets/status/test/preview/search/build/pause/resume`、`semantic settings get/set/key` | `/semantic/*` |
| 偏好 | `preferences get/set` | `/preferences` |
| 生命周期 | `start/serve/status/stop/restart/ready/web/logs/version/update/doctor` | 本机生命周期与状态、更新模块 |
| Skill | `skills install/status/update/remove` | 本机 Skill 管理模块 |

查询入口提供常用参数与 `--query <json>`；写入入口使用 `--input <file|->` 或 `--data <json>`。管理命令缺少明确授权时返回 `CONFIRMATION_REQUIRED`、具体操作、版本、完整确认摘要及核对内容，用户明确授权后以 `--authorize <digest>` 重试。日志跟随的 JSON 模式每行输出一个增量事件。

## 已执行验证

- `npm run check:server`、`npm run check:i18n` 通过。
- `npm run test:cli` 14 项测试通过：包含 74 条新增及兼容业务命令逐条 HTTP 方法、路径、查询和 JSON 数据核对；完整层级中英文帮助；输入对象、空格文件名、等待边界；管理内容与具体版本授权；成功、失败、暂停、预算、部分完成和超时终态；日志增量与 Skill 管理测试。
- `tests/cli-language.test.ts` 与 `tests/session-export.test.ts` 共 12 项通过：语言优先级、错误 JSON 一致、维护状态、状态只读与共享偏好、快照导出完整性。
- `doctor` 实际检查 Node.js、平台、内存 SQLite 查询及向量扩展加载，未创建指定的不存在数据目录。

路由矩阵使用隔离 HTTP fixture 检查 CLI 适配，不把模拟结果等同于业务实际返回。真实后台、源码外 tarball 安装及三平台矩阵由整体交付验收记录统一说明。没有调用真实模型，也没有操作用户的真实数据目录。
