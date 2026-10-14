# 原生来源支持矩阵

核对日期：2026-10-14。本文记录固定上游版本的生产源码事实及本产品采用的边界；原生适配已实施，使用合成测试和隔离浏览器核验；原生客户端运行仍未验证。

## 固定版本

| 客户端 | 基线 | 提交 |
| --- | --- | --- |
| Gemini CLI | v0.64.0 | `4a0749aceac5643e6f85a36d7420314d85e13b52` |
| Qwen Code | v0.25.1 | `c1a8218f38203e272e6e965778ed6a2795cfeed7` |
| Kimi Code CLI | 2.1.1 | `f67e6398fb3210ad8ace970e2dfd5bcc984ed61f` |
| Oh My Pi | v18.10.4 | `687892d1046ecaf18829b45f5b86928a308258f4` |
| Grok Build | 固定 main 提交 | `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` |
| Reasonix | studio-v2.39.0 的共用引擎 | `f289e3903f41d3a2bb4373fc182c837738b945d9` |
| Codewhale | v0.10.1 | `fead51eeea0fb6038ea3e30923751b1a1c765b25` |

Qwen 的 SDK 发布不作为 CLI 基线。Reasonix 的 TUI、HTTP/SSE 与桌面客户端共用控制器，Studio 标签不是另一套独立 CLI 版本号。主干中新增加的语义不当作正式版已发布能力。

## 历史与证据

| 客户端 | 原生来源 | 解析与刷新要求 |
| --- | --- | --- |
| Gemini CLI | runtime 下 `tmp/<shortId>/chats` 中的 JSONL；默认用户目录 `.gemini`，Seatbelt runtime 可在缓存目录 | 顺序解释完整消息、`$set`、`$patch` 和 `$rewindTo`；同消息身份更新不重复计数。`projects.json` 与 `.project_root` 提供路径映射并参与检查依赖 |
| Qwen Code | runtime 下 `projects/<项目编码>/chats/<会话>.jsonl`，含归档子目录 | 使用记录自身 cwd 与 UUID/parentUuid；保留工具结果、分叉、sidechain 与明确压缩事件；不从有碰撞可能的目录编码反推 cwd |
| Kimi Code CLI | 默认 `.kimi-code` 下按工作区、会话及 Agent 分层的 `state.json`、`session_index.jsonl`、`wire.jsonl` | 解释 v2 wire 1.5 的消息、loop、LLM、turn、undo 和 compaction；元信息与消息分别参与来源依赖，保留父 Agent 及 fork 身份 |
| Oh My Pi | 默认 `.omp/agent/sessions` 下的 v3 JSONL 事件树，另有 `history.db` 辅助索引 | 保留父链、当前分支、压缩、子 Agent 和独立 `model_usage`；assistant usage 与独立用量不能重复累加；追加和重写均需处理 |
| Grok Build | 默认 `.grok` 会话目录内的 `summary.json`、`updates.jsonl`、`chat_history.jsonl`、`usage.json` 等 | 以持久更新日志还原通知及工具状态；连续 rewind 按已截断的当前 prompt 身份列表解释，旧分支保留。派生对话不作第二份活动，元信息、用量、压缩材料与 `.cwd` 映射参与依赖 |
| Reasonix | state/workspace 下的 JSONL 检查点、旁路事件日志、`.meta` 与子 Agent 记录 | 有事件日志时按其 revision 和消息变更还原；明确 superseded 身份与完整父转录共同前缀形成复制证明，排除重复活动，普通父关系不猜复制。检查点不是唯一真值，SQLite 历史搜索投影不重复导入 |
| Codewhale | 默认 `.codewhale/sessions/<会话>.json` | canonical journal 的父链和 `leaf_id` 确定当前分支；`messages` 是兼容投影，不重复导入；保存元信息、归档与父会话关系 |

明确目录覆盖沿用本产品接口，并核对客户端自身 home/runtime 环境覆盖。客户端内部自动迁移或回退属于已发布当前格式的加载语义，不表示额外承诺旧代际历史兼容。

## 用量边界

- Gemini 持久化 input/output/cached/thoughts/tool/total；SDK prompt 包含缓存。原生 recorder 对缺少字段使用零值，不能仅凭历史中的零区分源端真实零与缺失兜底。消息身份更新只保留同一用量记录。
- Qwen 的不同 provider adapter 对相同 usage 字段采用不同输出与推理包含关系；来源能确认时按对应映射解释，不能一律把推理加到输出。Anthropic cache creation 的部分来源信息没有完整序列化到转录，不补造缓存写费用。
- Gemini、Qwen 保存的是转录接受的响应流用量，不能还原每次网络重试或实际 HTTP 请求分母。已有记录可以统计，完整请求覆盖保持未知。
- Kimi 区分普通输入、缓存读、缓存创建和输出，输入总量按其生产类型定义归一化。模型时长使用原生首字等待和输出阶段指标；工具结束后的 step.end 时间不作为模型响应结束。
- Oh My Pi 包含消息用量、独立用量和 orchestration/cost，必须核对身份与 purpose，避免重复及错误混入工具专用统计。
- Grok、Reasonix、Codewhale 的会话或轮次汇总、计价快照与逐请求用量分别处理。不能把累计值分摊为虚构请求，不把上游费用字段描述为本产品实际账单。
- 不足以确认模型请求起止时间或输出阶段时，速度与对应耗时指标保留未知。

## 资源与管理

