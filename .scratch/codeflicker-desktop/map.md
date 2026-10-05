# CodeFlicker 桌面版

## 已作决策

- 用户指定“CodeFlicker CLI”和“CodeFlicker 桌面版”两个展示入口；两者身份与筛选独立，旧 CLI ID 保持兼容。
- 新版 MyFlicker 桌面端只读接入本机已有历史，不使用网络获取或发起新会话。
- [桌面接入与验收已完成](issues/01-desktop-history.md)：复用客户端和格式注册，独立主缓存及元数据指纹；200 项回归、真实 Chrome 端到端和本机只读核对通过。
- [旧桌面／IDE SQLite 兼容完成](issues/02-ide-sqlite.md)：沿用桌面客户端身份，原生会话选择器贯通地图、会话缓存与证据；207 项回归、双格式 Chrome 端到端和原始调用独立核对通过。无逐请求用量时不从累计缓存补造趋势。

## 任务

- [01 桌面来源、适配与验收](issues/01-desktop-history.md)
- [02 旧桌面／IDE SQLite 历史](issues/02-ide-sqlite.md)

## 公开边界

公开材料使用人工样本；真实历史、路径、原始身份、业务名称与截图仅保存在本机忽略目录。
