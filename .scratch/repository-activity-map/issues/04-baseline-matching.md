# 仓库基线、内容对应与覆盖统计

Type: task
Status: claimed
Blocked by: 02

## Scope

责任文件：src/analysis/、tests/analysis*.test.ts、docs/design/matching-rules.md、docs/design/baseline-rules.md。
worktree 盘点、内容哈希、分类／排除／物理行计数、精确定位、近似校准、筛选后范围并集、覆盖率、热点和未观察到读取。

## Acceptance

验证插入行、单字符、短行、重复内容歧义、删除、撤销编辑。新插入行不算读取，近似独立；Unicode 码点增删之和，版本与预算明确。已删除／未跟踪／忽略／符号链接／子模块／独立 clone 与 worktree 有口径。筛选在并集前，分母可核对。

## Comments

- 2026-10-03：采用已确认首版规格，自行实现。
