# Skill／MCP 资源盘点与管理

查“装了哪些资源、实际用过什么、哪些入口可停用或恢复”时使用。先区分历史身份、本地正文和入口；这三种 ID 不能互换。

## 盘点与使用证据

```sh
am resources status --json
am resources overview --kind skill --page-size 5 --json
am resources usage --kind mcp --page-size 5 --json
am resources local --page-size 5 --json
am resources detail <identityId> --view usage --json
am resources evidence <identityId> --page-size 5 --json
am resources detail <bodyId> --view local --json
```

| 参数 | 值、默认与限制 |
|---|---|
| `--kind` | skill/mcp；overview 默认 skill，usage/local 可跨类型 |
| `--view` | detail 的 overview/usage/local（默认usage）；ID 必须与视图对应 |
| `--q` / `--client` | 名称关键词／客户端 ID |
| `--project` | usage/local 的项目过滤。overview 当前不消费此字段；用 `--query '{"historyProject":"/workspace/example"}'` 或 locationProject 明确历史／本地位置范围 |
| `--sort` / `--order` | sessions/calls/reads/uses/recent/name；asc/desc |
| `--candidate` | overview: all/used/unused/low/old/review/favorite；local: all/unused/low/old/broken/duplicate/favorite/review（不接受 used）；review 归一为 all，不表示已完成审查 |
| `--low-sessions` / `--inactive-days` | 低使用／长期未使用阈值，默认2/90 |
| `--page` / `--page-size` / `--version` | 摘要默认1/20，最大200；full 未指定时使用端点默认值。固定返回的资源快照版本继续读 |
| `--tool` / `--evidence-kind` | evidence 的工具名／证据类型，先从已返回记录确认值 |

| 字段 | 意义及可传给哪里 |
|---|---|
| `identity.id` | 历史使用身份，用于 detail --view usage/overview、evidence、favorite |
| `body.id` | 本地正文身份，用于 detail --view local；不是可管理入口 |
| `entries[].id` | 本地详情的入口身份，传给 preview --entry-id |
| `stats/usage` | 使用次数和覆盖计数，按字段口径解读，不等于每次都完整读取 |
| `readState/nativeState/managementState` | 当前观察、客户端状态及管理状态，不能仅看一个字段猜测入口可写 |
| `protected/capabilities` | 受保护与允许动作；能力不足不应尝试破坏性操作 |
| `observation/partial` | 采集范围、缺口及不完整性；未观察到使用不等于无价值 |

从 resources map 下钻时，节点 id 是地图身份：先 detail --view overview 取 local[].body.id，再读取本地详情取 entries[].id；不能把地图节点 ID 直接作为管理 entryId。需要刷新盘点时执行 resources refresh，不改历史正文。

## 预览、执行与恢复

```sh
am resources preview disable --entry-id <entryId> --json
am resources apply <previewId> --confirm --json
am resources operations --page-size 5 --json
am resources archives --state recoverable --page-size 5 --json
am resources preview restore --operation-id <operationId> --json
am resources apply <newPreviewId> --confirm --json
```

disable/standby/trash 需 entry-id；restore/purge 需 operation-id。上述 apply 仅在用户已核对本次预览并授权之后执行；示例不是批量修改许可。preview 返回 id/action/method、影响入口、配置变更、恢复说明与有效期；referencesComplete=false 表示引用扫描不完整。预览通常15分钟有效且只能执行一次，来源或目标变化后重新预览。

apply 返回 operation 状态、affectedEntries、恢复位置等；要检查 `status` 和失败详情，进程退出0也可能有 conflict／部分失败，不能只按退出码认定成功。operations[].id 或 archives[].operationId 用于恢复预览的 --operation-id，restore 不覆盖已占用目标。purge 不可作为盘点后的自动清理动作。

## 手动来源与收藏

```sh
am resources source-add /workspace/example/skills --client codex --kind skill --json
am resources source-remove <sourceId> --json
am resources favorite <identityId> --json
am resources favorite <identityId> --off --json
```

source-add 的路径为实际来源；MCP 配置可用 `--format json` 与 `--key-path '["mcpServers"]'`（取决于真实文件结构，不猜）。添加／移除来源和收藏都是用户要求下的管理行为。source 响应的 source.id 用于移除，不是入口 ID。

完成条件：列出实际对象及证据，说明保护与覆盖边界；管理需核实操作终态和恢复材料。只盘点时不变更入口，也不把未知使用记录解释为可删除。
