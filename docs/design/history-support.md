# 历史解析支持与证据边界

规则版本：`PARSER_RULE_VERSION = "8"`，定义在 `src/version.ts`；旧规则游标重建。仓库中的测试样本全部匿名合成；格式结构参考本机只读取证笔记，本文不复制个人来源路径、日志或代码。格式兼容采用结构判断，不宣称整个客户端版本已验证。真实 CodeFlicker 仓库端到端验收见源码仓库的 `docs/validation/codeflicker.md`。

## 来源、身份与续读

新增内置 Agent 时，在源码 `src/clients.ts` 声明稳定 ID、显示名称与缩写，在 `src/history/adapters/index.ts` 声明发现根、环境变量、来源过滤和格式 ID，再按 `src/history/adapters/types.ts` 的 HistoryAdapter 接口实现元数据、配对、续读与证据转换，并增加匿名格式测试。这些源码路径供仓库开发使用，安装包交付对应的已编译模块。来源和格式分别注册，适配器接收实际客户端身份；统计、仓库归属、Web 筛选与 CLI 校验继续消费共用声明和通用事件，不逐客户端添加判断。

必要请求登记复用 `src/history/adapters/common.ts` 的 `registerRequest`，格式适配器仍提供各自身份 key 和原始参数，现有事件 ID 保持兼容。需要跨来源关系时实现可选 `resolveRelationships`，仅检查本轮已经解析的来源并返回关系与证据；通用合并和刷新消费结果，不读取额外私有路径或据格式推断客户端。

`discoverSources()` 默认发现 `~/.codex/sessions`、`~/.codex/archived_sessions`、`~/.claude/projects`、`~/.codeflicker/projects`、`~/.myflicker/sessions`，接受显式目录或 `AGENT_MANOR_CODEX_DIR`／`AGENT_MANOR_CLAUDE_DIR`／`AGENT_MANOR_CODEFLICKER_DIR`。只递归普通目录与 JSONL 普通文件，不跟随发现目录中的符号链接；每个候选至多读取 64 KiB 头部和其中前 32 行。头部含超长指令时可能无法获取元数据，候选仍保留，完整解析或手动关联可继续核对。CodeFlicker 排除 `requests/` 与 `file-history/`，不将模型请求重放、工具声明或文件快照当作工具执行。

来源身份与事件身份分开。Codex 元数据中的线程 ID、初始时间与 cwd，Claude sessionId 与 agentId，构成来源身份依据；来源路径和当前完整文件哈希属于来源版本。没有可确认元数据时使用路径身份并保留未知 session，不声称移动能够识别。相同元数据的文件副本与活跃文件移动到归档目录可保留身份。

`SourceReference.hash` 是单条原始 JSONL 记录哈希；`ParsedSource.hash` 是完整来源文件字节哈希，两者不能互换。证据引用保存一基物理记录行，追加不会使旧记录哈希失效。来源移动后的续读引用指向新路径。

`parseSource(path, client, previous?, format?)` 保存完整换行结尾的字节边界、旧完整前缀哈希、物理行号和待配对调用。旧前缀内容一致且规则版本与格式相同才解析追加记录；不完整尾行和半个 UTF-8 字符等待下一轮。截断、替换、前缀改变或规则升级均重建。完整文件需要读取并哈希；增量节省 JSON 解析与证据提取，不宣称无需读取旧字节。`cursor.parsedRecords` 记录本轮实际解析记录数，游标和解析产物均可 JSON 序列化。

请求 ID 可重用：有 Claude uuid 或 Codex response item id 时保存请求出现身份；没有时保存来源内出现位置。两个同时待配对的同 ID 请求且缺少更强关联字段时保留歧义。相同内容的新调用增加活动次数，只有相同消息身份或同具体事件身份的重复记录才合并。process_id 不作为全局事件身份。

