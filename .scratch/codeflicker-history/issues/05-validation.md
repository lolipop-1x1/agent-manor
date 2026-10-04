# CodeFlicker 数据正确性与端到端验收

Type: task
Status: ready-for-agent
Blocked by: 03, 04

## Scope

责任文件：数据正确性／端到端测试、docs/validation/codeflicker.md、本功能任务状态；问题修复限于规格要求。

## Acceptance

- 独立核对真实源记录的工具调用、成功／失败、读取与修改片段及原始引用；采集缺口有真实原因。
- 已知内容样本给出可手算的预期文件／行覆盖，API／CLI 和页面一致。
- 真实 CodeFlicker 仓库完成登记、刷新、地图、文件下钻、当前代码和证据回查。
- 重复刷新不虚增活动；来源变化及查询筛选有验证。
- 完整类型检查、构建、回归、真实 npm 包安装与浏览器验收通过。
- 以 4cc1adb 为固定点进行 Standards／Spec 两轴审查并修复。
- 显式暂存，推送 main 并回读远端 SHA、分叉状态及工作区；清理本轮 worktree。

## Comments

- 2026-10-05：用户明确要求数据正确性、端到端测试与完成后推送。
