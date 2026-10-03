# 真实历史归属查询性能

Type: task
Status: claimed
Blocked by: 03, 05

## Scope

责任文件：src/history/index.ts、tests/history-association*.test.ts、docs/design/association-performance.md。
真实冻结样本每轮约 24 秒；同 commonDir 的每个路径和片段重复执行 Git worktree 根查询。
在一次关联调用内复用已验证的 worktree 根查询，保留每条路径的约束和不同调用间重新核验。
不引入全局永久身份缓存，不改变事件、覆盖与近似规则。

## Acceptance

同输入的关联结果一致，独立 clone 与不同 worktree 不被合并；跨调用身份变化重新验证。
复测同一冻结输入并记录优化前后耗时与查询计数，实际规模和不能分摊的内存边界明确说明。

## Comments

- 2026-10-04：真实索引探测发现重复 Git 查询，取证见仓库外 association-performance.md。
