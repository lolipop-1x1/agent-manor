# 仓库生命周期任务图

规格见 [spec.md](spec.md)。用户要求直接在 `main` 开发，所有子任务按文件所有权协作，主任务统一提交和验证。

| 任务 | 依赖 | 状态 | 责任 |
| --- | --- | --- | --- |
| [01 需求确认](issues/01-design.md) | 无 | resolved | 规格、术语、ADR 与共同契约 |
| [02 后台清理与取消](issues/02-backend.md) | 01 | resolved | 单仓库事务、Worker、任务验证 |
| [03 仓库界面](issues/03-web.md) | 01 | resolved | 删除、项目候选及双语界面 |
| [04 HTTP 接口](issues/04-api.md) | 01 | resolved | 删除接口、登记复用及接口测试 |
| [05 完整验收](issues/05-validation.md) | 02, 03, 04 | resolved | 构建、测试、合成浏览器验收 |
| [06 双轴审查](issues/06-review.md) | 05 | claimed | 规范审查、规格审查与修复 |

共同契约：地图任务增加 `cancelled` 终态用于内存等待者收束，旧任务数据库记录仍删除；重复登记响应没有 `job`；删除响应返回 `repositoryId`。

后台提供 `AnalysisStore.registerRepositoryResult(path)` 返回 `{ repository, created }`，既有 `registerRepository(path)` 保持返回仓库；`WorkerManager.deleteRepository(id)` 负责目标任务撤销和完整清理。HTTP 层只在 `created` 时启动分析。

已完成实现、类型与翻译检查、构建和完整 636 项自动测试；隔离合成浏览器 8 组通过，验收方法与边界见 [验收记录](../../docs/validation/repository-lifecycle.md)。
