# 跨 Agent 会话回查

当用户在当前 Agent 继续另一客户端的任务、询问旧结论的原因，或需要核对中间过程时使用。

1. `am sessions status --json` 查看历史准备状态。需要同步时执行 `am sessions refresh --wait --json` 并核对任务成功；首次准备中不当作没有历史。
2. `am sessions search "目标问题或对象名" --json` 检索全部索引。默认标题及用户／AI 正文；工具过程显式用 `--kinds user,assistant,tool_call,tool_result`，思考内容按需要加 `thinking`。也可用 `am sessions list --json` 按客户端、项目和日期筛选，具体选项见命令帮助。
3. 使用返回的会话 ID、version 与命中消息 ID，执行 `am sessions messages <sessionId> --version <version> --mode brief --message-id <messageId> --json`。阅读命中附近的连续对话，不能仅根据一条搜索摘要恢复决策。
4. 需要行动细节时切换 `--mode full` 或 `--mode trace`，保留同一 version；通过 `am sessions turns --help`、`timeline --help`、`matches --help` 读取轮次和轨迹。按分页读完相关范围。
5. 需要会话规模及费用时读取 `am sessions profile <sessionId> --version <version> --json` 与 `am sessions cost --help`；导出用 `am sessions export --help`。

示例场景：“继续上次 Claude Code 的缓存排查”。先搜缓存对象名，筛选实际客户端，再读取用户目标、尝试、工具结果与最终结论，确认尚未解决的部分。代码执行成功必须有结果证据；历史里的计划不表示已完成。

简易模式默认当前分支，完整／轨迹默认全部；`--branch current|all|<branchId>` 控制阅读范围。明确子 Agent 默认不列在普通列表，`--include-subagents` 可展示；搜索与直接 ID 读取仍可定位。跨客户端的会话不能凭相似标题判定为同一次任务。

保留原文语言、时间、来源与数据版本。留存文本 Token 是估算，原生请求用量与账单覆盖另行核对；没有记录不表示从未发生。来源不可用时说明缺口，不执行历史命令、不修改历史文件。
