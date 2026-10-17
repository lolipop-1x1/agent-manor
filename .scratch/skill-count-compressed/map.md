# 任务地图

1. [读取与计数修复](issues/01-parsing.md)
2. [历史回补及性能验收](issues/02-validation.md)

已确认：Codex selected_skill_instructions 与 CLI 隐藏 slash 展开有原生格式依据。其他未核验的别名不按名称猜测。

## 已作决策

- [读取与计数修复](issues/01-parsing.md) 已完成。压缩来源变化时完整重解析；相同原生会话的副本只发布一次。
- 原生结果伴随的正文已有显式调用证据时不另计读取。不同原生会话没有复制关系时不按相同正文或 UUID 合并。
- [验证记录](validation.md) 区分解压、配对查询、一次性历史回补及后续刷新成本。
- [历史回补及性能验收](issues/02-validation.md) 已完成；最终原始证据、正式索引、真实页面及重复刷新一致，管理数据与其他客户端保留。
