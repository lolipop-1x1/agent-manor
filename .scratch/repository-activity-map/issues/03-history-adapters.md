# 历史发现、格式解析与证据提取

Type: task
Status: claimed
Blocked by: 02

## Scope

责任文件：src/history/、tests/history*.test.ts、tests/fixtures/history/、docs/design/history-support.md。
Codex／Claude JSONL、来源发现、调用结果配对、成功内容提取、去重与分叉关系、会话归属、待配对调用与完整记录边界。产物／游标可 JSON 序列化。原始历史只读，不执行命令。读取 /private/tmp/agent-manor-notes/history-formats.md。

## Acceptance

成功／失败／缺失／截断、ID 重用、重复消息、分叉、真正重复调用有样本。直接读写和 cat/sed/head/tail/nl/rg 列支持矩阵；复杂命令保持未知。实际输出只取完整返回行；搜索单列；编辑只取变化内容，不能把补丁上下文全算编辑行。

## Comments

- 2026-10-03：采用已确认首版规格，自行实现。
