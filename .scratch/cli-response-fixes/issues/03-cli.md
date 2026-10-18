# CLI契约与展示
Status: resolved
Type: task
Blocked by: none

负责F09/F13：CLI默认summary与--full、可读格式、新增详情和价格命令、回放必需参数、写操作小响应、翻译与CLI测试。

## Answer

- 默认人读摘要与 JSON 轻量响应，显式 `--full` 保留完整字段；导出继续读取完整正文。
- 画像分区、长正文续读、价格分页和回放证据必需参数明确可用。
- Skill 与使用文档说明摘要发现、固定版本回读和导出；已知诊断按目录翻译，未知原文按需保留。
- CLI workspace 37 项测试通过，中英文包外实际输出、错误 JSON 与管理授权验证通过。
