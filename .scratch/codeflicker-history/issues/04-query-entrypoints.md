# 客户端声明贯通 Web／CLI／API

Type: task
Status: ready-for-agent
Blocked by: 02

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
