# OpenCode 与 ZCode 适配

Type: task
Status: resolved
Blocked by: 03

## Scope

实现 SQLite 会话／消息／part 的只读适配，ZCode 同原生任务索引合并。只修改两类适配器、SQLite 共享读取 helper 及匿名测试。

## Acceptance

- 一致快照包含已提交 WAL，选择器和原始记录身份稳定，旁路标题／项目变化使缓存正确失效。
- OpenCode Task 子会话与 fork 语义区分，用量按已核验版本归一化。
- ZCode 任务和消息按 ID 关联；模型请求、尝试、轮次汇总与工具执行记录择取且不重复计数。
- 缺失工具结果、未确认父类型和不完整用量明确保留，不按相似引擎猜测。

## Answer

OpenCode 与 ZCode 的只读一致快照、旁路元信息、原始定位及模型用量已接入。原生验收分别核对 11 和 9 个会话；匿名回归覆盖已提交 WAL、未知记录保留、压缩／注入、独立文件附件、终态及读取预算。两轴评审发现全部修复并复核，见 [验收记录](../../../docs/validation/additional-agent-history.md)。
