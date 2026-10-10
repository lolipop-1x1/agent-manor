# 仓库生命周期任务图

规格见 [spec.md](spec.md)。用户要求直接在 `main` 开发，所有子任务按文件所有权协作，主任务统一提交和验证。

| 任务 | 依赖 | 状态 | 责任 |
| --- | --- | --- | --- |
| [01 需求确认](issues/01-design.md) | 无 | resolved | 规格、术语、ADR 与共同契约 |
| [02 后台清理与取消](issues/02-backend.md) | 01 | resolved | 单仓库事务、Worker、任务验证 |
| [03 仓库界面](issues/03-web.md) | 01 | resolved | 删除、项目候选及双语界面 |
| [04 HTTP 接口](issues/04-api.md) | 01 | resolved | 删除接口、登记复用及接口测试 |
| [05 完整验收](issues/05-validation.md) | 02, 03, 04 | resolved | 构建、测试、合成浏览器验收 |
| [06 双轴审查](issues/06-review.md) | 05 | resolved | 规范审查、规格审查与修复 |
| [07 项目列表裁剪](issues/07-picker-clipping.md) | 06 | resolved | 弹层挂载、滚动及可见区域回归 |
| [08 最近活动排序](issues/08-project-order.md) | 07 | resolved | 全局项目排序、缓存及界面回归 |

共同契约：地图任务增加 `cancelled` 终态用于内存等待者收束，旧任务数据库记录仍删除；重复登记响应没有 `job`；删除响应返回 `repositoryId`。

后台提供 `AnalysisStore.registerRepositoryResult(path)` 返回 `{ repository, created }`，既有 `registerRepository(path)` 保持返回仓库；`WorkerManager.deleteRepository(id)` 负责目标任务撤销和完整清理。HTTP 层只在 `created` 时启动分析。

已完成实现、类型与翻译检查、构建和完整 639 项自动测试；项目列表裁剪修复及最近活动排序后隔离合成浏览器 12 组通过，验收方法与边界见 [验收记录](../../docs/validation/repository-lifecycle.md)。

规范轴发现 1 项取消结果无界保留的判断性问题，规格轴发现 1 项跨页面删除并同路径重登后保留旧地图的问题，均已修复并回归。两个轴独立记录见 [审查任务](issues/06-review.md)。

用户随后反馈登记项目列表被 Dialog 滚动内容裁剪。弹层改为顶层挂载，并沿用 Radix 模态焦点和滚动机制；新增可见区域命中与真实鼠标滚动检查，见 [任务 07](issues/07-picker-clipping.md)。

会话项目随后改为按全部客户端的最新有效活动时间排序；新存储回归覆盖时区、时间回退及索引发布后的缓存更新，浏览器核对默认候选及清空搜索后的顺序，见 [任务 08](issues/08-project-order.md)。
