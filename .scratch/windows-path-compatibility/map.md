# Windows 文件路径兼容设计树

Type: grilling
Status: needs-triage

## 当前状态

Windows 兼容工作已暂停，仅维护后续待办。尚未实施路径适配、内容解析或 Windows 原生验收，当前支持平台为 macOS；暂未兼容 Windows。

## 已作决策

- 后续优先处理 Windows 文件路径的发现、识别与关联，内容解析单独排期。
- 文档描述本项目的需求、规则和验收边界。
- 沿用原始证据、可重建索引和公开内容边界；路径识别不能补造读取、使用或项目关联证据。
- W1 已确认：后续同时覆盖 Windows 本机运行，以及在 macOS／Linux 上读取包含 Windows 路径的历史；缺少本地对应目录时，不自动关联同名目录。
- W2 已确认：路径适配覆盖会话来源发现、项目归属、代码地图路径关联，以及 Skill／MCP 本地盘点和历史路径匹配。
- 安装、服务生命周期、ACL 和资源移动／恢复等 Windows 管理写操作另列 TODO，读路径兼容不等于完整 Windows 支持。

## 恢复工作前待确认

- 原始路径保留、路径相等、大小写和链接歧义的处理规则；W3 尚未确认。
- 外来历史路径与本地仓库／资源的关联方式，以及无法对应时的展示规则。
- 客户端 Windows 默认来源目录与覆盖配置的核验范围。
- 索引与身份兼容、Windows 原生验收范围及支持说明升级条件。
- 暂不继续提问；恢复任务时再收口为实施规格。

## 设计树

- 使用场景 → 本机路径与外来历史路径 → 本地关联与缺失状态。
- 功能范围 → 来源发现、项目归属、代码地图与资源盘点 → 路径身份与原文保留。
- 路径规则 → 分隔符、盘符、网络共享路径与目录边界 → 大小写、链接与歧义。
- 验收边界 → 合成路径用例与 Windows 运行验证 → 支持说明与后续任务。

## 后续任务

| 任务 | 状态 | 范围 |
| --- | --- | --- |
| [01 Windows Shell 内容解析](issues/01-shell-content-parsing.md) | needs-triage | 命令、结果与文件读取证据 |
| [02 Windows 文件读路径适配](issues/02-read-path-compatibility.md) | needs-triage | 本机与跨平台历史的路径识别和关联 |
| [03 Windows 资源管理写操作](issues/03-resource-management.md) | needs-triage | 权限、链接、备用、回收和恢复 |
| [04 Windows 运行与平台验收](issues/04-platform-validation.md) | needs-triage | 安装、服务生命周期与原生验证 |

## Comments

- 用户要求暂停兼容开发，完善文档并保留 TODO；本次仅修改文档。
