# 豆包工作接入设计树

Type: task
Status: claimed

## 已作决策

1. 数据来源：本机来源，不增加云端补全；已确认。
2. 保留策略：缓存清理后沿用 ADR 0005，不新增归档；已确认。
3. 真实验收：允许专用临时目录中的合成任务及少量模型调用；已确认。
4. 支持范围：尽量覆盖全部现有功能，证据不足沿用既有未知、缺口与保护规则；来自需求及现有产品约定。
5. 领域术语：会话缓存属于来源副本，本地缺失不等于远端删除；已记录到 CONTEXT.md。

## 当前前沿

[10 原生操作记录](issues/10-process-cards.md) 正在补齐。用户指出右侧视觉差异及中间过程不可辨认；复现发现 18 张原生卡全部展平为普通上下文。按已核验枚举恢复共享操作元数据、轨迹及调用页的独立卡片统计；上下文快照复用既有指标网格。请求、工具成功及费用边界保持独立。

项目及画像缺失补验已完成，见 [09 元数据补齐](issues/09-metadata-coverage.md)。会话级 workspace、原生上下文窗口和消息结束时间已贯通真实生产刷新、API 及浏览器；完整回归 1324 项、最终相关 25 项及正式 Chrome 11 项通过。独立两轴审查无未处理发现，实现提交 `48f875e` 已推送 main 并回读一致。

初次交付的缓存读取、原生读写任务、产品集成及资源管理验收继续有效；缓存缺失、请求计量及工具身份的未知边界见来源文档，不由用户猜测字段语义。

[接入规格](spec.md) 已确认，按任务依赖图直接在 main 并行开发。主 Agent 统一集成、审查、真实数据与浏览器验收及推送；不创建额外分支、PR 或工作区。

## 任务

- [01 来源调查与隔离验收](issues/01-native-evidence.md)：resolved。
- [02 方案共同理解](issues/02-shared-understanding.md)：resolved。
- [03 原生缓存读取](issues/03-native-cache-reader.md)：resolved。
- [04 历史语义适配](issues/04-history-adapter.md)：resolved；依赖 03 的读取契约。
- [05 本地资源接入](issues/05-resources.md)：resolved。
- [06 产品集成与真实验收](issues/06-integration-validation.md)：resolved；依赖 03、04、05。
- [07 代码审查与修复](issues/07-review.md)：resolved；依赖 06。
- [08 提交与推送](issues/08-delivery.md)：resolved；依赖 07。
- [09 元数据补齐](issues/09-metadata-coverage.md)：resolved；依赖 08。
- [10 原生操作记录](issues/10-process-cards.md)：claimed；依赖 09。
- [原生验收记录](validation.md)：真实缓存产品验证与合成 Chrome 7 项验收完成；缓存更新缺口仍保留。

## 本机证据边界

真实缓存副本和运行记录留在忽略的本机调查目录；本任务仅保存脱敏的方法、结论与支持边界。先前实际解码不等于产品集成验收，待补实验不描述为已完成。

- [来源与支持范围](../../docs/design/doubao-work-sources.md) 和 [公开验收](../../docs/validation/doubao-work.md) 保存最终产品边界；真实材料仅留在忽略目录。
