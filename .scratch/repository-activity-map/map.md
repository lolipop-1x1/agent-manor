# 代码活动地图：技术决策讨论

Type: grilling
Status: resolved

日期：2026-10-03。产品口径见 [首版规格](spec.md)，本文件记录技术讨论，不代表已经实现。

## 设计树

1. 工程路线与发布约束：已确认。
   - 不 fork 或移植竞品代码，AgentManor 自行开发。
   - 允许依赖 Node.js 等运行时，不要求首版打包为单一可执行文件。
2. 主语言和索引存储：已确认。
   - T3：TypeScript 全栈，后台与 CLI 使用 Node.js。
   - T4：本地 SQLite。
3. 工程组成：已确认，发布方式仍待细化。
   - T5：React＋Vite＋D3 treemap＋CodeMirror 6。
   - T6：Fastify＋Commander＋better-sqlite3，直接 SQL 与迁移、长期分析 Worker、Node 24 LTS 运行目标。
4. 分析流水线：基础方式已确认，具体规则继续讨论。
   - T7：两类格式适配器与明确的工具证据规则。实际日志格式与支持矩阵在实现前用样本核对。
   - 两类历史适配器、事件与结果配对、成功状态和工具证据规则。
   - Shell 读取支持范围、编辑范围、子会话和分叉去重。
   - 仓库与 worktree 归属、文件分类、行数规则与内容版本。
5. 内容对应与增量更新：已确认，具体门槛由样本校准。
   - T8：精确定位、唯一上下文锚点、局部差异比较与近似对应。
   - T9：事件身份、追加／截断／替换、失效重算与结果版本。
   - T10：当前文件盘点、worktree 关系、行数与分类规则。
6. 接口、服务生命周期与验证：已确认。
   - T12：CLI JSON／Web API 契约、刷新任务、进度与 npm 包交付。
   - T13：缺失历史来源与缓存重建的统计策略。
   - 验证沿用已确认的已知样本和真实本机闭环；具体性能样本和版本锁定在实施计划中列出。

## 已作决策

- 2026-10-05：[配置中心 CodeFlicker 数据复核](issues/16-private-data-audit.md) 已完成。全仓读取 62.9%、biz 子目录 64.4% 与独立范围并集一致；规则 8 修复无 cwd 的相对请求归属，恢复两条真实修改活动。130/130 回归、类型与构建通过，真实后台重建／增量刷新、CLI/API 和页面验收一致；证据边界见 [数据复核记录](../../docs/validation/private-data-audit.md)。

- 2026-10-05：[真实历史刷新 Worker 内存耗尽](issues/15-refresh-worker-memory.md) 已修复。未关联来源只缓存归属元数据，确认相关后恢复完整证据；旧缓存按来源读取、事件按来源查询，Worker 异常后下一次刷新可重建。128/128 回归、类型与构建通过，默认真实历史首次重建及约 74 秒增量刷新成功，CLI/API 和页面验收一致；记录见 [内存修复验收](../../docs/validation/refresh-worker-memory.md)。

- 2026-10-04：[覆盖偏低与格式误报核对](issues/14-coverage-underestimate.md) 已完成。精确读取继续独立于 AI 编写归因；matching-v2 恢复唯一未变子块，解析规则 4 排除非工具元数据并严格拆分完整固定范围 sed。最终真实源码读取 58.0%、修改 88.2%、修改文件覆盖 100%；格式误报为 0，96/96 回归及实际页面通过。复杂组合、截断与无法唯一对应内容继续保持未知。

- 2026-10-04：[真实开发历史全零修复](issues/13-real-history-zero-data.md) 已完成。4317 移除冻结调研输入，恢复默认会话目录；成功创建与 Git 清单确认的历史 worktree 恢复逐文件归属，并保留证明引用。真实基线全部 46 源码文件有活动、精确修改文件覆盖 100%，读取精确／近似继续分开；92/92 回归、类型、构建和页面原始证据回读通过。