fork 保存父 session、原始 ordinal 与 endByteOffset。ordinal 的准确客户端语义未验证，因此不将其当物理行号；只有父来源存在且 endByteOffset 落在完整记录边界才复用此前父事件。复制历史还必须与这部分父事件的记录哈希集合和消息／具体事件身份一致，才能合并事件并保留双方证据引用。缺少消息身份的旧式调用即使文本完全相同也保留，并列歧义缺口。仅父子关系、摘要或相同文本均不作为调用去重证明。父来源缺失或边界异常产生缺口。子 agent 的 sessionId/agentId 与显式父来源关系保留，但父 Agent 总结不重造子调用。

## 格式矩阵

| 格式 | 当前提取 | 取证与限制 |
| --- | --- | --- |
| Codex `event_msg.item_completed.CommandExecution` | status/exit_code、file URI cwd、命令、formatted_output | 新版结构已实样核对，合成测试验证；不采用 stdout/aggregated_output 补齐返回内容；未知终态不产生片段 |
| Codex `FileChange` add/update | 新建内容、unified_diff 的新增／删除／上下文 | 结构已实样核对；失败不产生修改片段 |
| Codex FileChange delete/move | 保留活动、原始 changes 和 move_path | 仅合成验证；删除无当前新增行，移动关系不自动证明内容对应 |
| Codex `exec` custom wrapper | 与区间内具体事件保存外层证据，wrapper 不重复生成读取／编辑 | 不执行或猜测 JavaScript；没有具体事件时作为 unknown other 和 unsupported_tool 缺口 |
| Codex direct shell_command | JSON arguments 与文本 Exit code／Output 头 | 旧版结构实样核对；direct exec_command 按相同 shape 合成验证；缺终态保留 unknown |
| Codex direct Read/Edit/Write | 结构化结果按直接工具 shape 提取 | 尚无对应本机 direct 实样；不能把普通返回文本当结构化读取范围 |
| Codex apply_patch | 成功结果与 Add/Update/Delete File 内容 | 可提取变化，非标准 hunk 缺少可靠历史行号时保持未知；失败不产生片段 |
| Codex `token_usage_record`／`world_state`／`inter_agent_communication_metadata` | 已知非工具元数据跳过 | 真实关联来源中核对为用量、状态和通信元数据；不含读写证据，不制造格式缺口；未知顶层类型继续保留缺口并显示类型名 |
| Claude Read | 实际 file.content/startLine/numLines/totalLines 与编号文本校验 | 结构实样核对；is_error 可省略但需要结构化成功结果；字段矛盾不产生覆盖片段；可确认的 SDK 虚拟 EOF 空行排除覆盖 |
| Claude Edit | structuredPatch 的变化行与上下文 | 结构实样核对，纯删除保留活动；无结构化位置时只保留变化内容，不虚构历史行号 |
| Claude Write create/overwrite | create 的内容，overwrite 的 originalFile/content 差异 | create 结构实样核对；overwrite 合成验证；未确认新建或旧内容则范围未知 |
| Claude Bash | tool_result.is_error 与实际 content | 实样结构；持久化输出和截断不补读 stdout/旁路文件；后台接收状态为 unknown，后续后台终态通知尚未适配 |
| Claude Agent／非工具快照 | 真实子来源独立解析，非工具记录跳过 | 不将摘要、totalToolUseCount、file-history-snapshot 等计为读取成功 |
| CodeFlicker 原生 `message.content[]` | assistant 的 `tool_use` 与 tool 的 `tool-result` 按 ID 配对 | 保留原始小写工具名与参数、uuid 身份、物理行与哈希；新的 uuid 重用 call ID 是新活动；并发同 ID 无强关联字段时保持歧义；system/user/hook 内容不制造工具活动 |
| CodeFlicker read | `llmContent` JSON 的 type/filePath/content/offset/limit/actualLinesRead/totalLines | 原生 CLI 执行器成功模板已核对；路径、范围与 split 计数须一致；末尾 SDK EOF 空项不计物理行，范围内真正的末尾空行保留；恰好 2003 字符且末尾 `...` 的 SDK 隐藏截断形态列缺口，该行不进入精确或近似覆盖，完整前后行保留实际位置；同形态天然源码也保守处理；不凭缺少 isError 判成功 |
| CodeFlicker write/edit | 固定执行完成模板、returnDisplay 的 structuredPatch | 模板在文件写入完成后产生；标准 hunk 校验行数，仅新增／删除行算修改，context 只定位；write 无 patch 时依据实际写入语义补末尾 LF，不推断原文件一定为新建；edit 无位置时仅保留变化片段并列范围缺口 |
| CodeFlicker bash | Command/Directory/Stdout/Stderr/Error/Exit Code 的原生返回包装 | 最终退出码与 Error 校验状态，读取仅消费白名单命令的实际 Stdout；绝对 Directory 只归属本次事件，不改会话 cwd，也不推断命令内 cd；截断标记、持久化旁路、后台状态或未知包装不补齐；复杂命令仍产生 unsupported_tool |
| CodeFlicker grep/glob/ls/todoWrite | 搜索单列、列举与任务列表 other | grep/glob 完整 JSON 返回与 todo_write 结构可证实终态；搜索不产生主要读取覆盖；其他缺少已确认成功模板的结果保留 unknown |

