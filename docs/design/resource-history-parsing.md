# Skill 与 MCP 历史解析边界

资源使用基于已保存的历史证据。调用身份、执行结果、Skill 正文读取和当前本地安装是不同事实；名称提及、写入 Skill 文件、列举文件、当前配置存在都不能证明历史使用。Skill 显示使用次数与使用会话，详情拆分显式调用和成功读取；MCP 保留工具调用统计。

## 共享规则

- 显式 Skill 工具读取原生 `skill`、`name` 或已核验的 `skill_directory`；缺名保留缺失状态，不解析任意 `command` 参数猜名称。
- MCP 只从有约定的可见工具命名或原生服务／工具字段取身份。`mcp__server__tool` 与 `mcp__server.tool` 保留可见名称；编码、归一化和哈希后的名称不能宣称是完整原始身份。
- 成功读取复用客户端的实际返回证据。Read、原生读取别名及可解析 Shell 读取可产生 `skill_read`；失败、未配对、歧义结果、空返回、写入和搜索不产生读取证据。
- 相对路径只使用工具 workdir／cwd 或来源 cwd；没有这些信息时保留相对路径，不使用服务进程 cwd 猜测。记录确认后的读取路径，不能把多个文件的参数路径随意当作所读 Skill。
- 无范围元信息的普通 Read 正文可确认使用，但不因此确认代码行覆盖；原生路径或范围互相矛盾时不退回文本猜测。
- 资源通常挂在调用消息上，结果只确认状态，不再次计数。Pi 的原生 Skill 展开包作为用户消息中的读取证据保留；Codex 与 CodeFlicker CLI 的原生注入保留上下文分类并参与资源查询，不补造工具调用。复制历史仍排除，同一会话的多份证据只贡献一个使用会话。
- 一次真实调用可保留多份已确认的 Skill 读取，兼容字段 `resource` 保留第一份，`resources` 保存多资源证据。查询按消息和资源展开，重复资源去重，新增资源不增加消息、轮次或工具调用数；证据仍定位原始消息与来源行。
- 可解析的多文件或组合读取，可用返回正文中的有效 Skill frontmatter 与唯一候选路径确认使用；不会据此恢复各文件的代码行范围。短路兜底、任意脚本或输出生成命令、正文内代码示例、同名路径歧义仍保守排除；截断只确认截断前实际保留的正文。
- 不读取当前磁盘上的 Skill frontmatter 改写历史名称。安装变化、移动或删除不应改变已保存证据。

## 客户端核验

豆包工作当前已停用导入、资源盘点和页面入口，相关解析代码仅保留作研究，不计入当前产品支持范围。本机数据不完整及原生卡片的证据边界见 [豆包工作来源调查](doubao-work-sources.md)。

| 客户端 | 已核验入口 | 结果及限制 |
| --- | --- | --- |
| Codex | function call 的名称、参数、调用标识；工具或 Shell 返回；明确标注的原生 Skill 注入 | 原生命令按 `formatted_output`、`aggregated_output` 的已记录字符串优先级读取，明确空的优先字段保留为空；仅有 `stdout` 不补正文，读取仍要求成功。包装调用复用原生命令事件，不解析 JavaScript 猜测执行行为。仅 `skills.selected_skill_instructions` 元数据与完整 name/path/正文包共同确认原生读取，用户链接与任意 XML 示例不计 |
| Claude Code | `tool_use`／`tool_result`，单结果的 `toolUseResult.file` | 省略 `is_error` 时仍可由结构化 Read 确认成功；一条消息含多个结果时不共享单份旁路元信息 |
| CodeFlicker CLI | `tool_use`／`tool-result`，Skill 名及结构化 Read；CLI 原生 slash 展开链 | 原始错误和状态未知保留；slash 输入、隐藏命令与实际正文按原生 parentUuid 链确认，仅正文计一次；显式 Skill 调用的结果伴随展开不再计数。附件、Hook 与正文提及不计 Skill／MCP |
| CodeFlicker 桌面版 | JSONL 的 `use_skill`／目录参数；IDE 的 `useSkill`、`useMcpTool` 字段 | IDE 服务及工具名按原生字段转换；普通 MCP 返回缺少明确终态时仍是 unknown，不因收到文字而判成功 |
| DeepSeek Harness | V3／V4 `tool/call`、`tool/result` 及原生读取元信息 | Bash 非零退出码另在末尾标记中，不能只看 `isError:false`；超时、停止及后台标记不当作成功。MCP 的哈希化公共名称不可逆 |
| Pi | `toolCall`／`toolResult`、Read／Bash；完整 `/skill:` 展开包 | 完整 name／location／References／正文包装可形成读取证据，裸 `/skill:` 不计。手写相同包装无法与原生展开完全区分，嵌套或矛盾包装不识别；codemode 不解析脚本猜逐项 MCP 调用 |
| WorkBuddy | `function_call`／`function_call_result`、`callId`、已记录 Skill 参数 | 保留 `providerData.toolResult` 原生字段；明确错误为失败，未核验的 `completed` 不补成功。Skill 的 `command` 参数 schema 未确认，缺名仍保持缺失 |
| OpenCode | SQLite ToolPart、原生 `skill` 工具及 Read／Bash | `invalid` 表示失败；自定义工具的 completed 不证明协议成功。原生 MCP `sanitize(server)_sanitize(tool)` 未保存可逆身份或协议 isError，不能据下划线猜服务；无法归属的调用仍保留在完整轨迹和工具统计 |
| ZCode | SQLite ToolPart 的 Skill 参数及 `mcp__...__...` 可见名称 | 样本状态与伴随 tool_usage 一致，不重复读取遥测制造第二次调用；缺少伴随行不补造额外数据 |
| CodeBuddy | 当前 JSONL 仅核验 user 消息 | 明确保留资源采集缺口；不能因为没有工具记录就把本地资源标为未使用。agentsview 的 manifest＋逐消息 JSON 是另一种布局，不能视为当前格式已适配 |
| Qoder | `tool_use`／`tool_result`、调用标识及原生结果字段 | 按错误、退出码、中断等原生字段判定；本机样本未出现 Skill／MCP 阳性记录，不承诺所有版本或私有命名格式 |

此表描述已核验的格式和限制，不承诺所有历史版本。配置盘点和历史解析独立；当前配置或服务器工具清单不能补造旧会话的精确身份。

## 参考与更新

- [agentsview](https://github.com/kenn-io/agentsview/tree/1148d7f25e0cd89e3fc1c716e092d76172770a99/internal/parser) 的工具身份、读取路径与 invalid 特判作为对照；没有照搬读取当前文件恢复历史名称或仅凭请求计读取的规则。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/shell/tool-bash) 的 Bash 返回渲染和状态标记。
- [Pi v1.0.4](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/agent-session.ts) 的 Skill 展开格式。
- [OpenCode](https://github.com/anomalyco/opencode/tree/3c96bf84688fa5e56977a1ff95a0b920f1749983/packages/opencode/src) 的 MCP 注册、工具结果持久化及原生工具定义。

会话索引规则升级到 7，代码活动规则升级到 13。原生 Skill 规则另以 Codex 与 CodeFlicker 专用的元数据版本失效旧缓存，下次标准刷新重建；不会删除客户端来源或独立资源管理状态。资源查询使用包含原生 Skill 上下文的 v3 部分索引，配对查询复用调用索引，避免逐会话重复扫描；单资源事件身份保持兼容，附加资源拥有独立事件身份，仍关联原消息。
