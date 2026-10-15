# 会话搜索性能任务地图

## 已作决策

- 单字与相邻双字使用无正文副本的精确词项，三字符以上使用 trigram 候选及 LIKE；保留字面语义、精确计数和旧版本。
- 在既有刷新 Worker 内分批迁移；查询只有在补索引完成后启用候选过滤。
- 全局搜索不请求被隐藏的普通会话列表。

## 任务

- [01 搜索性能与语义验证](issues/01-indexed-search.md)
- [02 单字与双字搜索优化设计确认](issues/02-short-query-design.md)：已确认先建立基线、速度优先，空间按实测评估。
- [03 短词索引与查询隔离](issues/03-short-query-implementation.md)：已完成实现、验证及本机启用。

## 已完成

- [01 搜索性能与语义验证](issues/01-indexed-search.md)：同版本响应完全一致，真实关键词耗时由数十秒降至毫秒；218 项回归及 Chrome 端到端通过。
- [03 短词索引与查询隔离](issues/03-short-query-implementation.md)：字符索引、共享匹配、只读搜索线程、取消、范围存在性及前端请求收敛；真实实验与 Chrome 验证完成。
