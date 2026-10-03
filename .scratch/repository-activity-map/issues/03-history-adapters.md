# 历史发现、格式解析与证据提取

Type: task
Status: resolved
Blocked by: 02

## Scope

责任文件：src/history/、tests/history*.test.ts、tests/fixtures/history/、docs/design/history-support.md。
Codex／Claude JSONL、来源发现、调用结果配对、成功内容提取、去重与分叉关系、会话归属、待配对调用与完整记录边界。产物／游标可 JSON 序列化。原始历史只读，不执行命令。读取 /private/tmp/agent-manor-notes/history-formats.md。

## Acceptance

成功／失败／缺失／截断、ID 重用、重复消息、分叉、真正重复调用有样本。直接读写和 cat/sed/head/tail/nl/rg 列支持矩阵；复杂命令保持未知。实际输出只取完整返回行；搜索单列；编辑只取变化内容，不能把补丁上下文全算编辑行。

## Comments

- 2026-10-03：采用已确认首版规格，自行实现。

## Answer

- 历史发现、格式解析与证据提取提交：`45352d3d4df58e631392ea8c41f58a7190abf4e1`；独立分支以 `--no-ff` 合并，合并提交：`4d418e6e8e35bb538d60c31691881e7455825fbe`。
- `npm run check:server`、`node --import tsx --test tests/history*.test.ts`（27/27）和合并差异 `git diff --check` 均通过。
- 测试覆盖 Codex／Claude 新旧格式、直接读写与 Shell 支持矩阵、成功／失败／缺失／截断、ID 重用、分叉与重复调用、只读发现、增量完整边界和逐事件归属。供索引 Worker 使用的接口已核对；真实本机端到端验收留到集成验收阶段。
- 2026-10-04：合并真实历史读取兼容提交 `0efc54234c1d2ad5681311ccef33d2bc91b73ddb`，合并提交 `51662d3eb619c22f54bc665ddaf059a55e6cb221`；已有解析规则版本内容自动合并，未产生重复差异。
- 兼容验证：`npm run check:server`、历史测试 32/32 与 `git diff --check` 均通过。Claude SDK 尾 LF 虚拟 EOF 空行只有在完整编号、范围与内容一致时排除，覆盖仍按物理行；矛盾与缺失证据保留未知，旧规则缓存重新解析。此次完成类型和样本测试，真实本机端到端结果仍由集成验收确认。
