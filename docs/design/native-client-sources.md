# 七个原生客户端的来源与证据

核对日期：2026-10-14。新增来源使用各自的原生读取与写入规则，经过隔离合成验收；没有安装、登录或运行原生客户端。客户端实际权限、动态设置和重新加载效果仍待独立验证。

| 稳定身份 | 固定版本 | 默认历史入口 | 目录覆盖 |
| --- | --- | --- | --- |
| `gemini` / Gemini CLI | v0.64.0 / `4a0749aceac5643e6f85a36d7420314d85e13b52` | `.gemini/tmp/**/chats/*.jsonl`；Seatbelt 使用 `.cache/.gemini/tmp` | `AGENT_MANOR_GEMINI_DIR`；原生 `GEMINI_CLI_HOME` 是有效用户 home，仍追加 `.gemini` |
| `qwen` / Qwen Code | v0.25.1 / `c1a8218f38203e272e6e965778ed6a2795cfeed7` | `.qwen/projects/**/chats/*.jsonl` | `AGENT_MANOR_QWEN_DIR`；原生 `QWEN_RUNTIME_DIR` 优先于 `QWEN_HOME` |
| `kimi` / Kimi Code CLI | 2.1.1 / `f67e6398fb3210ad8ace970e2dfd5bcc984ed61f` | `.kimi-code/sessions/**/agents/**/wire.jsonl` | `AGENT_MANOR_KIMI_DIR`；原生 `KIMI_CODE_HOME` |
| `omp` / Oh My Pi | v18.10.4 / `687892d1046ecaf18829b45f5b86928a308258f4` | `.omp/agent/sessions/**/*.jsonl` | `AGENT_MANOR_OMP_DIR`；原生 `PI_CODING_AGENT_DIR`、profile 与 XDG 规则 |
| `grok` / Grok Build | `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` | `.grok/sessions/**/updates.jsonl` | `AGENT_MANOR_GROK_DIR`；原生 `GROK_HOME` |
| `reasonix` / Reasonix | studio-v2.39.0 共用引擎 / `f289e3903f41d3a2bb4373fc182c837738b945d9` | state 下 `sessions`、`projects` 和 `archive` | `AGENT_MANOR_REASONIX_DIR`；原生 `REASONIX_STATE_HOME`、`config.toml` storage 和 `REASONIX_HOME` |
| `codewhale` / Codewhale | v0.10.1 / `fead51eeea0fb6038ea3e30923751b1a1c765b25` | `.codewhale/sessions/*.json` | `AGENT_MANOR_CODEWHALE_DIR`；原生 `CODEWHALE_HOME` 与当前格式的 `.deepseek` 回退 |

显式 roots 的优先级最高；空 roots 停止读取对应客户端。发现不跟随符号链接。主转录、旁路元信息、分支及累计报告共同形成内容指纹；未声明完整快速检查依赖的来源继续重读内容。派生对话、数据库搜索投影及迁移副本不作为第二份活动。

Gemini 顺序还原 `$set`、`$patch` 和 `$rewindTo`，通过 `.project_root` 与 `projects.json` 归属项目。Qwen 使用 UUID／parentUUID 和显式 sidechain，不从路径编码反推 cwd。Kimi 解释 v2 wire 的 turn、step、LLM、undo、compaction 和 Agent 切换。Oh My Pi 解释 v3 事件树、当前叶、消息用量与独立 `model_usage`。Grok 使用持久更新日志；Reasonix 有事件旁路时按 revision 还原；Codewhale 以 canonical journal、父链和 `leaf_id` 确定当前分支，兼容 messages 投影不重复导入。

工具状态、读取正文、写入快照与补丁均按各自生产 schema 解释。失败、取消、缺少结果、截断和无位置片段分别保留。Oh My Pi 写工具可能在格式化之后只留存字节数和短 tag，不能把请求正文当作最终写入全文。原始证据通过内容哈希回读；JSON 容器及 Grok 等多文件快照中的虚拟记录序号不冒充物理 JSONL 行号。侧文件报告通过会话快照重读并校验原始内容哈希。Codewhale 晚到 ledger 的部分轮次报告独立保留，不并入会话总量或请求。

