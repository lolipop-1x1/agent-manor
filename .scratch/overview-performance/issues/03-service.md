# 分区服务、核心洞察与按需调查

Type: task
Status: resolved
Blocked by: 01

## Context

[规格](../spec.md)。服务实现者负责 `src/overview/` 中除事实实现者文件外的服务与计算、overview routes/input、必要的 `src/server.ts` 接入及对应服务测试；不修改 SessionStore、界面和翻译。可完善新增共享类型，但先通知页面实现者。

## Scope

复用 UsageManager 持久汇总，提供 snapshot／panel／detail，缩减首页结果，按需派生调查。核心洞察最多五条，移除两期仓库比较，持久化有界分区结果并合作调度。生产事实集成依赖任务 02，接口及独立逻辑可先完成。

## Acceptance

快照严格绑定、缓存验证／回退、分区隔离和分页完整性通过；不隐藏全量细项预计算。完整 report 兼容与旧统计等价。

## Answer

已提供独立 snapshot／panel／detail 与分页证据，首页最多五条有价值洞察；两期热点字段、计算与洞察移除。复用用量小时汇总与有界分区结果，等价日期缓存、全局过程复用、页内批量恢复与闲置 Worker 回收已完成。独立评审发现的请求分母、观察分页、费用覆盖和写入角色问题均已修复；真实统计对照通过。

## Comments

已认领。

已整合并通过专项、统计差分与独立评审。
