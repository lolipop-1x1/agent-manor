# 内置客户端注册与历史格式适配边界

Type: task
Status: claimed
Blocked by: 01

## Scope

责任文件：src/clients.ts、src/contracts.ts、src/history/index.ts、src/history/types.ts、src/history/adapters/、src/service/files.ts、src/version.ts 和相关核心回归测试。
建立共享客户端声明，客户端身份与历史格式分离，Node 历史适配器负责来源元数据、记录处理与证据回读；保持通用 JSONL 游标、配对、事件、匹配和统计模型。
02 不实现 CodeFlicker 原始格式，03 在此接口上扩展。

## Acceptance

- 新客户端不需修改通用发现／解析主循环；客户端信息可供所有查询入口复用。
- 保持 Codex／Claude 既有证据、事件身份、增量、归属、分叉行为；历史回归测试通过。
- 默认根、环境变量与显式 roots 保持兼容；Worker 仅传纯数据。
- 外部证据回读通过格式边界，现有物理行／哈希验证保持不变。
- 提供 03／04 所需接口与说明；不引入动态插件系统。

## Comments

- 2026-10-05：用户授权实施，开始认领。