- 2026-10-04：[Chrome 黑屏修复](issues/12-chrome-origin-port.md) 已完成。真实 Chrome 请求 Origin 丢失端口导致静态资源 403；仅在浏览器同源标记和完整 Referer 同时确认时兼容。4317 已重启，实际 Chrome 地图显示和手动刷新通过，HTTP 五项回归、类型及构建通过。

- 2026-10-04：[首版逐项端到端验收与问题修复](issues/11-e2e-complete.md) 已完成。实际安装包 18 组 CLI/HTTP、真实浏览器交互和独立 Skill 查询链通过；大历史聚合溢出、弹窗焦点与窄屏入口名称已修复，89/89 回归、类型与构建通过。默认约 3.31 GB 历史关联到三实际仓库发布成功，大来源缓存重复刷新语义一致；矩阵与边界见 [端到端验收](../../docs/validation/e2e.md)。本轮直接在 main 开发。

- 2026-10-04：首版实现与最终两轴审查已完成；两项规格 P2 在提交 `cd6d8c7` 修复，以 `1846f07` 合入。类型检查、构建与 87 项全量测试通过，包含真实 npm 包外安装。规格标为 resolved，结果见[审查记录](../../docs/validation/review.md)与[验收记录](../../docs/validation/acceptance.md)。原型分支保留；未公开发包，Windows/Linux 安装仍未验收。

