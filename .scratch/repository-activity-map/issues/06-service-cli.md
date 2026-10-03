# 本地 API、后台生命周期与 CLI

Type: task
Status: ready-for-agent
Blocked by: 02, 05

## Scope

责任文件：src/server.ts、src/service/、src/cli.ts、tests/service*.test.ts。
Fastify API、静态 Web、CLI JSON／人类输出、自动启动、启动更新检查、任务等待、状态／停止、分页活动和原始证据回读。协议见 implementation-contract.md。

## Acceptance

同筛选／版本 API 和 CLI 一致，覆盖热点、未观察到读取、目录／文件／证据。回环绑定、登记仓库路径、拒绝穿越和跨站写入。并发启动只有一个后台，网页关闭后可查询，显式停止。

## Comments

- 2026-10-03：采用已确认首版规格，自行实现。
