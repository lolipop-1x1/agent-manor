# OpenCode 与 ZCode 适配

Type: task
Status: claimed
Blocked by: 03

## Scope

实现 SQLite 会话／消息／part 的只读适配，ZCode 同原生任务索引合并。只修改两类适配器、SQLite 共享读取 helper 及匿名测试。

## Acceptance

- 一致快照包含已提交 WAL，选择器和原始记录身份稳定，旁路标题／项目变化使缓存正确失效。
- OpenCode Task 子会话与 fork 语义区分，用量按已核验版本归一化。
- ZCode 任务和消息按 ID 关联；模型请求、尝试、轮次汇总与工具执行记录择取且不重复计数。
- 缺失工具结果、未确认父类型和不完整用量明确保留，不按相似引擎猜测。