- 2026-10-04：[npm 交付与 Agent 查询 Skill](issues/08-delivery-skill.md) 已合并，合并提交 `0a4286ef99d061f0ce26c50d2a14ebcac82050a9`；macOS arm64 真实 tarball 包外安装、npm bin／Worker／Web／SQLite 与独立 Agent 的 Skill 查询证据闭环通过，同树类型检查、构建及 83 项测试通过。08 已完成，可进入 09 的最终集成验收与审查；授权扩展的 CLI 入口修复与文档白名单范围见票据 Answer。
- 2026-10-04：[真实历史归属查询性能](issues/10-association-performance.md) 已合并，合并提交 `dceb66b6d15d83f7b5fd259cbb27ee90784c890a`；36 项历史测试、服务端检查和生产构建通过。冻结 A 单次关联结果指纹不变，`--show-toplevel` 查询从 580 次降至 1 次；单次关联观测约 17.15 秒降至 0.285 秒。该结果不代表完整刷新提速，数据库与 RSS 边界见[归属性能说明](../../docs/design/association-performance.md)。
- 2026-10-04：[真实闭环验收与性能记录](issues/09-acceptance-review.md) 业务验收完成，验收提交 `d7de67f0c62127c7c492e1da4e75ac89f5fbff3c` 以 `--no-ff` 合入，合并提交 `051b13133cc144035476d2856f254ec6e5f1c69c`。选定的真实 A/G 来源已完成 CLI/API、Web 与安装包 Skill 下钻；性能与支持边界见[验收记录](../../docs/validation/acceptance.md)。完整索引中的删除行无法对应 gap 仍保留；最终两轴 code-review 与修复由主流程继续处理。
- 2026-10-04：[本地 API、后台生命周期与 CLI](issues/06-service-cli.md) 已合并，合并提交 `961db84ebe0bbc42d602501856344c70c35ab3ad`；同树全量类型检查、服务／正式 Web 构建与 77 项测试通过，编译后台可从包外 cwd 提供正式静态资源。06 已完成，可进入 08 的 npm 安装、真实浏览器与业务交付验收。
- 2026-10-04：[SQLite 索引、增量分析与完整版本发布](issues/05-index-worker.md) 已合并，合并提交 `d010615ecc9262125c063c2027cf383ad4c5c737`；服务端类型与构建、全量 72 项测试通过，可进入服务／CLI 实现。
- 2026-10-04：[历史适配器兼容补充](issues/03-history-adapters.md) 已合并，合并提交 `51662d3eb619c22f54bc665ddaf059a55e6cb221`；服务端类型与 32 项历史测试通过，Claude SDK 虚拟 EOF 空行仅在证据一致时兼容。
- 2026-10-03：[历史发现、格式解析与证据提取](issues/03-history-adapters.md) 已合并，合并提交 `4d418e6e8e35bb538d60c31691881e7455825fbe`；服务端类型与 27 项历史适配器测试通过，03／04 已完成，可进入索引 Worker 实现。
- 2026-10-03：[仓库基线、内容对应与覆盖统计](issues/04-baseline-matching.md) 已合并，合并提交 `e6f1ebfe6e506598708acd48c271040107bd6db4`；服务端类型与 23 项分析测试通过，预算超限保留未知按规格处理。
- 2026-10-03：[地图优先 Web 与证据下钻](issues/07-web.md) 已合并，合并提交 `fa0a67114975665347c9845a1b774e649caf4d1a`；Web 类型、生产构建与 5 项数据模型测试通过，真实浏览器和 API 联调保留到验收阶段。
- 2026-10-03：[基础工程与共享契约](issues/02-foundation.md) 已合并到正式集成分支，合并提交 `87f658d8cd8a716d45c1d42744851f7d7ff090eb`；Node 24 下服务端类型检查和 SQLite 加载检查通过。
- T1：用户选择“不复用，自行开发”。竞品只作为行为和格式研究材料，不成为工程基础。
- T2：用户允许依赖 Node.js 等运行时。
- T3、T4：用户同意 TypeScript 全栈加 Node.js，以及本地 SQLite 分析索引；取舍见 [ADR 0003](../../docs/adr/0003-typescript-and-sqlite.md)。
- T5：React＋Vite，D3 treemap 只负责层级矩形布局，React 渲染地图；CodeMirror 6 以只读模式展示当前代码、行号、范围高亮与行跳转。
- T6：Fastify 提供本地 API 与静态页面，Commander 提供 CLI，better-sqlite3 访问索引，先使用直接 SQL 和版本化迁移；Node 24 LTS 为运行目标，版本在实施前锁定。接受原生扩展安装约束，发布前核对目标平台安装。
- T6：一个长期分析 Worker 处理解析和 CPU 匹配、串行写入索引；服务查询已完成结果。SQLite WAL 支持读写并行，刷新提交和结果版本的一致性仍须详细设计。Worker 用于隔离耗时工作，不据此声称 I/O 更快或已达成性能目标。
- T7：Codex／Claude 格式适配器直接逐行解析 JSONL，配对调用与结果；工具证据规则区分成功、失败、缺失、截断、读取、搜索和修改。
- T7：支持直接 Read／Edit／Write／apply_patch 和明确可识别的常见 Shell 形式（如 cat、sed、head、tail、nl、rg）；每种形式分别验证结果和可确定范围。复杂管道、任意脚本和缺失结果保留未知，不执行历史命令，不因出现路径或命令就统计整文件覆盖。
- 使用通用开源基础库，自行开发证据、对应、统计和增量核心；不复用竞品源码。
- 本地后台、Web、CLI、Skill 的形态沿用 [ADR 0002](../../docs/adr/0002-local-analysis-service.md)。语言和库不从竞品自动继承。

