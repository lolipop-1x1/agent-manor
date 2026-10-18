# 02 生成配置与可恢复抽取流水线

Type: task
Status: resolved
Blocked by: 00

## Scope

src/knowledge/manager.ts、config.ts、generation.ts 等模型与任务模块，以及 tests/knowledge-extraction.test.ts；不拥有 sources.ts 或 semantic.ts。长输入、增量覆盖、来源验证、归并、零产出、暂停恢复、自动策略、试抽取和预算。

规格：`docs/design/knowledge-library.md`。接口约定：`.scratch/knowledge-library/implementation.md`。用户已明确授权开发测试，直接 main；CLI 与 Skill 不在范围。

## Acceptance

通过完整方案中对应验收，记录实际检查和未验证边界，不以静态审查冒充真实运行。

## Answer

已完成模型配置、凭据隔离、完整抽取任务与恢复链路，并通过整合审查与最终全量验证。

- `src/knowledge/config.ts`：独立生成与向量配置；输出语言首次显式选择后持久；0600 凭据与任务凭据快照；可选 reasoning effort；默认关闭自动沉淀；提示词恢复默认由同一默认配置导出。
- `src/knowledge/generation.ts`：单并发 OpenAI 兼容调用，完整请求保守预算、超时、有限重试、速率与每日预算；无效或截断输出拒绝入库；估算和服务端实测用量分别保存，并按抽取、归并、试抽取、连接测试分用途统计。
- `src/knowledge/pipeline.ts`：完整轮次优先、超长单轮继续分段；固定输入校验、有界跨段线索、同主题归并、后续纠正和早期证据回读；结构与引用严格校验；同范围旧知识比较、沿用原语言并提出待审修改；零产出与缺少上下文分别表达。
- `src/knowledge/manager.ts`：持久预览、任务、配置快照、阶段进度、暂停/恢复/重试和中断恢复；候选与按消息身份/哈希记录的非连续覆盖原子保存；失败和上下文不足不推进覆盖；后台静默窗口、失败避免重复检查；任务与检查点有界清理。

检查：`npx tsc -p tsconfig.server.json --noEmit` 通过；`node --import tsx --test tests/knowledge-extraction.test.ts` 16/16 通过。测试采用隔离数据库、合成会话与本机假 HTTP 服务，覆盖长输入完整覆盖、纠正、语言/提示词/凭据冻结、非连续增量、原子失败、来源改写、零产出、重试、预算、用量依据、定时检查、分支统计与进程恢复。

集中审查修复后，抽取回归扩展为 19 项：补齐事项解决、时效、适用条件、摘要、主体和事件时间的判重；完整请求预算内的多轮输入保持单段；相关旧知识不覆盖新条目的任务语言。来源限制保留原文及稳定描述符，贯通预览、试抽取与知识快照。`npm run check` 通过；`node --import tsx --test --test-concurrency=1 tests/knowledge-*.test.ts` 共 57/57 通过。并发运行曾发生 Node 原生 SQLite 绑定在既有用量 Worker 初始化时中止；串行全知识回归正常，此处未把该原生中止算作功能断言失败后忽略。

真实本机模型及获准历史会话的效果验证由整合任务单独记录；单测不证明模型能正确判断全部事实或语言。主题数、单次候选、来源与状态容量均有显式上限，超过预算时保留未完成状态，不截断后假装完成。

最终默认并发全量测试 1,580/1,580 通过；真实模型与语言核读边界见 docs/validation/knowledge-library.md。
