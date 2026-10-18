# 01 知识持久化与修订审阅

Type: task
Status: resolved
Blocked by: 00

## Scope

src/knowledge/store.ts 和 tests/knowledge-store.test.ts；遵循 implementation.md 的 KnowledgeStore 契约。完整快照、幂等、并发冲突、默认查询、标签/范围/来源筛选、可用性与独立持久数据。

规格：`docs/design/knowledge-library.md`。接口约定：`.scratch/knowledge-library/implementation.md`。用户已明确授权开发测试，直接 main；CLI 与 Skill 不在范围。

## Acceptance

通过完整方案中对应验收，记录实际检查和未验证边界，不以静态审查冒充真实运行。

## Answer

已完成 `src/knowledge/store.ts` 与 `tests/knowledge-store.test.ts`，公共来源契约按整合约定增加 `taskId`。

- 独立 SQLite 保存条目、完整修订快照、必要来源摘录、人工审阅及可用性审计，不连接会话索引；数据库权限为 0600。
- 创建、修订、历史恢复一律待审。发布与拒绝核对最新修订，默认读只返回当前已审且有效内容；待审不泄漏到默认详情的正文、候选或修订列表。管理读显式 `review=all`。
- 同步立即事务覆盖修订、结果和处理状态；基础修订 CAS 拒绝旧写入，幂等键相同载荷返回原身份，不同载荷或操作报告冲突。
- 恢复创建新快照且重新审阅；发布不自动恢复已废弃或替代条目。过期与已解决按所读取修订计算，默认搜索排除。
- 关键词支持中文短词、标签、必要证据摘录及大小写无关英文，字面 `%` 与 `_` 不成为通配符。FTS5 trigram 为至少三字符的词缩小候选，短词用 `instr` 保持完整语义；索引删除后可从权威快照重建。
- 项目、视图、客户端、类型、标签、任务、时间和分页在匹配修订上过滤；输入字段、枚举、日期、来源及状态容量严格校验，不能通过提交内容自行声明已审。

实际检查：`node --import tsx --test tests/knowledge-store.test.ts` 10/10 通过，涵盖双连接旧基础冲突、幂等载荷冲突、拒绝与恢复、失效过滤、中文与来源查询、非法输入、事务回滚、重启、全文索引重建及状态清理释放容量。最终 `npm run check:server` 通过。

整合补充：`deleteState` 实际删除状态行，参与调用方事务；10,000 个状态键达到配额后清理一项即可保存新任务，清理回滚恢复原状态，知识及来源证据继续保留。

边界：双连接测试验证 SQLite 立即事务和过时提交，不冒充跨进程压力测试；尚未进行大规模知识库性能测量或真实模型抽取，后者由整体集成验收负责。状态辅助存储限制单项 8 MiB、总量 256 MiB 和 10,000 键；不会自动清理用户知识或证据。
