# 客户端声明贯通 Web／CLI／API

Type: task
Status: resolved

## Scope

责任文件：src/service/input.ts、src/server.ts、src/cli.ts、web/、查询入口测试、docs/usage.md、skills/agent-manor/。
使用共享客户端声明替代两客户端假设，沿用既有查询和展示风格。

## Acceptance

- Web 筛选、来源统计、事件标签使用共享客户端信息；CodeFlicker 不显示为 Claude。
- CLI 帮助与 API 校验共用注册表，新增客户端可自动进入查询入口。
- Web／CLI／API 按 CodeFlicker 筛选返回相同版本、文件覆盖、行覆盖与证据。
- 保持现有客户端、错误处理、版本绑定及页面交互兼容；入口回归通过。
- 安装包和 Agent 查询 Skill 的使用说明覆盖新客户端。

## Comments

- 2026-10-05：等待 02 的共享客户端声明接口。
- 2026-10-05：任务 02 已完成；在 `codex/codeflicker-query-entrypoints` 认领，负责共享客户端声明贯通查询入口与使用说明。

## Answer

- API 客户端校验与 CLI 查询帮助使用共享 `clientIds`；Web 客户端选项、来源统计、来源名称、活动名称／缩写和初始空状态使用共享 `CLIENTS`／`clientName`，移除非 Codex 默认为 Claude 的展示。
- 查询与统计仍由通用 API、完整分析版本和匹配规则提供；未增加客户端专属覆盖逻辑。使用通用事件发布包含 CodeFlicker 读写与 Claude 读取的测试版本，验证 CLI／API 的版本、覆盖、文件、活动、来源及物理行证据一致，CodeFlicker 筛选不混入 Claude。
- 既有 CLI 真服务测试设置 `AGENT_MANOR_CODEFLICKER_DIR`，HTTP 测试显式 `codeflicker: []`，防止读取本机默认来源。
- [使用指南](../../../docs/usage.md) 与 [Agent 查询 Skill](../../../skills/agent-manor/SKILL.md) 增加 CodeFlicker 筛选、来源环境变量和隔离测试说明；首版仅 `~/.codeflicker/projects`，排除 `requests/` 独立计数，SQLite／MyFlicker 延后。
- 验证：`npm run check` 的 server／web 检查通过；`node --import tsx --test tests/service-http.test.ts tests/service-cli.test.ts tests/web-model.test.ts tests/web-api.test.ts` 17 项通过。初次受沙箱 `listen EPERM` 限制，允许临时本机监听后同一命令通过。
- 原生 CodeFlicker 格式及真实来源 Web／安装包闭环由 03／05 完成；本任务的查询测试不宣称验证原始格式解析。