CodeFlicker 的来源身份由原始 sessionId 与显式 agentId 构成，并始终带实际客户端身份；目录 slug 不用于还原 cwd。缺少 cwd 的来源可用实际绝对文件路径逐活动归属仓库。`agent-*.jsonl` 可独立发现和解析；显式 parentSessionId／parent_thread_id／forked_from_id 统一转换为来源关系。原生成功 Agent 结果块的 agentId 也可与同一实际客户端、同项目目录、唯一子 sessionId=`agent-<agentId>` 和同名 JSONL 交叉确认父关系；文件副本具有相同来源身份时不算多个父身份。子事件保留父结果原始引用和父 session，来源列表／结果来源同步表示关系，原始解析缓存不改写。失败、未知、跨目录、跨客户端、身份不符或多个不同父身份不建立推导关系并保留缺口；文件名、parentUuid 消息链、摘要、同一 call ID 或相同内容不能单独证明关系或重放。CLI 格式不读取旧 IDE SQLite；桌面版的 SQLite 支持见下文。未核对归档格式和补全／编辑预测未纳入支持。

缺少可靠 cwd 的相对 read/edit/write 请求，可用原生 read 的 `filePath` 或 edit/write 的 `returnDisplay.absoluteFilePath` 确认本次目标：返回须为绝对路径，且以规范化后的完整相对请求路径为后缀；`.`、仍以 `..` 越出父目录的路径及后缀冲突不接受。已有可靠 cwd 时仍要求解析后路径完全相同。返回路径只属于该次活动，不用于猜测会话或后续请求的 cwd；成功终态、实际范围和补丁校验继续独立执行。解析规则 8 重建旧缓存以恢复这类活动，事件身份保持不变。

本轮原生只读探针覆盖一个 1,708,528 字节、726 条物理记录的真实主来源，与独立原始工具计数核对得到 113 次调用：read 18、write 9、edit 7、bash 49、grep 14、glob 2、todoWrite 3、skill 6、AskUserQuestion 4、Agent 1。18 次原生 read、9 次 write、7 次 edit 均获得范围／差异片段；其余工具的未知状态与不支持命令按缺口保留。此探针不是全量历史或真实仓库端到端验收。本机默认根可能包含数千个来源且原生记录没有 cwd，首次刷新需要完整读取候选；可将 `AGENT_MANOR_CODEFLICKER_DIR` 设为单个项目目录，明确限定来源规模后刷新。本文不宣称已验证全量刷新性能。

具体事件的 `formatted_output` 是工具返回口径。外层 `exec` 选择性 `text()` 或再次截断可能限制实际向模型呈现的内容；外层原始证据可回读，但当前主覆盖不声称代表逐字模型可见内容。长期进程轮询、chunk 重叠、任意脚本或动态包装缺少明确事件关系时不猜测。

## Shell 矩阵

