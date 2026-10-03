# 基础工程与共享契约

Type: task
Status: claimed
Blocked by:

## Scope

责任文件：package.json、package-lock.json、tsconfig*.json、vite.config.ts、scripts/、src/contracts.ts、src/version.ts、.gitignore。
正式 TypeScript 工程、锁定依赖、npm 构建和测试命令、共享契约（见 ../implementation-contract.md）。不实现分析、服务或页面，不引入原型路由。

## Acceptance

Node 24 可安装，better-sqlite3 可加载；后台、Worker 与 Web 构建到 dist；测试运行 tests/*.test.ts；npm pack 只包含交付文件。

## Comments

- 2026-10-03：采用已确认首版规格，自行实现。
