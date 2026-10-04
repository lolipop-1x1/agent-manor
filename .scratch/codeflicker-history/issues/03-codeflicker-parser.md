# CodeFlicker 项目历史与读写证据

Type: task
Status: resolved
Blocked by: 02

## Scope

责任文件：CodeFlicker 内置适配器、格式注册、tests/history-codeflicker.test.ts、匿名夹具、docs/design/history-support.md。
参考 /private/tmp/agent-manor-codeflicker-notes/format.md；不得提交私人历史和源码。

## Acceptance

- config/message、tool_use/tool-result 的实际层级、状态、输入输出按本机格式核对。
- 成功 read 与 edit/write 形成可回查的证据，失败／缺失／截断保持对应缺口。
- 主会话和能确认归属的子会话可发现，requests 不独立计数。
- 实际来源身份、仓库归属、增量与重复调用有测试；不只从目录 slug 猜测 cwd。
- 读取、修改分别统计；精确／近似／未知口径不变。
- 真实来源探针输出事件与缺口分布，供 05 独立核对。

## Comments

- 2026-10-05：等待 02 接口与代表样本事实；只读格式调查并行进行。
- 2026-10-05：03 已认领；基于任务 02 稳定接口实现原生 JSONL 解析、匿名证据模板与增量验证。

## Answer

- 完成 [原生适配器](../../../src/history/adapters/codeflicker.ts) 与 [格式注册／来源过滤](../../../src/history/adapters/index.ts)：只处理实际 assistant/tool 执行块，保留原始工具、输入、来源行与哈希；排除 requests/file-history。原始 sessionId/agentId 定义身份，绝对路径可逐文件归属，不反解目录 slug。
- read 的成功 JSON 返回、write/edit 的执行完成模板与标准 structuredPatch 根据本机原生 CLI 执行器核对。read 校验实际范围与 SDK EOF，write/edit 提取变化；失败、未知、截断、缺失结果与父关系未知均保留缺口。bash 按已核对的原生终态包装解析，grep/glob 搜索单列。
- [匿名夹具](../../../tests/fixtures/history/codeflicker-native.jsonl)、[11 项原生测试](../../../tests/history-codeflicker.test.ts) 覆盖状态、计数矛盾、调用 ID 重用、重复 UUID、多结果、增量尾记录、来源移动、绝对路径归属、子来源及格式／客户端独立身份。
- `npm run check:server` 通过；原生与适配边界测试共 16 项通过。一个真实主来源只读探针为 1,708,528 字节／726 记录／113 调用，与原始工具计数一致；18 read、9 write、7 edit 均有片段。探针只输出元数据分布，不提交个人正文。详细支持与接入指南见 [支持矩阵](../../../docs/design/history-support.md)。
- 全量来源性能、Web/CLI/API 与实际安装包端到端验收由 05／主流程继续，未在 03 宣称完成。