| 字面命令形式 | 行范围与内容 |
| --- | --- |
| `cat file` | 成功实际返回，历史起始行 1 |
| `cat file1 file2` | 保留各文件活动；无输出边界，不生成读取片段 |
| `sed -n 'a,bp' file`／`sed -n 'ap' file` | 只支持正整数选择器，返回行数不得超过所选范围 |
| 多行脚本内仅有上述固定范围 `sed`，可外包一层 `sh/bash/zsh -c/-lc` | 成功、无截断且实际总行数等于所有范围长度之和时，按命令顺序确定切分；缺行、混入其他命令或截断不补齐；不执行脚本 |
| `head -n N file`／`head -N file` | 起始行 1；仅完整实际返回行，不超过 N |
| `tail -n N file`／`tail -N file` | 保存返回内容用于匹配，历史起始行未知；不使用当前文件行数反推 |
| `tail -n +N file` | 起始行 N |
| `nl -ba file` | 校验每个实际编号行，编号递增范围作为历史线索 |
| `nl -ba file \| sed -n 'a,bp'` | 唯一白名单管道，验证编号未超过选择范围 |
| `rg -n ... path` | 搜索活动单列，不产生主要读取覆盖 |
| `rg --files` | 文件列举 other，不产生源码覆盖 |
| `&&`、`;`、重定向、变量、glob、子命令、多行脚本、其他管道、字节截取 | unknown other 与 unsupported_tool 缺口；不根据最后退出码推前面子命令成功 |

普通源码里的 truncated 单词不会触发截断；只识别支持的工具包装标记。明确中间省略标记前的完整返回行可保留；只有头部提示截断而无法知道输出布局时，不推断行范围。末尾未换行的完整工具返回可代表完整物理末行；JSONL 自身未完成则整体等待。

Claude SDK 部分完整 Read 用 `content.split("\n")` 计数，尾换行会生成额外编号 EOF 空行。只在结构化内容尾 LF、`numLines = 物理行数 + 1`、实际编号输出逐行连续且与结构化内容一致、最后编号等于 `totalLines` 且内容为空时确认这个虚拟末行。片段保留原始结构化源码，因此覆盖只包含物理行；真实的末尾空白行仍保留。缺失可见末行、非 EOF、末行有内容或计数字段矛盾时继续保留范围未知。无尾 LF 和既有物理行计数形式继续支持。

新版命令事件中的多段 `nl ... && nl ...` 即使呈现多个编号段，也继续按复杂 Shell 缺口处理。多段读取仅新增上述固定范围 `sed` 的严格切分：其可输出行数各有上界，只有总返回达到所有上界之和才能确定边界；任一片段不足或存在截断，整组读取范围保持未知。单个新版命令的结构、file URI cwd 和编号内容已有合成回归验证。

本轮额外只读核对两个真实 Claude 来源的全部 6 个 Read：全部获得与实际内容相同的物理行片段；两个完整返回的 SDK 计数分别为 185／362，覆盖片段分别保留 184／361 个物理行，未包含虚拟 EOF 行。120 行的无尾 LF 局部返回仍正常支持。这个来源级回读统计不等同于本项目 Claude 端到端验收，也不扩展未知客户端格式的支持声明。

## 片段与仓库归属

片段 `read` 用实际读取行号；`added` 用编辑后的新视图行号；`deleted` 用旧视图行号；`context` 用新视图行号。不同视图不能凭数字邻接推断关系，删除不计当前修改覆盖，context 仅用于定位。多文件修改拆成独立活动，并在 fragment.path 保存具体文件。

`associateSource` 返回新的相对路径活动，不修改输入来源。每条实际文件路径与 cwd 独立确认。初始 session cwd 属于仓库不表示外部路径活动也属于仓库。相同 Git commonDir 的 worktree 可按其根目录相对路径关联；相同 remote 的独立 clone 不合并。历史文件在当前基线缺失仍保留活动并记录范围缺口。复杂命令的 pathless 活动只在 cwd 可靠属于仓库时保留。手动关联来源也必须继续逐事件约束路径。