## 用量与费用

逐响应用量按原生身份去重；输入总量包含已确认的缓存桶。推理输出的包含关系按原生 provider 解释，未知桶保留缺失。Gemini／Qwen 转录不能还原网络重试或全部 HTTP 请求，记录数量不表示完整 API 请求分母。

轮次／会话累计值保存在 `usageReports`，在会话画像的“原生累计报告”中查看，不进入逐请求总量、曲线、速度或估算费用。原生费用保留 `reportedCostUsd` 身份，不能当作本产品账单。只有原生请求边界明确时才提供对应耗时；缺时间保持未知。

## 资源与可恢复管理

资源盘点按用户、项目、兼容、插件、系统和托管来源计算选择与原生状态。不同项目的选择保存在作用范围中；被覆盖入口保留诊断。MCP 公开快照只包含名称、transport、状态和定位，不包含命令、环境变量、headers 或凭证。

原生名字列表、布尔开关与 Reasonix activation 决定均通过具体控制位置编辑。Gemini MCP 按全局规范化服务器名字控制；Qwen MCP 使用排除名单；Oh My Pi 保留 YAML `disabledExtensions` 和 MCP 自身规则；Grok 保留 TOML 名字列表及服务开关；Reasonix 项目决定保留工作区及声明身份。预览列明已知受影响入口，完成状态仍是待重新加载。

Kimi 与 Codewhale 普通 Skill 没有已核验逐项原生停用开关，使用回收和恢复。插件、系统、托管本体受保护。兼容外部来源优先使用当前客户端自己的控制文件；不能直接改动其他客户端资源。复杂或未核验配置写法保持只读。恢复仅撤销目标规则，保留其他名称及后续编辑；目标已变化时报冲突。

## 固定生产源码

- [Gemini recorder 类型](https://github.com/google-gemini/gemini-cli/blob/4a0749aceac5643e6f85a36d7420314d85e13b52/packages/core/src/services/chatRecordingTypes.ts)与 [MCP enablement](https://github.com/google-gemini/gemini-cli/blob/4a0749aceac5643e6f85a36d7420314d85e13b52/packages/cli/src/config/mcp/mcpServerEnablement.ts)。
- [Qwen recorder](https://github.com/QwenLM/qwen-code/blob/c1a8218f38203e272e6e965778ed6a2795cfeed7/packages/core/src/services/chatRecordingService.ts)与 [Skill 设置](https://github.com/QwenLM/qwen-code/blob/c1a8218f38203e272e6e965778ed6a2795cfeed7/packages/cli/src/config/skill-settings.ts)。
- [Kimi wire](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/human/persist/v2/wire.ts)与 [Skill roots](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/features/skill/catalog/skillRoots.ts)。
- [Oh My Pi entry](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/session/session-entries.ts)与 [MCP writer](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/mcp/config-writer.ts)。
- [Grok persistence](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/persistence.rs)与 [Skill 控制](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/skills.rs)。
- [Reasonix sessionstore](https://github.com/esengine/DeepSeek-Reasonix/blob/f289e3903f41d3a2bb4373fc182c837738b945d9/internal/state/sessionstore/save.go)与 [activation](https://github.com/esengine/DeepSeek-Reasonix/blob/f289e3903f41d3a2bb4373fc182c837738b945d9/internal/contract/config/capability_activation.go)。
- [Codewhale session manager](https://github.com/codewhale-hq/Codewhale/blob/fead51eeea0fb6038ea3e30923751b1a1c765b25/crates/tui/src/session_manager.rs)与 [MCP](https://github.com/codewhale-hq/Codewhale/blob/fead51eeea0fb6038ea3e30923751b1a1c765b25/crates/tui/src/mcp.rs)。
