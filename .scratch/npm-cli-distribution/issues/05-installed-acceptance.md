# 包外实际命令验收与双轴审查

Type: task
Status: ready-for-agent
Blocked by: 01, 02, 03, 04

规格：[整体方案](../../../docs/design/npm-cli-distribution.md)，[能力覆盖清单](../capability-matrix.md)。

## 范围

scripts/e2e-npm-cli.mjs、验证记录、集成修复

## 验收

全量类型/翻译/测试/构建；干净包外安装实际 tarball，检查启停端口冲突、JSON/退出码、会话搜索/消息/导出、知识写读审阅/冲突、Skill 安装与恢复等数据；双轴审查并修复，推送后读回远端。

管理写入与运行验收使用隔离的合成数据，禁止改变真实数据目录、模型 Key 或正在使用的服务。