已删除的 worktree 不再能查询当前 Git commonDir。此时只用成功的具体 `CommandExecution` 记录交叉确认：在已知仓库／worktree 内执行字面 `git worktree add -b`，返回对应新分支的 `Preparing worktree` 与 `HEAD is now at`，并在后续完整、未截断的 `git worktree list --porcelain` 中同时看到登记仓库和目标目录。创建支持纯 `&&` 连接的多个 add，以及开头的字面 `mkdir -p`；这项 Git 关系提取不改变复杂 Shell 读取的覆盖规则。只关联从成功创建到最后一次清单确认之间、具有明确时间的文件活动；同路径再创建会分开时间区间。当前路径被独立仓库或其他目录占用时不采用历史关系。

历史关系用于发现该 worktree 的其他会话，并把绝对文件路径和相对 cwd 路径映射到当前仓库。原始调用与创建／清单证明均保留在事件的证据引用中；内容仍须通过原有精确／近似对应规则。目录名字、相同 remote、父 Agent 总结及仅有退出码均不足以恢复归属；缺少上述记录、清单确认之后的活动或其他 Git 命令形式继续保留归属未知。

## CodeFlicker 桌面版

新版 MyFlicker 桌面客户端独立注册为 `codeflicker-desktop`；原 `codeflicker` 身份保留并展示为 CodeFlicker CLI。新版格式发现 `message/cache.jsonl`，不把 `claude-session` 的镜像正文作为另一份来源。会话 ID 来自桌面会话目录，cwd 来自身份一致的 `checkpoints/registry.json`；不由项目目录名反向猜测。格式扩展可实现只读旁路元数据钩子，通用发现、Worker、统计与证据回读保留客户端身份。

缓存的 OpenAI 形态 `toolCalls` 与 `toolCallId` 配对，原始工具名不改写。`read_file` 的编号内容或结构化起始行与实际行数共同校验；返回计数、请求范围、终止行和截断标记矛盾时无覆盖。`execute_command` 仅明确退出码确认终态，白名单命令消费实际 stdout。`replace_in_file` 的 `replaced=true` 与返回路径确认成功，无补丁位置时只保留变化片段；`write_to_file` 的成功结果及一致路径确认实际写入快照，这个范围不表示相对原文件的净差异。搜索单列，其他工具和缺少终态的结果保留 unknown。原始记录按物理行与哈希回读，来源缺失或改写时不补造证据。

会话的数值／文本消息 ID 用于去重；`turn_terminal` 的完成状态、轮次和最后消息身份共同认定明确最终回答。活动角色的压缩记录保留压缩信息，其上下文估算不计为请求 Token。模型旁路最多读取单文件 64 MiB、关联 50,000 条消息元信息，超出时列缺口；它不参与正文或工具次数的双重计数。

### 旧桌面／IDE SQLite

`codeflicker-ide-sqlite` 与新版 JSONL 同属 CodeFlicker 桌面版。默认目录为 `~/.codeflicker/data/codeflicker/`；`session_data.sqlite`、`composer_data.sqlite` 的 `KwaipilotKV` 中，`composerData:<会话ID>` 的 `localMessages` 为主记录。同目录 `index.sqlite` 的 `composerMeta:<会话ID>` 提供正式标题；新库的同身份迁移副本优先，API 上下文副本不重复作为用户或工具消息导入。早期 `session`／`message` 表的问答也保留。

容器适配器注册原生发现、记录快照和来源选择规则；查询管道不按文件后缀猜测客户端。实际文件路径不改变，`selector` 保留原生会话键，主记录的 `recordLine` 是键内数组的一基序号；恢复的用量来源追加独立序号，原始数据库路径、键、数组位置及记录一并保留。证据回读 SQLite 对应记录并验哈希，不创建临时 JSONL。来源缓存按路径与选择器区分，读事务可见已提交 WAL，指纹由当前会话、正式元数据及用量旁路共同计算；其他会话更新不使所有缓存失效。未声明完整快检依赖时继续核对内容。单个会话键删除时从新版排除。

