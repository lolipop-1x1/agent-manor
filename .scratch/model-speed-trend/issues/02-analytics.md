# 速度事实与日期聚合

Type: task
Status: ready-for-agent
Blocked by: 01

## 范围

实现[规格](../spec.md)的后端统计：精简事实计时、格式回填、小时汇总、全筛选与精确路径、选中组日期序列、HTTP 输入和后端回归。仅在速度请求返回新增结果。

## 所有权

`src/sessions/usage-facts.ts`、`src/usage/`、用量查询输入及必要 Worker 接入、相应后端测试。共享契约已由任务 01 提供，前端由任务 03 负责。

## 验证

覆盖规格验收 1、2；核对常规路径和精确路径结果、版本升级与原用量回归。

## Comments

- 等待共享契约完成。