- T8：自行实现路径范围、精确片段索引、上下文锚点与候选消歧，使用 jsdiff（npm 包名 `diff`）比较已定位候选的行／字符差异；库不替代位置证据。主要结果仍为精确、近似和未知。
- T8：以能确定位置的未改动内容保留精确范围，小改动行单列近似；新增行不因处于匹配块内就获得读取覆盖。重复候选、短片段、较大重构或预算超限保留未知；不跨全仓库按最高相似度强行归属。
- T8：优先按同一仓库的相对路径对应，改名或跨文件移动需额外可靠的路径关系；关系不足时保留历史活动和无法对应的原因，首版不承诺自动处理任意重构。
- T9：原始记录引用与逻辑事件分开；用客户端、会话、原始消息身份和调用出现位置确定事件，call_id 仅作为配对线索，不单独作为唯一键。分叉重放只有能确认共同来源时才合并；源码或命令相同不抹去真实重复调用。
- T9：每轮核对历史和当前文件内容版本；真正追加从完整记录边界续读，截断、替换、解析版本变化重建受影响来源，尾部未完整记录等待补齐。保留待配对调用，使跨刷新出现的结果能够回填。
- T9：当前文件内容变化只重算相关对应关系；来源变化重建时撤销该来源失效的派生记录，不影响其他来源仍有效的证据。缺失来源的保留与回查策略在服务和缓存规则中继续明确。
- T9：整轮刷新形成完整结果版本后发布，失败保留上一版且标过期；API 查询与页面下钻绑定结果版本，具体契约后续确定。内容哈希核对仍需扫描文件字节，不将增量描述成零读取成本。
- T10：当前基线候选来自已跟踪文件和未忽略的未跟踪文件，再核对磁盘存在性、类型和明确排除规则；已删除路径不进入当前分母。
- T10：使用 Git common dir 建立本机 worktree 关系，分别记录每个 worktree 的当前内容版本；相同远端的独立 clone 不自动合并，无法可靠归属的历史保留待关联。
- T10：首版按文本物理行计数，包含注释与空白行；空文件为 0，末尾换行不额外生成一行。源码／配置／文档按可查看的规则分类，默认排除依赖、生成物和二进制，未知类别单列。
- T10：子模块按独立仓库处理；符号链接保留路径和活动信息，默认不跟随链接盘点内容。
- T11：采用局部相似度、绝对增删字符量和唯一上下文的组合门槛，阈值只控制近似对应，不放宽精确口径；默认数值通过样本校准并记录规则版本。
- T12：一个本地服务管理已登记仓库，提供版本化 REST／JSON API；Web 和 CLI 共用查询结果、筛选和缺口信息，刷新返回任务 ID，CLI 可等待完成，Web 轮询进度。默认一个分析 Worker 串行刷新，服务只绑定本机回环地址。
- T12：一个 npm 包包含已编译的 CLI、后台、Worker 和 Web 静态资源，安装后不需要再构建页面；依赖 Node 24 LTS、本机 Git 和浏览器。包名、版本和目标平台安装在实施前核对，首版在 macOS 真实验收。
- T13：新的完整结果版本排除已缺失的原始来源，记录缺口和统计下降原因，保留上一版用于对照；临时读取错误视为刷新失败，保留上一版且标过期。

## 已确认的补充解释

- 用户进一步提出将文件名、历史行号、返回源码和 diff 结合，并通过相似度或差异字符门槛支持小改动。采用这些信息共同定位；历史行号是候选线索，不能直接当成当前行号，请求行范围也不能替代实际返回范围。
- 相似度计算在已定位的局部候选范围进行，不用整个文件的平均相似度掩盖局部改动。长片段和短片段使用同一百分比可能产生不同效果；短片段须更依赖上下文与绝对差异约束。
- 差异量的定义、默认门槛和计算限额须明确并纳入匹配规则版本，通过单字符改动、短行、重复片段和大文件样本校准；不将示例数字描述成已验证阈值。
- T11：差异字符量为插入加删除的 Unicode 码点数，单字符替换计为 2。技术方案使用 `1 - 差异量 / (历史字符数 + 当前字符数)` 表达对应的字符保留比例；空片段不凭相似度获取覆盖。此数值不是正确定位的概率，计算预算与近似接受门槛分别处理。

## 实施前验证项

- 具体库版本、算法参数和支持格式矩阵仍需锁定和样本验证。
- 技术决定与验证步骤已经整理为 [技术方案](technical-design.md)。当前讨论没有业务实现或运行验收；数值校准和格式核对是首个实施阶段的交付物。

## 已核对的事实

参考仓库：`/workspace/codestudy/agentsview`，HEAD 为 `1148d7f25e0cd89e3fc1c716e092d76172770a99`。本轮只读源码，未运行产品、构建、测试或读取个人历史。

