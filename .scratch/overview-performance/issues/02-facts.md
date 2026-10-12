# 按修订持久化事实与活动汇总

Type: task
Status: claimed
Blocked by: 01

## Context

[规格](../spec.md)。事实实现者负责 `src/overview/facts*.ts`、必要的 `src/sessions/store.ts` 查询方法及对应存储测试；不修改服务、界面和翻译。

## Scope

按不可变修订缓存窄事件／资源／请求事实，持久化活动聚合、按范围及来源查询，未变修订跨版本复用。核心统计避免全历史 JSON／V8 解压，提供分区服务需要的内部接口。

## Acceptance

旧版本失效、复制排除、未知、日期、连续、权限、损坏回退及增量复用测试通过；发布内部接口给服务实现者。

## Answer

## Comments

已认领。
