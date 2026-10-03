# npm 交付与 Agent 查询 Skill

Type: task
Status: claimed
Blocked by: 06, 07

## Scope

责任文件：skills/agent-manor/、README.md、docs/usage.md、tests/install*.test.ts。
从 npm pack 产物安装运行，验证 CLI／后台／Worker／Web 资源，提供 Agent Skill。说明支持矩阵／缺口、Node 24／Git、缓存位置、清缓存与停止。

## Acceptance

包外目录安装无需再构建；macOS Apple Silicon 后台与 SQLite 成功。独立 Agent 按 Skill 完成覆盖率 JSON、文件和证据回读。真实历史不上传、不提交。不发布 npm、不合并 PR。

## Comments

- 2026-10-03：采用已确认首版规格，自行实现。
