# CodeFlicker 项目历史与读写证据

Type: task
Status: ready-for-agent
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
