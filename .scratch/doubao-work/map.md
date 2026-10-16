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

用户报告项目及用量缺失后的复核发现会话级 workspace、原生上下文窗口和消息结束时间可以补齐，见 [09 元数据补齐](issues/09-metadata-coverage.md)。本轮保持本机边界与未知口径，补齐后重新执行真实产品及浏览器核验。

没有新的产品行为选择。真实来源、原生读写任务、产品集成与合成浏览器验收已完成；独立审查发现已统一修复并通过两轴复核，214 项针对性回归通过；完整回归 1312 项、补充 UI 35 项、Chrome 10 项及包外安装均通过；功能已推送 main 并确认远端一致，任务记录完成收尾。已确认的支持与未知边界记录在来源文档，不由用户猜测字段语义。

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
- [09 元数据补齐](issues/09-metadata-coverage.md)：claimed；依赖 08。
- [原生验收记录](validation.md)：真实缓存产品验证与合成 Chrome 7 项验收完成；缓存更新缺口仍保留。

## 本机证据边界

真实缓存副本和运行记录留在忽略的本机调查目录；本任务仅保存脱敏的方法、结论与支持边界。先前实际解码不等于产品集成验收，待补实验不描述为已完成。

- [来源与支持范围](../../docs/design/doubao-work-sources.md) 和 [公开验收](../../docs/validation/doubao-work.md) 保存最终产品边界；真实材料仅留在忽略目录。