有效 `api_req_started` 请求组始终保留原生身份和开始时间；有真实用户轮次关联时可计模型步骤，即使用量缺失或冲突，Token 也保持未知。`token_usage_history_<会话ID>` 中的记录按原生 `sessionId`、`chatId` 和时间关联该请求组。`apiConversationHistory:<会话ID>` 只在同一 `chatId` 的完整、有序文本与思考序列唯一匹配一个原生请求组时补充用量，不重复导入正文；子集、重复块、顺序不符或多个候选均不猜测关联。两种来源归同一请求去重，已知分项冲突保留缺口。`prompt_tokens`／`promptTokens` 是含缓存的总输入；缺失缓存分项保持未知，`totalTokens` 与输入加输出的差额不补成推理输出。`token_usage_session_*` 末次或累计缓存不转换为逐请求用量；没有原生请求身份的早期历史仍不能按回复片段补造步骤。

IDE 的 `workspaceUri` 可能指向工作区缓存；仅正式 `workspace.json` 的单一目录可直接认定项目，缺失或多目录不强行选择。`readFile` 只提取连续 Tab／竖线编号的实际返回前缀，包装说明不计入源码，编号与请求不符不计覆盖。`editFile` 需已接受且路径一致的前后快照，提案或拒绝没有覆盖。工具错误单独返回时优先使用实际结果；MCP 与 Skill 按结构化名称识别，名称提及不算调用。

## 新增原生历史来源

| 客户端 ID／展示名 | 默认根 | 已核验结构 |
| --- | --- | --- |
| `dsh`／DeepSeek Harness | `~/.dsh/sessions` | V3／V4 Zstandard 事件流，同原生身份的代际副本选择完整来源 |
| `pi`／Pi | `~/.pi/agent/sessions` | V3 JSONL 事件树，按持久化父链保留当前与其他叶分支 |
| `workbuddy`／WorkBuddy | `~/.workbuddy/projects` | JSONL 正文，与同身份的 SQLite 会话元信息关联 |
| `opencode`／OpenCode | `~/.local/share/opencode` | `opencode.db` 中 session、message、part |
| `zcode`／ZCode | `~/.zcode/cli/db` | `db.sqlite` 消息与模型请求，按身份关联桌面任务索引 |
| `codebuddy`／CodeBuddy | `~/.codebuddy/projects` | JSONL 转录；已发现样本只有用户正文，其他能力按未记录展示 |
| `qoder`／Qoder | `~/.qoder/projects` | JSONL 转录及 workspace 元信息，不将 workspace 首记录过滤掉 |

对应 `AGENT_MANOR_DSH_DIR`、`AGENT_MANOR_PI_DIR`、`AGENT_MANOR_WORKBUDDY_DIR`、`AGENT_MANOR_OPENCODE_DIR`、`AGENT_MANOR_ZCODE_DIR`、`AGENT_MANOR_CODEBUDDY_DIR`、`AGENT_MANOR_QODER_DIR` 可覆盖发现目录。显式 roots 中传空数组可以禁用该来源；测试须对所有客户端明确隔离来源，避免读到本机真实历史。

新格式通过 `normalized.ts` 生成保留原始位置与哈希的规范化事件，代码地图和会话库共同消费。工具名、输入和原始输出仍保留；失败及缺失结果不会生成精确覆盖。SQLite 快照包含已提交 WAL，元信息参与来源指纹；不执行客户端迁移，不创建原生数据副本作为另一份会话。

压缩事件流的证据位置是解压后 JSONL 的一基物理行，哈希来自该行原始文本。原生 SQLite 的证据位置由适配器的选择器及快照记录顺序确定，回查时重新选择相同原生记录并校验哈希；不是数据库页号。来源缺失、位置或内容改变时显示证据不可用，不补造旧内容。

缓存、reasoning 与输入／输出的互斥或子集关系按来源格式核验，工具专用用量不并入模型请求，会话／轮次累计值不与请求用量相加。无法确认的分母、委派身份、继承边界或正文留存范围列为缺口。未知事件保留为过程，不按 native user 角色直接增加用户轮次。
