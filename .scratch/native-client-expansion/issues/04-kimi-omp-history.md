# Kimi 与 Oh My Pi 原生历史

Type: task
Status: ready-for-agent
Blocked by: 02

## 目标

实现新版 Kimi 工作区、会话及 Agent 层级的 v2 wire；实现 Oh My Pi v3 事件树、独立用量、分支、子 Agent 和辅助元信息。独立客户端身份不能由共用引擎代替。

## 验收

- 验证消息、工具配对、undo、压缩、父子与 fork 身份及源端未保存字段的缺口。
- 消息用量、model_usage 与工具专用用量不重复或错误合并。
- 追加与重写正确刷新，原始证据可按引用回读。

## Comments
