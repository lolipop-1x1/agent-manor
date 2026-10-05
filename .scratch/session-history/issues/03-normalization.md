# 会话规范化
Type: task
Status: resolved
Blocked by: 02

实现三个客户端流式解析至 SessionSink，保留消息身份、来源行、轮次、模型、工具、用量和明确父子关系。合成样本测试并私下核对真实字段，记录已知缺口。责任目录 src/sessions/parser* 与 tests/session-parser*。

完成：原生消息、最终回答与推断、用量身份／累计投影、模型、工具及 Skill／MCP 证据、压缩和明确子身份均规范化。明文思考保留，不解密缺失内容。CodeFlicker 无 cwd 时只从可核对 Git 文件活动关联项目。三个客户端各一条真实用量样本复核一致；支持边界与测试见 docs/validation/session-history.md。
