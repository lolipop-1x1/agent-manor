# 分区服务、核心洞察与按需调查

Type: task
Status: claimed
Blocked by: 01

## Context

[规格](../spec.md)。服务实现者负责 `src/overview/` 中除事实实现者文件外的服务与计算、overview routes/input、必要的 `src/server.ts` 接入及对应服务测试；不修改 SessionStore、界面和翻译。可完善新增共享类型，但先通知页面实现者。

## Scope

复用 UsageManager 持久汇总，提供 snapshot／panel／detail，缩减首页结果，按需派生调查。核心洞察最多五条，移除两期仓库比较，持久化有界分区结果并合作调度。生产事实集成依赖任务 02，接口及独立逻辑可先完成。

## Acceptance

快照严格绑定、缓存验证／回退、分区隔离和分页完整性通过；不隐藏全量细项预计算。完整 report 兼容与旧统计等价。

## Answer

## Comments

已认领。