- 技术栈是 Go、SQLite、Svelte 和 TypeScript。前端资源通过 `internal/web/embed.go` 编译嵌入；正式构建使用 CGO 和 FTS5 标签。
- 主档案数据库使用 `mattn/go-sqlite3`。`modernc.org/sqlite` 仅用于特定向量数据库后端，不能据此说主程序不依赖 CGO。
- 解析器、数据库、同步与服务存在内部耦合，不能把整个项目当成可直接引用的独立解析库。
- Codex 与 Claude Code 的所检视解析路径直接读取本地 JSONL，不需要调用模型 SDK。
- Codex 通过 `call_id` 配对请求和结果；Claude 通过 `tool_use.id` 与 `tool_result.tool_use_id` 配对。共享类型保存原始输入和结果，未统一提取可用于行覆盖的范围。
- Claude 的 `is_error` 及 Codex 工具结果状态并不被该项目统一归一为“成功读取”。我们需要按工具和日志形态重新判定，不能用“出现结果”代替成功证据。
- Codex `apply_patch` 可提取文件路径，但未产生变更行范围。Shell 日志不能揭示任意脚本内部的读取或没有呈现的文件内容。
- Codex 的测试明确包含 call_id 重用：`internal/parser/codex_checkpoint_test.go:199` 验证同 ID 后续结果回填到最新调用，`codex_cursor.go:263` 在 checkpoint 保存调用位置。因此 call_id 不能独自承担唯一事件身份。
- Codex 使用 session_meta ID、forked_from_id、turn_id 和 subagent parent_thread_id 的部分关系线索；Claude 存在 uuid／parentUuid 消息链和流式快照合并。字段可支持关联，但不能保证任意历史复制都能去重。
- 本轮只检查解析器和相关测试中的追加回填、尾记录及回退信号，没有检查同步引擎是否对所有截断／替换落实整文件重建；竞品行为不作为我们支持矩阵的保证。
- Claude 官方 SDK 的 Read 请求类型包含 `file_path`、可选 `offset` 和 `limit`；所核对 0.3.267 类型文件的文本响应另有 `startLine`、`numLines`、`totalLines`、`content` 和截断标记。不能假定所有历史版本都保存了这些响应字段，实际支持仍按本地日志样本核对。
- 所检视 Codex Shell 工具用 `cmd`／`command` 表达命令，路径、行号和工作目录需要结合具体输入输出还原，不存在该解析器统一提取的读取行范围字段。

关键源码定位：`internal/parser/codex.go:627`、`internal/parser/content.go:79`、`internal/parser/types.go:1477`、`internal/web/embed.go:8`、`go.mod:3`。

## 官方资料

以下是候选方案的核对资料，链接不表示已接受相应技术。

