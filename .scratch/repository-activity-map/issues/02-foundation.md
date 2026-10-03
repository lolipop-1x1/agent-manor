# 基础工程与共享契约

Type: task
Status: resolved
Blocked by:

## Scope

责任文件：package.json、package-lock.json、tsconfig*.json、vite.config.ts、scripts/、src/contracts.ts、src/version.ts、.gitignore。
正式 TypeScript 工程、锁定依赖、npm 构建和测试命令、共享契约（见 ../implementation-contract.md）。不实现分析、服务或页面，不引入原型路由。

## Acceptance

Node 24 可安装，better-sqlite3 可加载；后台、Worker 与 Web 构建到 dist；测试运行 tests/*.test.ts；npm pack 只包含交付文件。

## Comments

- 2026-10-03：采用已确认首版规格，自行实现。

## Answer

- 基础工程与共享契约提交：`e836d6d9c7eabc317e2a7e245056e4ba5a66d7a8`，以 `--no-ff` 合并到正式集成分支，合并提交：`87f658d8cd8a716d45c1d42744851f7d7ff090eb`。
- 集成树使用 Node `v24.19.0`；`npm run check:server`、`npm run test:sqlite` 和合并差异 `git diff --check` 均通过，SQLite `3.53.4` 在 macOS arm64 上可加载。
- 变更仅包含本票责任文件；未加入 Web／CLI 空壳入口。
