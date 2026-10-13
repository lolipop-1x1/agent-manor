# 用量时间主图速度视图

Type: task
Status: ready-for-agent
Blocked by: 01

## 范围

实现[规格](../spec.md)的时间主图局部指标、可搜索计时分组、日期折线、未知断线、按需明细、稳定刷新与状态恢复，补齐中英文与前端模型测试。

## 所有权

`web/features/usage/`、`src/i18n/locales/en/usage.ts`、`src/i18n/locales/zh-CN/usage.ts` 与相关前端测试。后端与共享契约由任务 01、02 提供；浏览器脚本由任务 04 负责。

## 验证

类型、国际化、路由往返和图表数据模型测试；浏览器整体验收在任务 04 进行。

## Comments

- 等待共享契约完成。
