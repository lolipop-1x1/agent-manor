# 内置客户端注册与历史格式适配边界

Type: task
Status: resolved
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

## Answer

- 共享客户端声明位于 [src/clients.ts](../../../src/clients.ts)，`CLIENTS`、`clientIds`、`clientName` 无 Node 依赖；稳定 ID 为 codex / claude / codeflicker，名称与缩写保持 Codex / CX、Claude Code / CC、CodeFlicker / CF。
- Node 来源注册与格式注册分别位于 [适配器注册](../../../src/history/adapters/index.ts)。默认根、环境变量与显式 roots 分开；未指定某客户端 roots 时仍用其 env / 默认根，空数组明确停用。Worker 只传 roots 纯数据。
- [格式接口](../../../src/history/adapters/types.ts) 提供头部元数据、记录处理、工具证据抽取、可选格式合并及证据回读；Codex / Claude 原始格式已移出通用主循环。通用引擎继续负责物理 JSONL 游标、前缀 hash、配对、事件身份、追加与缺口。新格式只需适配器和注册。
- 客户端身份和 format 分别保存在来源、游标及原始引用；`parseSource(path, client, previous?, format?)` 兼容旧调用。refresh 传入发现／缓存来源格式，SQLite 的来源摘要也保留 format；没有表结构迁移。工具归一在 `extract` 边界完成，`event.tool` 和原始输入不改名。
- 原始 JSONL 证据统一通过格式适配器回读，保留普通文件、符号链接拒绝、物理行 hash 和读后路径核验；旧版未带 format 的 Codex / Claude 引用仍按已保存 sourceId 的客户端前缀找到内置格式。
- 解析规则版本升为 5，以重建旧游标。对比 5943f07 的 codex-modern、codex-legacy、claude-tools 三份样本，除 format / ruleVersion 外，来源与事件 ID、物理行与 hash、片段、缺口及游标一致。
- 验证：`npm run check:server` 通过；历史／索引测试 60 / 60 通过，最终补充断言后针对适配器与持久化复跑 17 / 17 通过；`git diff --check` 通过。
- 本任务未实现 CodeFlicker 原始格式，未注册格式明确产生 unsupported_format；03 通过新适配器注册接入。本任务未进行本机 CodeFlicker 来源或产品端到端验收。

- 2026-10-05：稳定接口说明提前保存到 `/private/tmp/agent-manor-codeflicker-notes/adapter-contract.md` 供 03 / 04 使用；必要测试显式停用本机 CodeFlicker 根，避免扫描非测试历史。
