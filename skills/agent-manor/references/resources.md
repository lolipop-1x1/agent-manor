# 资源盘点与管理

用于找本地 Skill／MCP、核查实际使用来源，以及管理可恢复的入口。

1. `am resources overview --json` 查询清单，`am resources usage --json` 查询使用，`am resources local --json` 查询本地位置。通过命令帮助指定 kind、客户端、日期和关键词。
2. 默认清单提供身份、核心统计、保护状态和位置数量。用返回的 `body.id` 执行 `am resources detail <id> --view local --json` 读取具体入口，再用入口 ID 预览管理；使用记录的 `identity.id` 用于详情与证据。完整清单字段也可通过 `--full` 读取。`am resources map --help` 取得地图数据。名称汇总不表示同一物理文件；共享位置和独立注册项分别处理。
3. 需要修改时先用 `am resources preview --help` 预览目标、范围、冲突、恢复方式。把预览交给用户核对，按已授权操作调用 `apply`，不按名称批量操作所有位置。
4. 使用 `archives` 和 `operations` 查看回收及操作记录；恢复同样先预览并核对冲突。

历史调用、成功正文读取与配置中存在分别表达。未观察调用不等于从未使用，也不是自动回收依据。原生配置、共享文件、符号链接和只读缓存的支持范围以实际返回可执行动作为准。

地图默认保留所选指标、未知值和观察/保护状态；节点 ID 先用 `resources detail <id> --view overview` 读取本地本体，再以 `local[].body.id` 查询具体位置，不能直接把地图身份当作本地入口 ID。其他指标、别名收藏和完整诊断使用详情或 `--full`。

本产品配套 Skill 安装与更新由 `am skills` 管理，见 [服务与安装维护](service.md)，不通过资源名称猜测模板位置。
