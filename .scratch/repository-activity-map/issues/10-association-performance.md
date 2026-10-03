# 真实历史归属查询性能

Type: task
Status: resolved
Blocked by: 03, 05

## Scope

责任文件：src/history/index.ts、tests/history-association*.test.ts、docs/design/association-performance.md。
真实冻结样本每轮约 24 秒；同 commonDir 的每个路径和片段重复执行 Git worktree 根查询。
在一次关联调用内复用已验证的 worktree 根查询，保留每条路径的约束和不同调用间重新核验。
不引入全局永久身份缓存，不改变事件、覆盖与近似规则。

## Acceptance

同输入的关联结果一致，独立 clone 与不同 worktree 不被合并；跨调用身份变化重新验证。
复测同一冻结输入并记录优化前后耗时与查询计数，实际规模和不能分摊的内存边界明确说明。

## Answer

- 2026-10-04：实现提交 `83d3eba7207c922ad45ad238669d171e05fc187a`，以 `--no-ff` 合并到集成分支，合并提交 `dceb66b6d15d83f7b5fd259cbb27ee90784c890a`。
- `associateSource()` 在单次调用内按规范化 cwd 缓存成功解析的 worktree 根目录；commonDir、逐事件／片段路径包含校验、独立 clone 隔离和跨调用重新核验均保留，无需更新 parser 规则版本。
- 冻结 A 来源及对应 baseline 的单次关联结果指纹相同：关联后 160 个事件、492 个片段、19 个 `range_unknown` gap；`--show-toplevel` 从 580 次降到 1 次，耗时从 17,145.656 ms 降到 284.519 ms。该测量只覆盖一次 `associateSource()`，没有据此推算完整刷新提速。
- `node --import tsx --test tests/history*.test.ts`（36/36）、`npm run check:server` 和 `npm run build` 均通过。生产 Web 构建有非阻塞的 500 kB chunk 体积提示。存储与 RSS 限制见 [归属性能说明](../../docs/design/association-performance.md)。

## Comments

- 2026-10-04：真实索引探测发现重复 Git 查询，取证见仓库外 association-performance.md。
