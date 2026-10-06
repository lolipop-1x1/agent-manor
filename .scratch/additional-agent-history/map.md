# 新增历史来源任务地图

- [01 需求确认](issues/01-requirements.md)
- [02 来源与源码核验](issues/02-source-research.md)
- [需求草稿](spec.md)
- [03 共享规范化与注册](issues/03-normalized-pipeline.md)
- [04 DeepSeek Harness 与 Pi](issues/04-dsh-pi.md)
- [05 OpenCode 与 ZCode](issues/05-sqlite-clients.md)
- [06 WorkBuddy、CodeBuddy 与 Qoder](issues/06-jsonl-clients.md)
- [07 查询与分支界面](issues/07-query-ui.md)
- [08 集成核验与评审](issues/08-validation.md)

## 已作决定

- N1：七个客户端贯通全部现有功能及查询入口。
- N2：本机现存历史与可核验版本为首批兼容范围，未知格式明确保留缺口。
- N3：简易看当前分支，完整／轨迹保留全部已记录过程及分支定位。
- N4：默认统计全部实际活动，分叉继承去重；阅读切换不改变默认统计范围。
- N5：展示名为 DeepSeek Harness；其余六个产品身份确认。ZCode 桌面任务索引与消息库合并，不创建 ZCode CLI。
- N6：明确委派子会话默认隐藏，父记录缺失明确标注；筛选、搜索及直接访问保留。
- N7：简易保留真实历史，压缩摘要及注入上下文归入过程，不新增用户轮次。
- 来源只读、证据口径、可重建索引与内置适配器注册沿用现有约定。
- 来源研究已完成：七个客户端的能力矩阵及已知限制见 [02 来源与源码核验](issues/02-source-research.md)。WorkBuddy 正文与 SQLite 元信息分别处理；CodeBuddy 缺失字段和 Qoder 尚未证实的关系不补造。

## 当前前沿

用户已确认开始实现。03 为共享接口前沿；04／05／06／07 依赖 03，可并行；08 依赖全部实现任务。