| 客户端 | Skill 发现及控制 | MCP 发现及控制 |
| --- | --- | --- |
| Gemini CLI | builtin、extension、user、workspace；同级 `.agents` 可覆盖原生目录。使用 `skills.disabled` 等原生控制，保留管理总开关与工作区信任 | 多层 settings map；持久 server 开关在用户 enablement 文件中，按全局名称作用；allow/exclude、管理设置与 session 开关分别记录 |
| Qwen Code | project > user > extension > bundled；使用 disabled、enabled、defaultDisabled、disabledLevels，保留硬禁用和更高层级约束 | 多层注册与项目审批；普通启停使用 `mcp.excluded`，插件所属服务另有偏好控制；不写未被 schema/加载端支持的 disabled 字段 |
| Kimi Code CLI | builtin、plugin、extra、user、workspace 逐层覆盖；普通 Skill 无逐项原生停用，使用回收与恢复；插件保持既有保护 | 用户 `mcp.json`、项目 `.mcp.json`、cwd 原生 MCP 文件按层覆盖；服务支持 enabled 与工具列表，插件所属入口与普通注册区分 |
| Oh My Pi | native 与多种兼容 provider 按优先级选择；用户 foreign 来源受 opt-in。逐项 disabledExtensions、provider 开关与前台隐藏语义分别保留；实际配置损坏及未知共享范围禁止停用 | native enabled、disabledServers、enabledServers 与多来源控制；强制启用来源采用用户 disabledServers 停用，恢复保留 allowlist。优先写本客户端设置，不直接改其他客户端注册 |
| Grok Build | 用户与可信项目来源；名字级 `skills.disabled` 写入用户配置，预览保留实际影响范围 | 可信项目 TOML 按仓库根到 cwd 完整覆盖用户同名声明；停用写用户 disabled_mcp_servers 名字名单，注册回收独立定位声明文件。配置变更与显式 reload 的生效分别记录 |
| Reasonix | 用户/项目 durable enable、disable、clear override；项目优先，清除恢复继承状态 | 项目声明强制项目 scope，启用决定绑定声明 digest；定义改变后需重新确认，controller 生效与下一 session 生效分开 |
| Codewhale | 原生与兼容项目/global roots；部分来源仅审计或只读。普通 Skill 无逐项持久停用，使用回收与恢复 | global、可信 project 与 plugin；服务支持 enabled/disabled、工具 allow/deny，项目同名覆盖 global；插件服务按所有者处理 |

管理原生按名称或全局范围生效时，在预览中列明已发现的受影响入口及范围，不描述成单个入口的独立开关。原生缺少回收站不妨碍本产品按既有恢复材料流程管理普通入口；系统、插件、托管和未核验写入方式继续保留保护。

## 生产源码定位

- [Gemini 写入与 patch/rewind 类型](https://github.com/google-gemini/gemini-cli/blob/4a0749aceac5643e6f85a36d7420314d85e13b52/packages/core/src/services/chatRecordingTypes.ts)、[项目映射](https://github.com/google-gemini/gemini-cli/blob/4a0749aceac5643e6f85a36d7420314d85e13b52/packages/core/src/config/projectRegistry.ts)、[MCP enablement](https://github.com/google-gemini/gemini-cli/blob/4a0749aceac5643e6f85a36d7420314d85e13b52/packages/cli/src/config/mcp/mcpServerEnablement.ts)。
- [Qwen 转录写入](https://github.com/QwenLM/qwen-code/blob/c1a8218f38203e272e6e965778ed6a2795cfeed7/packages/core/src/services/chatRecordingService.ts)、[Skill 规则](https://github.com/QwenLM/qwen-code/blob/c1a8218f38203e272e6e965778ed6a2795cfeed7/packages/cli/src/config/skill-settings.ts)、[MCP 类型](https://github.com/QwenLM/qwen-code/blob/c1a8218f38203e272e6e965778ed6a2795cfeed7/packages/core/src/config/mcp-server-config.ts)。
- [Kimi wire 读取](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/human/persist/v2/wire.ts)、[Skill roots](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/features/skill/catalog/skillRoots.ts)、[MCP schema](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/mcpCore/config-schema.ts)。
- [Oh My Pi entry 类型](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/session/session-entries.ts)、[能力发现](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/capability/index.ts)、[MCP writer](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/mcp/config-writer.ts)。
- [Grok 会话持久化](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/persistence.rs)、[Skill 控制](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/skills.rs)、[MCP 控制](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/mcp.rs)。
- [Reasonix 会话保存](https://github.com/esengine/DeepSeek-Reasonix/blob/f289e3903f41d3a2bb4373fc182c837738b945d9/internal/state/sessionstore/save.go)、[Skill activation](https://github.com/esengine/DeepSeek-Reasonix/blob/f289e3903f41d3a2bb4373fc182c837738b945d9/internal/contract/config/activation_skill.go)、[MCP activation](https://github.com/esengine/DeepSeek-Reasonix/blob/f289e3903f41d3a2bb4373fc182c837738b945d9/internal/contract/config/activation_mcp.go)。
- [Codewhale 会话存储](https://github.com/codewhale-hq/Codewhale/blob/fead51eeea0fb6038ea3e30923751b1a1c765b25/crates/tui/src/session_manager.rs)、[Skill 操作](https://github.com/codewhale-hq/Codewhale/blob/fead51eeea0fb6038ea3e30923751b1a1c765b25/crates/tui/src/skills/mutation.rs)、[MCP](https://github.com/codewhale-hq/Codewhale/blob/fead51eeea0fb6038ea3e30923751b1a1c765b25/crates/tui/src/mcp.rs)。

## 验证层次

已完成固定版本源码及关键加载/写入链路的静态核对。适配、匿名合成来源、1197 项完整回归以及统一 API／CLI／代码地图／统计／资源和中英文浏览器 79 项检查均已通过；两轴审查发现及直接残留全部修复并独立复核。原生安装、运行及配置生效保持独立未验证项。详见 [验收记录](../../docs/validation/native-clients.md)。