- [TypeScript 手册](https://www.typescriptlang.org/docs/handbook/intro.html)
- [Go embed](https://pkg.go.dev/embed)
- [Node.js 单一可执行应用](https://nodejs.org/api/single-executable-applications.html)：Node 也有内嵌运行时的发布路径，不能把单一可执行能力描述成 Go 独有。
- [SQLite WAL](https://www.sqlite.org/wal.html)：可支持读写并行，但同一时刻仍只有一个写入者。
- [Node.js SQLite](https://nodejs.org/api/sqlite.html)：官方当前页面标为 release candidate，`DatabaseSync` 同步执行；若选 Node，需要明确驱动版本与线程位置。
- [modernc SQLite](https://pkg.go.dev/modernc.org/sqlite)：Go 的无 CGO 驱动候选，最终性能和发布兼容性不能由介绍文档代替验证。
- [D3 treemap](https://d3js.org/d3-hierarchy/treemap)：提供层级矩形树图布局，可作为地图的基础库候选。
- [React](https://react.dev/learn)、[Vite](https://vite.dev/guide/)：分别提供组件界面与前端构建，Vite 可输出静态资源。
- [CodeMirror 只读模式](https://codemirror.net/examples/readonly/)、[范围装饰](https://codemirror.net/examples/decoration/)、[视口](https://codemirror.net/docs/guide/)：可支撑代码查看、范围高亮和仅绘制可见区域。
- [Fastify](https://fastify.dev/docs/latest/Reference/Encapsulation/)、[Commander](https://github.com/tj/commander.js/blob/master/Readme.md)：分别提供 Node HTTP 服务组织与 CLI 命令解析。
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)、[发布包](https://github.com/WiseLibs/better-sqlite3/releases)：同步 SQLite API 与原生扩展；预编译覆盖和缺包时编译路径需要在目标平台实测。
- [Node 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)：当前文档的驱动状态为 RC，与具体运行小版本相关。
- [Node Worker](https://nodejs.org/api/worker_threads.html)：用于 CPU 密集型 JavaScript；不以逐个任务新建线程作为默认实现。
- [jsdiff](https://github.com/kpdecker/jsdiff)：可按行或字符比较两段输入，提供差异序列和计算限额；不能独自判断片段在当前仓库中的唯一位置。路径、上下文锚点和多候选消歧仍需自行设计。该库尚未选定版本，也未做性能测试。
- [Git 文件清单](https://git-scm.com/docs/git-ls-files)、[忽略规则](https://git-scm.com/docs/gitignore)：跟踪路径和未忽略的未跟踪路径可分开盘点，索引路径仍须核对当前磁盘存在性；忽略规则不自动排除已跟踪文件。
- [Git 元数据定位](https://git-scm.com/docs/git-rev-parse)、[worktree](https://git-scm.com/docs/git-worktree)、[数据模型](https://git-scm.com/docs/gitdatamodel)：支持识别当前 worktree、共享 common dir、符号链接和子模块。应用级仓库身份与统计归属是我们自行制定的规则。
- [SQLite 隔离](https://www.sqlite.org/isolation.html)：读事务可读取一个一致快照；它不自动替应用决定跨请求结果版本或整轮刷新发布规则。
- [Claude Agent SDK 工具参考](https://code.claude.com/docs/en/agent-sdk/typescript)、[0.3.267 工具类型](https://app.unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.267/files/sdk-tools.d.ts)：用于核对读取请求和实际返回范围的区别；读取历史仍自行解析日志，不以 SDK 类型替代日志格式验收。

## Comments

- 2026-10-03：用户认可原型并调用 implement-spec。正式实现采用独立分支，任务图为 02 → 03／04／07，03＋04 → 05 → 06，06＋07 → 08 → 09。默认 A 地图优先；原型保留在独立分支。

- 2026-10-03：用户要求从产品讨论进入技术讨论，包括开源基础、技术和语言。已完成两项根决策，正在等待 T3、T4；后续问题随前置选择推进。
- 2026-10-03：用户回答“可以按你的建议来”，确认 T3、T4。进入具体框架、分析执行与历史解析方案讨论。
- 2026-10-03：完成候选库官方资料核对，已提出 T5 至 T7。正在等待本轮选择；近似匹配、增量策略和接口契约尚未确定。
- 2026-10-03：用户回答“好的，按你的建议来”，确认 T5 至 T7。进入内容对应、去重、增量更新与仓库基线规则讨论。
- 2026-10-03：核对 jsdiff、Git 工作区盘点、SQLite 快照，以及竞品解析器的事件 ID 重用和分叉线索。已提出 T8 至 T10，等待本轮选择。
- 2026-10-03：用户选择 T8 第一个方案，T9、T10 按建议执行；进一步提出文件路径／历史行号／内容联合作 diff 和可设门槛。基础算法路线已确认，近似门槛政策正在细化。
- 2026-10-03：已解释历史行号与当前行号、请求范围与实际返回范围、近似门槛与精确口径的区别。提出 T11 至 T13，等待近似政策、接口／安装和缺失来源策略的选择。
- 2026-10-03：用户确认 T11 至 T13 的推荐方案。技术讨论收敛，形成技术方案；版本锁定、格式支持矩阵和近似数值门槛在首个实施阶段通过样本验证。
