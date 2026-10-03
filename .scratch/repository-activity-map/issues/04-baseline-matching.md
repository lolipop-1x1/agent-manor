# 仓库基线、内容对应与覆盖统计

Type: task
Status: resolved
Blocked by: 02

## Scope

责任文件：src/analysis/、tests/analysis*.test.ts、docs/design/matching-rules.md、docs/design/baseline-rules.md。
worktree 盘点、内容哈希、分类／排除／物理行计数、精确定位、近似校准、筛选后范围并集、覆盖率、热点和未观察到读取。

## Acceptance

验证插入行、单字符、短行、重复内容歧义、删除、撤销编辑。新插入行不算读取，近似独立；Unicode 码点增删之和，版本与预算明确。已删除／未跟踪／忽略／符号链接／子模块／独立 clone 与 worktree 有口径。筛选在并集前，分母可核对。

## Comments

- 2026-10-03：采用已确认首版规格，自行实现。

## Answer

- 仓库基线、内容对应与覆盖统计提交：`dc401a178c5296d7623491347346236e9c583512`；独立分支以 `--no-ff` 合并，合并提交：`e6f1ebfe6e506598708acd48c271040107bd6db4`。已有共享契约内容自动合并，未产生额外差异。
- `npm run check:server`、`node --import tsx --test tests/analysis*.test.ts`（23/23）和合并差异 `git diff --check` 均通过。
- 测试覆盖基线盘点、worktree／clone／子模块边界、范围并集前筛选、精确／近似对应、重复歧义、插入／删除／撤销、Unicode 码点及预算未知口径；预算超限保留未知符合规格。真实历史端到端与性能验收留到集成验收阶段。
