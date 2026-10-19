# 使用指南

首版安装矩阵为 macOS arm64/x64、Linux arm64/x64、Windows x64；实际验收环境与边界见 [CLI 交付验证](validation/npm-cli-distribution.md)。Windows ARM64 暂不在本轮矩阵中。

运行需要 Node.js 24；登记和分析仓库时需要 Git，使用 Web 时需要浏览器。`agent-manor` 与 `am` 使用相同参数、输出和数据目录；下文两种写法等价。所有命令都可以在仓库外的工作目录运行。

## 安装与首次使用

```sh
npm install -g agent-manor
am --version
am web
```

`am web` 按需启动本地后台。首次初始化在终端持续显示阶段、处理数量和耗时，等历史、搜索索引、用量及默认总览首屏缓存准备完成后再打开网页；已有完整初始化结果时快速打开。关闭终端后后台继续运行。会话历史无需先登记仓库，代码地图需要另外登记 Git 仓库；没有登记仓库时跳过地图准备。另一终端可用 `am status --json` 查看状态。

安装包包含 CLI、后台、长期 Worker、Web 静态资源与 Agent Skill，无需安装 TypeScript／Vite 或再次构建。程序与数据目录分离，更新不会将知识和偏好写到 npm 安装目录中。`better-sqlite3` 安装使用预编译原生扩展；没有兼容预编译包时可能需要 Python、C/C++ 编译工具链。安装错误与 Node 版本、平台和网络情况需要分别核对。

### 使用本地交付包

已有构建好的 tarball 时，也可安装到独立目录：

```sh
mkdir -p ~/agent-manor-local
cd ~/agent-manor-local
npm install /absolute/path/agent-manor-0.1.0.tgz
./node_modules/.bin/agent-manor --version
```

本地安装时，将下文命令换成安装目录中的 `node_modules/.bin/am`，也可直接 `node /absolute/install/node_modules/agent-manor/dist/cli.js`。需要全局安装 tarball 时使用 `npm install -g /absolute/path/agent-manor-0.1.0.tgz`。

## 服务与完整 CLI

```sh
am start
am start --wait-data
am status --json
am ready --timeout 120 --json
am web --no-open --json
am logs --lines 50
am stop --wait
am restart --wait --wait-data
am doctor --json
```

`start` 复用同一数据目录的健康实例，或启动可脱离终端的后台。默认监听 `127.0.0.1:16666`，占用时顺延，最多尝试 100 个候选；指定 `--port` 则固定使用该值，冲突直接失败。实际地址、PID、版本和日志位置由返回结果及本地实例记录给出，不按端口范围接管其他程序。

服务就绪和数据准备分别表达：HTTP 先供状态与诊断使用；`start`、`web` 首次自动等待完整数据，初始化中断后仍会等待。首次默认不限数据等待时间，指定 `--timeout <秒>` 可以提前结束等待；已有完整结果时快速返回，`--wait-data`／`ready` 可显式等待本轮准备。JSON 模式不输出人类进度。准备失败显示阶段和原因，保留已发布结果与可复用来源。普通业务查询按需启动；`status`、帮助、版本、诊断和日志保持只读。`stop` 遇到在途任务明确拒绝，`--wait` 等待完成后再停止；等待超时不终止后台。

业务命令按 `sessions`、`overview`、`repositories`、`usage`、`resources`、`knowledge`、`semantic` 和 `preferences` 分组，旧版顶层代码活动命令继续兼容。查询提供常用具名参数及 `--query <json>`；写入支持 `--input <file>`、`--input -` 从 stdin 读取，或 `--data <json>`。使用 `--help` 查看具体命令；稳定字段、标识和 JSON 不随显示语言改变，进度与错误写 stderr，`--json` 的 stdout 仅包含结果。`logs --follow --json` 使用逐行增量事件。

`am skills install --target codex --scope user` 安装完整 Skill；`--target claude`、`--scope project --project-directory <path>` 和 `--target custom --directory <path>` 选择其他目标。`skills status/update/remove` 复用同一目标参数。同版跳过，用户修改与外来同名目录先报告冲突，明确 `--overwrite` 前保存备份。npm 安装不会自行写宿主配置。

`am update --check` 只检查公共 registry 版本，`am update --to <version>` 显式更新。持久的全局／本地 npm 安装支持更新；源码和临时运行环境提供诊断，不直接覆盖。同一安装还有其他数据目录的后台运行或正在启动时，更新会拒绝并列出目标，需先显式停止这些实例。当前服务先核验在途任务，必要时使用 `--wait`；停止后备份数据，安装成功后仅恢复原本运行的服务。失败保留恢复材料，不自动降级数据或删除数据库。

## CLI 参数与返回值

默认输出完成当前操作所需的表格或摘要；查询范围与输出格式分别控制：

| 用法 | 返回内容 |
| --- | --- |
| `am sessions list` | 一页会话摘要，默认20条，不展开消息和画像 |
| `am sessions list --json` | 同一摘要范围的稳定JSON字段，适合脚本和Agent读取 |
| `am sessions list --json --full` | 完整字段，仍遵守端点分页与筛选，不等于导出全部历史 |
| `am sessions messages <sessionId> --mode brief --json` | 指定会话的对话正文，长正文默认分段返回 |

`<sessionId>`等是占位符，执行时替换为实际返回的ID，不要把尖括号传给shell。`version`表示结果快照，翻页、消息和证据下钻沿用同一版本；软件版本使用`am --version`。`null`或摘要中未提供的字段不表示零、免费或没有证据。

普通摘要列表默认每页20条，分页使用`--page`和`--page-size`；`--full`不再注入摘要的默认页大小，未指定时采用端点默认值。消息正文续读使用`--message-id`、`--text-offset`和`--max-text-chars`。当`textTruncated=true`时，保持会话、版本、阅读模式和消息身份，使用返回的`nextTextOffset`继续读取；它与下一页消息是不同的操作。`--full`可能返回很长的正文，按需要显式使用。

具名参数优先于`--query '<JSON对象>'`中的同名字段，后者使用API的camelCase键名。写入正文通过`--input <file>`、`--input -`或`--data '<JSON对象>'`提供；复杂正文和Windows命令行优先使用UTF-8 JSON文件，避免shell转义差异。布尔开关不带值，要求`<value>`的选项须提供值，以该命令的`--help`为准。

详细字段、分页和完整响应边界见[CLI响应约定](design/cli-responses.md)；逐功能参数、返回值及续读示例见[配套Skill](../skills/agent-manor/SKILL.md)及其按场景拆分的reference。

## 登记、查询和版本

```sh
agent-manor register /absolute/path/to/repository --wait --json
agent-manor repositories --json
agent-manor coverage <repositoryId> --json
agent-manor web
```

首次登记返回 `{repository, job}`。`--wait` 等待完成；检查 `job.status` 为 `completed` 后使用 `job.version`，失败时有 `job.error`。重复登记同一仓库返回 `{repository}`，不再次启动分析；需要更新时显式执行 `refresh --wait`。普通查询会连接现有后台或按需启动，启动时检查已登记仓库；如果返回 `ANALYSIS_NOT_READY`，先查询任务或执行 `refresh --wait`。

Web 登记弹窗可以从全局会话库选择项目，按名称或完整路径搜索，选择后填入绝对路径；也可以直接输入或修改路径。历史项目路径不保证当前有效，提交时校验可读取的 Git 仓库；子目录归到所属仓库根目录，不同 worktree 独立登记。已登记项目显示标记，重复提交进入已有仓库。项目候选为空或加载失败时，手动路径仍可使用。

仓库下拉菜单的“删除当前仓库”先展示名称、完整路径和清理范围。确认后删除该仓库登记、分析版本、来源与映射缓存、任务记录和手动关联，保留本地 Git 目录、原始历史、全局会话库及资源数据；删除后会话项目仍可用于重新登记。分析中也可删除：排队任务跳过，运行任务在检查点退出，旧结果不能写回。重新登记会重建分析，不恢复已删除的任务历史和手动关联。删除后切换到剩余仓库，全部删除后回到登记空状态。

覆盖率默认返回 `version`、`baselineHash`、`createdAt`、`stale`、`filters`、`summary`、`files` 和 `gapCount`；缺口正文通过 `am repositories gaps <repositoryId> --version <analysisVersion> --json` 按需读取，`--full`保留完整字段。将返回的版本与相同筛选带入文件、活动和证据查询，避免把不同刷新结果混在一起：

```sh
agent-manor coverage <repositoryId> --client codex --categories source --directory src --json
agent-manor file <repositoryId> src/example.ts --version <analysisVersion> --client codex --categories source --directory src --json
agent-manor events <repositoryId> --path src/example.ts --version <analysisVersion> --client codex --categories source --directory src --page 1 --page-size 50 --json
agent-manor evidence <repositoryId> <eventId> --version <analysisVersion> --client codex --categories source --directory src --json
```

查询参数 `--version` 是分析结果版本；程序版本用 `--cli-version`／`-V`，单独执行 `agent-manor --version` 也支持。

## 知识库

顶部“知识库”以 Beta 标记试验阶段，提供全部知识、个人记忆、项目记忆和通用经验视图；这些入口浏览同一份知识集合。项目是适用范围，来源客户端说明知识从哪里产生，不限制其他客户端读取。可以组合项目、客户端、内容类型、标签、审阅、可用性及时间筛选。项目导航和知识列表均可拖动分隔线或使用方向键调宽，各自保留宽度；长项目名以省略号显示，悬停或键盘聚焦可查看完整路径。窄屏使用抽屉导航和单栏阅读。

主动切换侧栏浏览入口时，重设该视图的项目、审阅和可用性范围：普通视图默认已审且有效，具体项目只限定所选项目，待审队列默认覆盖全部项目。切换会清除上次任务结果范围并回到第一页，搜索词、客户端等手动筛选继续保留。在待审队列点击“返回知识库”则恢复进入审阅前的筛选及阅读位置；任务的“查看待审结果”独立展示该任务结果，不叠加旧搜索或客户端条件。

“新建知识”直接保存标题、正文与明确范围，不调用生成模型。可保存待审，也可选择“保存并确认发布”并作出独立确认。Agent 或普通 HTTP 提交始终待审，不能在提交内容中自行声明已经人工审阅。默认查询已审阅且当前有效的版本；待审候选和已拒绝内容需要显式筛选。

详情包括正文、来源和版本。已审知识收到修改建议时，原版本继续有效；在待审队列比较差异、核查来源后确认或拒绝。编辑和恢复旧版本都形成新修订。基础版本已变化时，保留当前编辑并重新核对，不静默覆盖他人修改。废弃与审阅独立，确认新版本不会自动恢复已废弃条目；过期、替代和已解决事项默认不参与搜索，历史仍保留。

首次审阅新知识采用单栏正文，已有发布版本的修改采用双栏差异；两者都支持编辑、拒绝和明确确认发布。来源按会话、分支和输入版本分组，每条依据可展开摘录并精确跳转；没有会话身份的提交保持独立。重复的常规输入精简说明合并到“抽取说明”，来源失效、覆盖缺失、未读取媒体和冲突继续显式显示。内置限制只展示本地化说明，原始诊断仍保存在快照；未知诊断保留原文，异常按需查看“排查信息”。

### 从会话沉淀

“沉淀知识”进入新建页，可以搜索会话标题、按项目和客户端筛选并选取会话，也可切换为按条件批量选择。会话库入口预选整会话、当前轮次或轮次范围。“任务记录”独立查看先前任务，点击后有摘要、过程和结果，深链刷新仍定位该任务；新建页不会被旧任务占用。一次轮次包含用户需求及其后续回复与工具过程；长会话按模型预算分段，再归并同主题内容和后续纠正。

从会话进入后会显示所选标题并自动预览，选择“整段会话”或“指定轮次”，确认预览后点击“开始沉淀”。预览本身不调用生成模型。修改轮次时保留完整布局，重新预览完成前不能开始；输入规划升级前的暂停任务需新建预览，不能继续旧分片。

预览展示待处理会话、轮次、输入估算、额外上下文、已处理可跳过部分和可计算的费用。启动后范围固定，任务记录读取、提炼、归并和保存阶段及实际处理量，可以暂停、继续和重试。关闭页面不停止已启动任务。没有长期价值允许零产出；失败或需要补充上下文的范围不会冒充处理完成。

预计分片与提炼输入估算采用同一份实际文本规划。媒体编码不作为文字输入，原始来源仍可回查；“更多操作”可查看原始字节量、抽取文本字节量、媒体省略数及输出预留。Token 为文本粗估，分片使用保守窗口保护，长轮次仍可能分为多片。页面估算只覆盖基础提炼，后续归并、比较和回读另计，实际模型用量单独记录。

用户和助手正文连续保留；长工具结果采用最多 2,048 字符的有界文本视图，保留头尾、关键错误或验证行和省略标记，工具调用及系统上下文视图最多 1,024 字符，重复记录以定位引用代替正文。原始消息及哈希不改变。模型可以按消息和字符位置补读；每段最多两次、每会话最多四次且合计不超过 16KiB，暂停恢复不重置额度。省略标记或工具的普通成功状态不证明测试结论，证据不足仍可能需要重新选范围或人工核查。

后续分片获得本任务前序分片归纳的少量主题卡片，包含程序生成的 ID、名称及摘要；ID 只在本任务内保持稳定，不是知识库中跨任务复用的主题分类。模型可选择已有主题或提出新主题，再区分重复、补充、纠正、冲突、相关和独立。分片完成后再与已存知识比较；关键词及可选向量只召回候选，不直接决定合并。冲突保留为独立待审内容，不因出现较晚就覆盖旧结论。

增量按消息身份和内容校验记录实际覆盖，不以最大轮次冒充全部历史都已处理。已处理片段、没有新增知识的结果和待审状态分别管理。新消息可结合早期证据提出更正；来源旧版本已经无法核验时，需要重新预览。来源失效不删除知识及已保存摘录，也不跳转到相近记录冒充原始证据。

### 模型、语言与后台策略

在知识设置中配置生成服务地址、模型及可选凭据。支持 OpenAI 兼容 Chat Completions 的 JSON 输出，模型仍需满足设置的上下文和输出预算；格式错误、输出截断及无效来源引用不会保存为知识。高级参数中的思考强度默认采用模型服务默认值，仅在服务支持时显式选择；本地思考模型可选择关闭，避免将有限输出预算全部用于思考。

凭据默认隐藏，可按需查看、复制或清除已保存的 Key；查看不会当作修改保存，隐藏、离开设置或切换设置标签后会清除本次读取的明文。普通配置接口不回传 Key；专用读取端点允许本机同源 Web 或已明确授权的 CLI 管理动作，响应禁止缓存。

知识输出语言独立支持简体中文和英文。首次显式进入设置时按当前界面语言初始化，之后切换界面不改写此设置或既有正文。新知识使用任务固定的语言；补充旧知识沿用旧版语言。原始引用、代码、路径及错误串保持原文，直接提交不自动翻译。

高级提示词可以调整抽取和归并要求、恢复默认，并先试抽取一个小范围。试抽取调用所配置模型但不自动入库。修改模型、提示词或输出语言只影响新任务，不自动重抽全部历史。

自动沉淀默认关闭。首次选定范围、预览并启动后，可开启一套后台策略，默认每小时检查、会话安静至少 30 分钟后处理新增或变化内容，默认排除明确子会话和 Quiet 模式。活动时间未知时不宣称已满足静默条件，手动处理仍可使用。后台关闭期间不运行，不新增系统自启。顶栏历史自动同步负责发现原始会话更新，与知识自动沉淀分别配置。

生成和 Embedding 分别记录调用与预算。新任务记录生成模型快照、逐次提炼／归并／回读／重试的请求、实际或估算 Token、可获得的缓存命中／未命中及估算费用。任务详情保留最多 400 条过程事件，超出会说明省略数量；旧任务没有记录的明细显示未记录，不补造。可设置单任务输入及费用预算；失败请求保留预留，重试和重启不能清空额度。费用未知保持未知；预算用于停止继续发起请求，不等同于精确限制服务商账单。配置远端服务时，所选输入会发送至该服务；直接保存、关键词检索和原文阅读不调用模型。

### 关键词与语义搜索

关键词搜索在本机匹配标题、正文、标签、适用条件和必要来源摘录，包括中文短词、代码标识与错误串。知识语义搜索可关闭、复用会话连接或独立配置；复用连接不要求先建立会话向量索引。

启用知识 Embedding 后，抽取中的候选匹配也可以编码有界的候选短文本并缓存向量，无需先建立正式知识索引；失败回退关键词匹配并记录限制。这部分调用计入知识向量用量及预算，与任务详情的生成用量分别记录。关闭 Embedding 仍可提炼、归并及关键词搜索。

首次编码或更换不兼容的 Embedding 连接后，先预览知识规模再启动构建。待审和已审有效修订分别编码，查询仍遵守审阅、项目和可用性筛选。尚未编码的条目可以关键词查询；旧向量不会使废弃、过期或已替代正文重新进入默认结果。跨语言召回取决于所配置 Embedding 模型，不隐式调用生成模型翻译查询。

### 知识 CLI 与明确确认

```sh
am knowledge write --input knowledge.json --json
am knowledge list --review pending --json
am knowledge get <knowledgeId> --review all --json
am knowledge search "配置缓存" --json
am knowledge review <knowledgeId> <revisionId> approve
am knowledge extraction preview --input scope.json --json
am knowledge extraction start <previewId> --wait --json
am knowledge extraction list --json
```

直接写入无需生成模型，保存为待审修订。审阅先读取最新修订、当前已发布正文和核对内容，再确认具体操作；旧修订会被拒绝。交互终端显示操作并要求输入确认摘要。非交互调用先返回 `CONFIRMATION_REQUIRED` 和 `details.confirmation`，用户核对并明确授予该次操作后，使用 `--authorize <digest>` 重试；普通 `--yes` 不构成审阅授权。短期令牌绑定实例、路径和完整请求内容，仅能使用一次。可用性修改也绑定最新修订，内容变化后需重新核对；终端类型与本机进程身份不被宣称为人工证明。

`knowledge settings key <generation|embedding>` 与 `semantic settings key` 采用同样的按需授权；默认设置输出保持脱敏。抽取、知识编码和会话语义编码分别使用自己的任务状态入口，`--wait` 只在完成时成功，失败、暂停、预算停止、部分完成或超时不会伪装为成功。

### 本机 HTTP 接口

实际地址和端口从数据目录的 `service.json` 读取，不硬编码端口。接口前缀为 `/api/v1/knowledge`；普通 Agent 请求沿用当前服务的实例身份头 `x-agent-manor-instance`，写入使用 JSON。实例头标识本地服务，不构成人工审阅证明。审阅与可用性修改由同源 Web 或明确授权的 CLI 管理动作处理；本功能没有引入账号或远程角色系统。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /entries`、`POST /search` | 按范围及状态浏览、关键词或语义查询 |
| `POST /entries` | 直接提交待审知识，无需模型 |
| `GET /entries/:id` | 读取当前默认内容，或显式指定修订和状态 |
| `POST /entries/:id/revisions` | 基于最新修订提交待审修改 |
| `GET /entries/:id/revisions`、`GET /entries/:id/revisions/:revisionId` | 读取完整历史修订与该版来源 |
| `POST /entries/:id/reviews`、`POST /entries/:id/availability` | 明确授权后确认／拒绝及废弃／恢复 |
| `POST /entries/:id/restore` | 从旧版形成新的待审修订 |
| `POST /extractions/preview`、`POST /extractions` | 预览固定范围、显式启动任务 |
| `GET /extractions`、`GET /extractions/:id` | 任务状态、结果和实际进度 |
| `POST /extractions/:id/pause`、`resume`、`retry` | 暂停、继续与重试失败范围 |
| `GET /settings`、`PUT /settings`、`POST /prompts/try` | 配置与不入库试抽取 |
| `POST /settings/key` | 管理动作按需查看指定种类的已保存凭据，禁止缓存 |
| `POST /index/preview`、`POST /index/build` | 显式预览及构建知识向量 |

直接提交的最小正文示例：

```json
{
  "title": "动态配置应保留可更新引用",
  "body": "适用条件：配置需要在运行期间生效。避免长期保存启动时的静态快照；修改后验证后续请求是否读取新值。",
  "scope": { "kind": "project", "project": "/workspace/atlas" },
  "type": "lesson",
  "tags": ["动态配置", "缓存"],
  "language": "zh-CN",
  "sources": [{ "kind": "agent" }],
  "idempotencyKey": "example-knowledge-submit-1"
}
```

创建、修订与任务启动支持幂等键。同一键重试返回原结果，不同载荷重用该键会报冲突。修订与恢复的 `baseRevisionId` 使用最近读取的 `latestRevisionId`。默认读取不返回待审正文；管理查看需显式设置 `review=all&availability=all`。历史读取是显式行为，不会因为选择全部审阅状态就把所有旧版混入日常结果。

### 保存与备份

知识正文、修订快照、审阅与状态记录、必要证据和任务覆盖保存在数据目录的 `knowledge/knowledge.sqlite`。模型设置位于同目录的 `config.json`，本机凭据位于 `credentials.json`，不要提交或上传这些私有配置。知识向量是可重建派生数据。清除会话索引或重建向量不删除人工知识。备份时先停止后台，再备份 `knowledge/` 中的权威数据库、配置及凭据；不能只保存向量索引来恢复知识。

## 显示语言

顶栏语言菜单提供“自动（跟随浏览器）”“简体中文”和“English”。首次使用自动模式，按浏览器语言列表中首个支持的中文或英文系列选择；其他语言回退英文。切换立即生效，保留当前页面、筛选、选中项、分页及地图视野。其他已打开页面在重新获得焦点时同步。

Web 手动选择保存在当前数据目录的 `preferences.json`，CLI 每次启动也读取它；服务重启或清除历史索引不会删除偏好。选择自动会清除手动覆盖：Web 跟随浏览器，CLI 跟随系统。不同 `--home`／`AGENT_MANOR_HOME` 数据目录各自独立。

CLI 优先级为 `--lang` → `AGENT_MANOR_LANG` → 共享手动偏好 → 系统语言 → 英文。参数和环境变量接受 `zh-CN`、`en`、`auto`，只覆盖本次执行，不保存偏好。显式 `auto` 忽略较低优先级的手动设置，按第一个非空的 `LC_ALL`、`LC_MESSAGES`、`LANG` 检测；未支持语言及 `C`／`POSIX` 回退英文。无效覆盖值和偏好保存失败会明确报错。

```sh
agent-manor --lang en --help
agent-manor coverage <repositoryId> --lang zh-CN
AGENT_MANOR_LANG=en agent-manor sessions --help
agent-manor --home /absolute/path/to/data --lang auto --help
```

语言只影响产品界面、帮助、人类摘要和错误提示。会话标题与正文、资源描述、工具／模型名称、路径和配置值保持原文；数字、日期和日历使用当前显示语言，但查询边界与统计含义不变。默认 pretty JSON 和 `--json` 输出都保留稳定字段、枚举、数值及原始诊断。新产品提示可附带 `messageDescriptor` 或对应字段；旧记录和外部错误以“原始详情”展示，不因语言切换重建索引。

## 外观与主题

点击顶栏调色盘图标打开“外观”。显示模式可选“跟随系统”“明亮”或“深色”，主题色可直接选择蓝色、赤陶、青瓷、琥珀、莓红和石墨。自定义颜色时点击色块打开色盘，选好颜色后点击“应用”，无需输入色值。明暗模式与主题色可以分别选择。

主题色用于按钮、选中态、链接与地图色阶，浏览器标签图标同步变化；失败、近似与未知等状态保留独立语义色。地图的统计范围、面积和指标含义不随配色改变。

外观与语言一样保存在当前数据目录的 `preferences.json`，访问同一数据目录的浏览器共享偏好，已打开页面在重新获得焦点时同步。重新打开页面或清除历史索引后仍保留；不同数据目录各自独立，不涉及云同步，也不修改其他 Agent 客户端的外观。切换外观保留当前筛选、阅读位置和地图视野。

## 总览

打开网页默认进入总览。顶部日期默认近一年，客户端与项目作用于整页；用量区域的模型选择只改变用量及模型分析。六项概况之后，可查看活动日历、重点洞察、用量与分布、Skill／MCP、过程调查、使用画像及已登记仓库。

点击数值、日期、资源或洞察进入调查层。核心洞察最多五条，不提供完整洞察列表；各分析区的“查看全部”提供服务端分页排行与记录。资源可按次数与会话数进入日期、客户端、项目和工具分布，再打开原会话。Skill 调用与正文读取分开，MCP 按服务器进入工具；资源组合默认按会话，可切换真实用户轮次。调查层内返回上一层，关闭后继续当前总览位置。

活动日历可切换会话、请求、Token 与工具调用。键盘在日历中移动日期，Enter 打开调查。用量趋势可切换指标与时间粒度；月度项目、模型切换与主子模型组合可从完整分布调查进入。过程区域提供已确认失败、压缩与可比较计时记录，不自动评价任务效果。

首次进入时各分区独立显示；“更新总览”及已有结果的筛选保留完整布局，全部新分区准备成功后替换。它不启动所有历史和仓库的刷新。仓库摘要与热点只计算所选单期范围，打开代码地图保留仓库版本、日期、客户端和路径；不提供两期热点比较。变化洞察只使用完整日期，可查看两个区间与支撑记录。详细口径见 [总览看板](design/overview-dashboard.md)。

## 全局用量统计

顶部选择“用量统计”，默认汇总近 30 天主、子会话各自新增的逐请求用量。客户端、项目与模型支持多选、排除和搜索；日期支持预设及自定义区间，“更多筛选”包含主／子会话、会话类型、用量覆盖、定价覆盖和会话 Token／费用范围。

指标、时间趋势、Token 组成、用量归因、日历热力图与会话明细使用同一范围。Token 使用 M（百万）单位，悬停数值查看完整记录值；摘要包含总输入、总输出、日均费用、每日峰值费用及日期、项目数、原始模型数和活跃天数。日均费用按所选日历天数计算，空白日也纳入分母，无时间请求不计入每日指标。

趋势可切换 Token／估算费用／请求数，按小时、日、周或月查看，支持柱状和折线；悬停查看时间明细，点击或 Enter 保留浮层，Escape 关闭，日期范围通过顶部控件设置。用量归因默认矩形占比，颜色随占比增强，可切换横条排行；悬停或键盘聚焦方块查看完整名称、数值与占比，点击具体分组追加筛选。会话与请求表分页不改变图表范围；请求明细可以定位已有消息，缺定位依据时打开所属会话。

趋势也可选择“吐字速度”，按模型与客户端比较合格请求的输出Token／耗时。响应区间、输出阶段以及原生计时、历史估算分别标注，不混成同一计时口径；历史估算保留近似标记，没有合格样本的日期保留未知，不补成零。曲线值由同一批请求的输出Token总和除以耗时总和，详细样本条件与覆盖可在帮助和区间明细查看。

“管理模型价格”可给任意模型设置输入、输出、缓存读取与缓存写入单价，也可把原模型映射到明确的服务商和计价模型。列表可按未匹配、自动匹配、手动映射、用户定价筛选，并与搜索组合；点击名称、定价依据或单价表头切换升降序，排序覆盖完整筛选结果，缺失单价始终排在末尾。用户价格始终优先，联网更新不覆盖手动设置。自动目录网络优先，失败沿用最近成功缓存和随包价格；缺价格显示未定价。金额使用 USD／百万 Token 单价重估，页面显示获取时间与估价覆盖，不表示实际账单或订阅支出。

自动匹配结合目录标准身份和同版本型号，优先采用官方 API 单价，免费或套餐内请求也按该基准估算。模型身份冲突、缺 API 基准或手动映射失效时直接显示原因；“查看相关候选”可选择计价目标，也可填写任意价格。价格管理表显示模型名的默认匹配，请求明细按记录的服务商和发生时间取价。没有历史生效日期的备用单价只用于当前快照估算。

跨天请求按已记录发生时间进入本机日期，缺时间独立显示。缓存包含在输入时不再次累加，推理包含在输出时也不重复计入；字段缺失保留未知。详细公式、覆盖与版本边界见 [全局用量与估算费用](design/usage-statistics.md)。

## 全局会话库

网页顶部选择“会话库”。左侧搜索标题或消息，客户端与项目可直接筛选，日期、过程内容、子会话及会话类型放在“更多筛选”中。中间切换“对话／全部记录／执行轨迹”，右侧以“概览／调用／用量”查看统计。三栏各自滚动，操作区保持可见；侧栏可以折叠与拖动调宽，小窗口通过“会话列表／会话统计”打开抽屉。

默认列表收起有明确委派证据的子 Agent 会话，勾选“显示子 Agent 会话”可查看全部。搜索始终包含子记录并标明所属父会话；子任务入口集中在父会话右侧画像“概览”的“关联子会话”中，子详情可返回父会话。明确委派但父记录缺失时标注“父会话未记录”，仍可通过子 Agent 筛选、搜索和直接链接查看；关系不明确时保留独立入口。子任务缺少正式标题时使用任务路径名称、Agent 名称或编号，并标明来源。

会话标题下方显示客户端、项目和时间，轮次数在右侧概览查看。会话列表底部使用单行分页，可输入页码并回车或点击“跳转”；左下角不再显示导入详情入口。阅读工具栏集中模式、会话内搜索和轮次导航；点击“第 N / M 轮”可输入轮次并回车跳转，也可选择首轮或末轮。前后箭头切换相邻轮次，“问题目录”按用户问题摘要定位，长链接和已识别的技能注入正文不会挤占摘要；原始消息保持完整。

“对话”“全部记录”与“执行轨迹”支持上下连续阅读，靠近边界时分段补入前后文，跳到末轮后仍可向上滚动。补载保持当前可见消息或节点的位置，失败时可重试，已读内容仍保留。初始上下文不计用户轮次；全部记录默认折叠过程，搜索或请求定位会自动展开。执行轨迹保留记录分页按钮用于直接跳转，页码跟随当前可见记录；表格滚轮支持跨记录段和轮次组接续，短页也可继续滚轮加载，下方正文详情独立滚动。

用户问题使用轻主题色底与左侧细线，AI 回复标明角色及已记录的模型。正文支持 Markdown，长内容可展开，图片只显示替代文字。缺少可靠结束记录时，对话展示本轮最后一条已保存的 AI 回复，通过“回复详情”解释状态，不常驻“未确认结束”徽标；复制本轮问答与导出仍保留该标注，复制回复只复制正文。这类回复不代表任务已完成。

全局搜索默认覆盖标题及用户／AI 正文，过程内容可额外选入；会话内命中显示在浮层中，清除搜索恢复原阅读位置。点击用量图、请求编号、工具或资源名称可回到证据记录。

搜索方式默认“关键词”，也可主动启用“语义”。点击搜索入口旁的“搜索设置”，在同一对话框配置服务地址、Embedding 模型及可选 Key，测试连接后选择维护范围，预览规模、复用量和预估费用，再开始构建。首次完整构建后方可查询；保存连接不会处理历史。模型服务需由用户提供，本产品不自动下载、安装或启动模型。Key 可以按需显示、复制、替换和清除。

语义模式描述想找的对话，按 Enter 或点击“搜索”提交。后台在查询缓存未命中时调用模型编码查询，然后在本地匹配已有向量。输入文字、切换模式以及改变筛选／排序／分页不会自动调用模型；缓存过期时需重新提交。结果按会话分组，以相关性排序，可切换最近更新，并从原文片段跳转消息。一次最多保留 200 个候选会话，每组最多 3 个片段，候选数不是全历史精确命中数。

维护范围和查询筛选独立。最近天数、项目、客户端、会话关系、Quiet、历史模型、标题、消息／轮次数等均可筛选，默认排除已确认子 Agent 和 Quiet。移出维护范围的有效索引默认保留并可搜索；仅在主动开启“清理时间窗口外的索引”后清理相应派生数据。原始会话不受影响。

构建状态可从搜索旁的状态入口反复打开。暂停后台构建保留检查点，主动语义查询仍可调用模型；关闭网页后服务继续已启动任务。调用策略页配置并发、批次、限流、超时、重试、单价和每日估算预算，并查看本功能用量。未配置单价时费用为未知；预算不是服务商账单上限。“关闭语义搜索”保留索引，“清除语义索引”需要单独确认，保留模型连接。详细边界见 [语义搜索](design/semantic-search.md) 与 [验证记录](validation/semantic-search.md)。

有会话内分支时，“阅读分支”可选择当前分支、全部分支或保存的叶分支。简易默认当前分支，完整／轨迹默认全部；已保存真实对话不会因压缩摘要而消失。切换分支仅改变阅读视野，画像和代码活动仍统计全部实际活动；有原生复制依据的继承前缀排除重复统计。CLI 对应 `--branch current|all|<分支ID>`，消息 API 对应 `branch`。

执行轨迹保留全宽节点表格，选中节点后在下方阅读正文，列表与详情分别滚动。详情默认约占一半可用高度，可拖动分隔线调整，也可聚焦分隔线用上下键调整；比例保存在当前浏览器。“放大详情”使用整个中间工作区，支持切换本页上一／下一节点；“返回轨迹”或 Escape 恢复列表位置与焦点。工具配对节点可切换输入参数／返回结果，单正文不显示重复标签页，正文可切换预览／原始内容。

轨迹上方的三行时间线覆盖整段会话，可切换事件顺序、轮次和记录时间，也可收起以增加阅读空间；悬停查看节点信息，点击节点或用左右方向键定位到对应页。Codex 注入优先按客户端分类识别，旧日志再从完整包格式推断，并说明依据；上下文不进入对话视图，也不计为用户提问，过程搜索仍可检索。总览 API 为 `GET /api/v1/sessions/:id/timeline`，只返回同版本定位元信息。

请求用量趋势覆盖当前画像范围的全部已记录请求，显示从零开始的 Token 纵轴。鼠标悬浮查看请求编号、模型、时间和输入／缓存读取／输出数值；未记录与零值分开。Tab 聚焦图表后，可用左右方向键切换请求、Home／End 到首末请求、Enter／空格定位消息。明细表每页 12 条，可直接跳到首页或末页。

```sh
agent-manor sessions refresh --wait --json
agent-manor sessions refresh --client codeflicker --wait --json
agent-manor sessions refresh --client codex --mode full --wait --json
agent-manor sessions status --json
agent-manor sessions list --client codeflicker --page 1 --page-size 50 --json
agent-manor sessions list --include-subagents --json
agent-manor sessions search "状态检查" --json
agent-manor sessions search "如何处理连接超时和重试" --mode semantic --sort relevance --json
agent-manor sessions search "工具关键词" --kinds user,assistant,tool_call,tool_result --json
agent-manor sessions messages <sessionId> --mode brief --json
agent-manor sessions messages <sessionId> --mode trace --message-id <messageId> --json
agent-manor sessions profile <sessionId> --include-children --json
agent-manor sessions cacheclear --wait --json
```

会话刷新任务完成状态为 `complete`，与仓库任务的 `completed` 区分。首次启动会自动检查全部历史，无须先登记仓库；首次索引未完成可通过 `sessions status` 查看进度，或 `sessions refresh --wait` 等待。列表／搜索／消息和画像支持 `--version`，同一浏览流程沿用返回的完整版本。`--project none` 筛选无项目会话。

刷新默认采用快速检查。Web 顶部的“同步历史”在所有页面可用，始终检查全部客户端的新增或变化记录，页面筛选只影响浏览范围。日常界面仅保留这一个历史同步操作，不需要选择检查范围或方式。CLI 用 `sessions refresh --client <client>` 指定范围，`--mode full` 重新读取内容核对；不指定参数时检查全部客户端。内容核对适合排查普通更新后仍与原始历史不一致的情况，耗时可能更长；未变索引仍可复用，与 `sessions cacheclear` 的全局重建不同。

历史同步成功后，总览、会话库、用量统计和资源使用记录按当前页面重新读取完整结果，隐藏页面切回时更新；筛选、阅读位置和地图视野保留。各页自己的更新总览／刷新统计只重新读取报告；代码地图的刷新分析只更新当前仓库，资源刷新清单只执行本地盘点。语言、主题与项目 GitHub 链接位于全局页头右端。“自动同步”在各页顶栏直接显示，与“同步历史”同排，切换页面沿用同一设置，始终检查全部客户端。开启后由本地后台按周期检查全部历史，关闭所有网页仍继续，后台显式停止或系统睡眠期间不运行；本轮不增加系统登录自启。下一周期从成功的全局检查完成后计算，首次开启立即检查，重启复用已有启动检查，睡眠恢复到期只补一次，不积压每个错过的周期。关闭设置撤销未来周期和未提交补查，已提交任务正常收尾；局部检查不能替代全局范围。整项失败从完成时开始退避，等待不短于当前间隔且按 30 秒起逐次加倍、最多 10 分钟计算，手动可立即重试。网页只读观察状态，运行时约每 1.1 秒、空闲时约每 5 秒读取，隐藏时暂停观察，恢复可见立即读取；多页共享后端策略，不各自提交周期检查。页面报告仍在读取时合并更新通知，本次读取完成后接续最新版本，后台检查不等待页面。无变化自动检查仅更新同步状态；新版本发布后当前页面更新，隐藏页面切回时更新。代码地图自动刷新仍独立设置，只在地图页面可见时分析当前仓库；同步历史不自动重做仓库分析或本地资源盘点。同步按钮原位显示阶段或百分比及细进度条；旁边的状态弹层显示最近全局成功检查及下次检查或重试时间，运行时可查看实际任务客户端范围、处理数量与已用时间，失败时可重试。发现与发布阶段显示不确定进度，处理阶段按历史来源数量计算比例，不估算剩余时间。其他页面的更新时间与范围仍通过各自更新状态入口查看。

CLI 局部刷新保留其他客户端索引及检查时间，成功后仍发布完整全局结果。CLI 任务结果保留快速复用／内容复用／重新解析／缺失数及回退情况，各客户端成功检查记录独立保存。只有完整依赖已核验的格式才快速跳过，其他格式和缺少检查记录的来源退回内容检查；SQLite/WAL 与相关元信息不能只看主文件。快速检查不能严格排除保留相同变化指示的内容改写，需要核对正文时使用完整校验。

API 为 `GET /api/v1/sessions`、`/sessions/search`、`/sessions/:id/messages`、`/sessions/:id/profile`、`/sessions/status`，刷新用 `POST /sessions/refresh`（可选 JSON `{ "client": "codex", "mode": "full" }`；省略为全部快速检查），清除并重建用 `DELETE /sessions/cache`；会话任务沿用 `/jobs/:id` 查询。`GET /sessions/status?summary=true` 提供轻量状态及 `autoSync` 策略快照；旧 `POST /sessions/auto-refresh` 仅兼容返回可覆盖全局范围的在途任务，关闭策略或没有符合条件的任务时返回明确的 `job: null`、`status: "skipped"` 及原因，不再触发检查。默认消息每页 50 条，最多 200。查询参数为 `client/project/from/to/q/kinds/page/pageSize/version`；`kinds` 只限定列表匹配与搜索范围，不删减消息上下文；消息另有 `mode/messageId`，画像另有 `includeChildren=true`。

消息 API 可选择 `pageUnit=turn`，此时默认每页 10 轮，返回 `totalTurns`、当前页的 `turns` 元信息和完整消息；`total` 仍为当前视图消息数。`turnPosition` 为当前视图的一基轮次位置，`messageId` 定位优先于轮次位置。初始上下文 `position=0`，随第一页返回且不计入 `totalTurns`。`toolName` 或 `resourceKind/resourceName/resourceServer` 可以定位首条调用／资源证据，返回 `focusMessageId`；过程记录不属于简易模式，需要完整或轨迹模式。未指定 `pageUnit` 时沿用按消息分页，现有 CLI 查询保持原有行为。

浏览、统计及关键词搜索只使用本机索引，不调用模型。主动启用语义搜索后，正文构建和未缓存查询会发送到用户配置的模型服务；选择远端服务时相应文本会离开本机。CLI 通过 `sessions search --mode semantic` 复用 Web 配置和索引，支持 `--sort relevance|updated` 及现有项目／客户端／日期等筛选，默认排除已确认子 Agent，可用 `--include-subagents` 纳入。原始来源消失后新版排除，刷新失败继续显示上一完整版本。记录值、估算值与缺失的含义见 [会话统计口径](design/session-history.md)。

## 代码地图命令

地图页面集中展示覆盖率、文件活动与证据回查，不在页头展示来源诊断入口或缺口数量。维护诊断通过 CLI／API 查询；未证实归属当前仓库的来源不计入该仓库诊断，仍可使用来源查询和手动关联命令处理。原始历史缺失或无法唯一定位的范围保持未知，不补造为完整覆盖。

仓库管理提供`am repositories list`、`register <path>`和`remove <repositoryId>`；删除会改变登记及派生分析，按前文所述清理范围执行。下表保留兼容的顶层代码活动命令，回放和补充查询使用`repositories`子命令：

```sh
am repositories list --json
am repositories sessions <repositoryId> --version <analysisVersion> --json
am repositories gaps <repositoryId> --version <analysisVersion> --json
am repositories replay-sessions <repositoryId> --version <analysisVersion> --json
am repositories replay <repositoryId> --session-id <sessionId> --version <analysisVersion> --session-version <sessionVersion> --json
am repositories replay-evidence <repositoryId> --session-id <sessionId> --event-id <eventId> --version <analysisVersion> --session-version <sessionVersion> --json
```

`replay-sessions`返回可选会话及`sessionVersion`；选择后沿用仓库`version`、`sessionVersion`和`sessionId`读取回放及单条证据，不能用两种版本互相替代。`replay-evidence`的四个定位参数均必填。

| 命令 | 结果与常用选项 |
| --- | --- |
| `register <path>` | 登记 Git 仓库后刷新；`--wait` |
| `repositories` | 已登记仓库与最新版本 |
| `coverage <repositoryId>` | 范围内覆盖率与全部文件 |
| `hotspots <repositoryId>` | 热点；`--metric read\|edit\|activity`、`--limit N` |
| `unobserved <repositoryId>` | 未观察到成功读取的文件，不表示无用或安全可删 |
| `file <repositoryId> <path>` | 当前文件内容、范围和活动；路径相对仓库 |
| `events <repositoryId>` | 活动分页；`--path`、`--kind read\|edit\|search\|other`、`--page`、`--page-size`（最多 200） |
| `evidence <repositoryId> <eventId>` | 已索引来源中的原始物理记录与不可回查引用 |
| `sources <repositoryId>` | 已关联／待关联来源及采集缺口 |
| `associate <repositoryId> <sourceId>` | 手动关联已发现来源并刷新；`--wait` |
| `refresh <repositoryId>` | 主动刷新，返回任务；`--wait` |
| `jobs <jobId>` | 任务状态；`--wait` |
| `cacheclear <repositoryId>` | 清除派生缓存后重建，保留登记与手动关联；`--wait` |
| `status` | 实例、程序版本、仓库与任务 |
| `stop` | 显式停止；服务不存在时不会自动启动 |
| `web` | 打开本地页面；`--no-open` 只打印地址 |
| `serve` | 前台运行后台，便于诊断启动错误；`--port N` |

CLI默认返回轻量列表、统计与操作结果，人类格式显示表格或摘要；全局 `--json` 使用同一范围的稳定JSON。需要原完整响应时显式加 `--full`。普通摘要列表默认每页20条，画像明细使用 `sessions profile --section steps|context|reports|tools|resources`，价格目录使用 `usage pricing list`；完整字段模式仍分页，具体选项与正文续读见[CLI参数与返回值](#cli-参数与返回值)。

失败返回非零退出码；JSON模式的语法与API错误均通过stderr输出可解析的 `{error:{code,message}}`。刷新任务执行失败时 `--wait` 仍输出失败job并返回非零退出码；暂停命令等待到 `paused` 后成功退出。可先运行 `--help` 核对参数。等待默认120秒，可用 `--timeout <seconds>` 指定，最多3600秒。

覆盖、热点、未观察读取、文件、活动、证据和来源查询支持 `--version`、`--client <客户端ID>`、`--from`、`--to`、`--categories`、`--directory`。客户端 ID 包括 `codex`、`claude`、`codeflicker`、`codeflicker-desktop`、`dsh`、`pi`、`workbuddy`、`opencode`、`zcode`、`codebuddy`、`qoder`、`gemini`、`qwen`、`kimi`、`omp`、`grok`、`reasonix`、`codewhale`。最新可用值以对应命令的`--help`为准；新增来源的格式与原生运行验收边界见[历史支持矩阵](design/history-support.md)。省略客户端时查询全部客户端；CLI 帮助、API 校验与 Web 客户端选项共用客户端声明。时间须为 ISO 8601；起止边界均包含，默认全部可用历史。类别为逗号分隔的 `source,config,docs,unknown`，默认 `source`。来源清单描述该版本的采集来源，客户端筛选可缩小清单；时间／目录／类别筛选不改写来源级计数。热点和未观察读取响应的 `files` 已筛选，`summary` 保持所选范围的分母。

CodeFlicker CLI 使用 `--client codeflicker`，Web 中选择 CodeFlicker CLI，API 使用 `client=codeflicker`。例如 `agent-manor coverage <repositoryId> --client codeflicker --json`；后续文件、活动、证据查询沿用返回的 `version` 和相同筛选。历史范围为 `~/.codeflicker/projects` 中的主会话及能够确认关系的子会话；`requests/` 中的请求重放不作为独立活动来源。旧 IDE 的 SQLite 历史使用独立的桌面版身份。

CodeFlicker 桌面版接入新版 MyFlicker 桌面端，使用 `--client codeflicker-desktop` 或 API `client=codeflicker-desktop`。默认发现 `~/.myflicker/sessions/<会话ID>/message/cache.jsonl`；`MYFLICKER_HOME` 可替换客户端目录，AgentManor 的显式来源配置优先。代码地图与会话库共用这份主来源，不重复索引同会话的底层执行轨迹。`checkpoints/registry.json` 提供正式 cwd；本机 `MyFlicker/app.db` 的会话标题缓存只补充已发现会话的标题，不把未下载的服务端历史当成本机完整记录。模型只按明确消息 UUID 关联底层日志，未记录时保持缺失。刷新会检查标题、cwd 和模型旁路的变化，原始来源始终只读。

豆包工作目前暂不支持，`doubao-work` 不再是可用的 CLI／API 客户端参数，也不出现在页面选项中；原有目录覆盖配置不能重新启用导入。本机数据只有部分列表摘要和消息片段，无法稳定还原历史；来源发现、资源盘点与旧索引的停用范围见 [调查记录](design/doubao-work-sources.md)。

同一桌面版入口也默认发现 `~/.codeflicker/data/codeflicker/` 的旧桌面／IDE SQLite 历史：读取 `session_data.sqlite`、`composer_data.sqlite` 中已保存的会话，用同目录的 `index.sqlite` 补充标题。一个数据库里的多个会话独立索引，新库的同身份迁移副本优先。工作区缓存地址通过正式 `workspace.json` 关联项目，配置缺失时不将缓存目录当成仓库。读取返回支持 Tab／竖线编号，编辑仅按已接受的前后快照计算覆盖；只有参数、提案或没有确认终态时保留未知。主 UI 历史与 API 请求上下文副本不重复导入；逐请求 Token 历史及能够完整、唯一匹配原生请求的 API 用量按同一请求合并，来源冲突或无法唯一关联时保留缺口。缺失的用量仍显示未记录及内容估算，不把累计缓存转换成请求趋势。

活动与证据查询保留已删除文件的历史，按路径分类，覆盖分母仍只包含当前文件。目录搜索按当前或历史后代文件与所选类别的交集筛选，不把整个目录算作读取。没有具体文件路径的活动类别为 `unknown`，用 `--categories unknown` 或全部类别查看；目录筛选依据已核验的 cwd，不推断搜索命中或覆盖行。

Claude 头部发现仍限于 64 KiB／前 32 条记录，会在同一会话中继续补齐首个可靠 cwd；完整解析也补齐来源 cwd，并保留每条活动自己的 cwd。解析规则 3 会重建规则 2 的旧游标，以修正缺失的来源归属。

## 正确解释结果

Web 代码地图提供可搜索的会话筛选，支持按标题或原生会话 ID 切换，并可清除恢复全部会话。从会话库的“查看代码地图”或消息文件链接进入时自动选中当前会话。会话列表基于该仓库当前地图分析版本，新历史需刷新分析；尚未索引标题的来源显示原生 ID。

筛选只统计所选会话自身，子会话单独选择，已确认的分叉复制历史归原会话；没有匹配活动时显示零活动。当前文件与代码行分母不变，时间、类别和目录筛选继续有效。API 在已有地图查询中同时提供 `sessionClient` 与 `clientSessionId`；`GET /api/v1/repositories/:id/sessions?version=...` 返回该分析版本可选择的会话。文件、活动、证据与来源查询沿用同样的会话字段及 `version`。

代码地图顶部的“活动分布／活动回放”切换两种工作方式，仓库选择共享，其他筛选与观看位置独立。在“活动回放”选择一个会话，也可从会话库的“活动回放”快捷进入。所选会话及明确关联的子会话各占一轨；复制分叉历史沿用原归属，不将无关会话拼成轨道。会话自身没有文件活动、只有子会话活动时仍可选择。

回放包含该仓库已纳入分析的文本文件读取、修改和搜索。同次调用涉及多个文件时同时高亮，已有活动保留淡色痕迹。共享原始时间轴统一折叠所有轨道都没有文件活动的长空档，倍速作用于整段观看时间；最后一步的展示停留不代表真实工具耗时。播放／暂停、上一／下一活动、下一次修改及拖动进度可组合使用；预设倍速为 0.25× 至 128×，也可自定义 0.25× 至 256×。剩余时间是预计观看时长，不是Agent任务耗时。点击文件或活动自动暂停，右侧查看状态；原始证据按需读取，可返回所属会话消息。切换 Tab、离开页面、隐藏网页或到达终点均暂停。

默认地图只展示当前会话明确涉及的文件，可改为整个仓库或指定目录；观看范围不截断其他轨道和基线外证据。文件明细与模块概览独立切换，支持跟随当前模块、手动移动镜头及整个播放器全屏，时间轴高度可拖动调整。切换展示保留播放位置及固定版本，手动操作镜头会停止模块跟随。

缺少可靠时间的活动在所属轨道的“未定时活动”单独查看，不编造并行时间；无法确认顺序会明确标注。目录搜索显示范围，不能当作命中文件或读取成功。已删除、零行和基线外路径保留在活动证据中。地图始终是固定分析版本的文件布局，不逐步还原过去的文件内容。回放冻结仓库分析和会话索引两份版本；版本淘汰后需要显式更新回放。接口及边界见 [会话代码活动回放](design/session-code-replay.md)。

文件覆盖率用 `summary.readExact.files / summary.fileCount`，行覆盖率用 `summary.readExact.lines / summary.lineCount`；修改使用对应的 `editExact`。分母为零时显示无统计文件／行，不生成百分比。近似覆盖单列，不混入精确覆盖；行范围是一基闭区间 `{start,end}`。

`readCount`／`editCount` 是成功活动次数，未知当前范围仍可能有活动；`activityCount` 按事件身份去重。搜索、失败与未知列可能重叠，不能相加当总活动。`unobserved` 只表示当前观测窗口与采集覆盖下没有观察到成功读取。

`file.contentStale` 为 true 或 `content` 为 null 时，不使用旧范围解释当前代码；先 `refresh --wait` 再取得新版本。刷新失败保留上一完整版本并标过期。来源记录追加不使旧记录引用失效；改写、删除或移动后的旧路径可能不能回查，查看 `unavailable`。单条原始证据回读限额为 16 MiB。

格式兼容按证据结构判断，不保证所有客户端版本：直接工具、可识别 Shell 和明确的调用结果可提取；复杂脚本、未配对结果、重复位置、缺失或截断内容保持未知。客户端身份与历史格式分别保存；格式相同不表示客户端相同。详见 [历史支持矩阵](design/history-support.md)、[基线规则](design/baseline-rules.md) 与 [匹配规则](design/matching-rules.md)。

## 数据目录、后台与缓存

| 环境变量／选项 | 默认与用途 |
| --- | --- |
| `AGENT_MANOR_HOME` 或全局 `--home <path>` | `~/.agent-manor`；索引、知识、配置、偏好、管理记录、恢复材料及后台运行信息 |
| `AGENT_MANOR_CODEX_DIR` | 覆盖默认 `~/.codex/sessions` 和 `~/.codex/archived_sessions` |
| `AGENT_MANOR_CLAUDE_DIR` | 覆盖默认 `~/.claude/projects` |
| `AGENT_MANOR_CODEFLICKER_DIR` | CodeFlicker CLI 来源，覆盖默认 `~/.codeflicker/projects`；仍排除 `requests/` |
| `AGENT_MANOR_CODEFLICKER_DESKTOP_DIR` | CodeFlicker 桌面版来源目录，覆盖默认新版 JSONL 与旧 IDE SQLite 两个目录 |
| `AGENT_MANOR_CODEFLICKER_DESKTOP_DB` | 可选的桌面标题缓存 `app.db` 路径；自定义来源不会自动读取默认标题库 |
| `AGENT_MANOR_DSH_DIR` | DeepSeek Harness，默认 `~/.dsh/sessions`，只读 V3／V4 压缩事件流 |
| `AGENT_MANOR_PI_DIR` | Pi，默认 `~/.pi/agent/sessions`，保留事件树分支 |
| `AGENT_MANOR_WORKBUDDY_DIR` | WorkBuddy，默认 `~/.workbuddy/projects`；按原生身份补充邻近 SQLite 元信息 |
| `AGENT_MANOR_OPENCODE_DIR` | OpenCode，默认 `~/.local/share/opencode`，读取 `opencode.db` |
| `AGENT_MANOR_ZCODE_DIR` | ZCode，默认 `~/.zcode/cli/db`，读取 `db.sqlite` 并关联桌面任务索引 |
| `AGENT_MANOR_CODEBUDDY_DIR` | CodeBuddy，默认 `~/.codebuddy/projects` |
| `AGENT_MANOR_QODER_DIR` | Qoder，默认 `~/.qoder/projects` |
| `AGENT_MANOR_GEMINI_DIR` | Gemini CLI，默认 `~/.gemini/tmp` 中 chats；保留项目映射与 patch／rewind |
| `AGENT_MANOR_QWEN_DIR` | Qwen Code，默认 `~/.qwen/projects` 中 chats；保留归档及 sidechain |
| `AGENT_MANOR_KIMI_DIR` | Kimi Code CLI，默认 `~/.kimi-code/sessions` 中 Agent wire |
| `AGENT_MANOR_OMP_DIR` | Oh My Pi，默认 `~/.omp/agent/sessions`；原生 profile／XDG 规则另行解析 |
| `AGENT_MANOR_GROK_DIR` | Grok Build，默认 `~/.grok/sessions`，读取 updates 及必要旁路 |
| `AGENT_MANOR_REASONIX_DIR` | Reasonix，默认 state 中 sessions／projects／archive，保留事件旁路 |
| `AGENT_MANOR_CODEWHALE_DIR` | Codewhale，默认 `~/.codewhale/sessions`，读取 canonical JSON journal |
| `AGENT_MANOR_PORT` 或 `start/restart/serve --port N` | 默认从 `16666` 顺延尝试；显式指定时固定端口，冲突失败；`0` 由系统分配空闲端口。仅绑定 `127.0.0.1` |

历史目录环境变量须在后台启动前设置；已有后台使用它启动时的环境。需要切换时先显式 `stop`，再以新环境启动。隔离测试应使用独立 `AGENT_MANOR_HOME`，并把所有客户端的历史目录环境变量指向测试目录或空目录，防止连接日常后台或读取本机历史。

已有开发历史却全零时，先用 `sources <repositoryId> --json` 核对是否只接入了测试样本，再检查启动环境中的历史目录覆盖。使用默认目录后重启并刷新；仓库目录的文件清单正常不代表开发会话已经接入。已删除 worktree 的恢复需要会话中的成功创建与 Git 清单证据，支持边界见 [历史支持矩阵](design/history-support.md)。

```sh
agent-manor refresh <repositoryId> --wait --json
agent-manor cacheclear <repositoryId> --wait --json
agent-manor stop --json
```

清缓存不会删除原始历史，也不抹去仓库登记或手动关联；知识、偏好和资源恢复材料独立保留。分析缓存中包含所需历史源码片段，应按本机敏感数据保管；原始会话只读。服务没有开机启动或持续文件监听，关闭网页后继续运行；需要释放进程时显式停止。浏览、统计和关键词搜索不调用模型；显式启用的知识提炼、自动沉淀和语义索引／查询会按配置使用本地或远端模型，远端服务会接收相应输入。浏览器仅允许同服务 Origin，API 限制 Host 和写入类型，不提供任意绝对路径读取接口。

每个仓库保留最近两个成功发布的代码地图版本；查询已淘汰版本返回 `VERSION_NOT_FOUND`，不会改为返回当前版本。会话正文、工具参数与结果、思考、上下文和用量保持原有范围，消息元数据只保存一份，读取时组装完整对象。会话与地图仍保留各自需要的解析缓存。

SQLite 删除旧版本后可以复用空闲页，文件不一定立即缩小。服务仅在实际启动、正常读写开始前检查空间：空闲页至少 1 GiB、占主库页空间至少 20%，且距上次成功整理至少 24 小时才尝试整理；没有成功时间时只检查空间条件。运行期间不整理，空间不足或维护条件不安全时跳过并保留有效索引。新安装直接创建新结构，正常流程不生成 `.bak`；开发阶段不提供旧索引结构迁移。

未关联来源只缓存归属判断所需的身份、路径和关系证明，不长期保留工具返回正文。确认属于仓库、后补跨会话／历史 worktree 证明或手动关联后，会重新读取完整证据；来源内容变化也会重新解析。Worker 意外退出时，本轮及排队任务标失败，旧完整结果仍可查询；下一次主动刷新会重新创建 Worker，不自动循环重试失败任务。

## 将查询能力交给 Agent

先将配套Skill安装到所用客户端，命令须在PATH中可用：

```sh
am skills install --target codex --scope user
am skills install --target claude --scope user
am skills install --target codex --scope project --project-directory /workspace/example
am skills install --target custom --directory /workspace/example-skills
am skills status --target codex --scope user --json
```

按实际宿主选择一条安装命令即可。Skill引导Agent按场景读取reference：跨Agent恢复会话、检查工具结果、搜索知识、回查代码活动、分析用量或管理资源；同时说明参数类型、返回字段、分页、正文续读与失败处理。仅在用户明确要求记录或沉淀时写入知识，默认形成待审修订，查询不会自行积累知识或代替人工批准。

入口见[agent-manor Skill](../skills/agent-manor/SKILL.md)，reference与示例随目录完整安装。也可手动复制或引用整个`skills/agent-manor/`目录；不要只复制`SKILL.md`。npm安装本身不会自动改写宿主Skill／MCP配置。检查、更新、移除和覆盖保护见[服务与完整CLI](#服务与完整-cli)。

## 资源管理

顶部选择“资源管理”，页面标题旁切换 Skill／MCP。两类资源共用一份名称清单，合并历史使用与本地位置；不再切换使用总览／本地资源。桌面采用左侧筛选、中间列表／地图、右侧详情的可调宽三栏，小窗口通过筛选和详情面板操作。宽屏列表限制阅读宽度，较窄的中间栏依次隐藏最近使用和会话数，完整信息仍可在详情查看。

左侧常用筛选为本地状态、位置范围和使用时间。选择项目级位置后可搜索项目；“更多筛选”提供使用客户端、使用项目、低频和长期未用。位置范围／位置项目只筛当前文件或配置，不裁剪历史调用；使用客户端／使用项目和时间只限定历史范围，不把当前配置反推为曾经使用。默认全部已索引历史，本地存在、未发现、无法读取与历史使用／零次／未知分别表达；其他来源的适配缺口不改变此资源的本地状态。没有找到历史证据不能证明从未使用；缺少日期不推测闲置时间。

名称清单显示描述、本地位置、调用次数、使用会话数、最近使用和收藏。相同完整 Skill 或 MCP 服务器名称汇总一行，名称中的插件前缀保留；同名不证明属于同一文件、注册、地址或服务实例。Skill 次数包含显式调用与成功正文读取，会话数取并集；MCP 按工具请求计数。原始类型、项目分布、工具、结果和耗时可在详情“使用记录”中回查，并从证据跳回会话轨迹。请求 Token 不归因到资源。

右侧详情分“概览”“文件位置／配置位置”“使用记录”。概览提供关键统计、位置和最近证据；文件／配置位置按真实物理对象展开，具体位置提供已核验的动作。共享 Skill 文件只列一次，符号链接可单独展开；不同配置文件或键的 MCP 注册保持独立，同一位置的多适配器结果合并展示，不罗列兼容适配器推测的客户端。只有现有配置明确引用或控制该资源时，才提供对应配置操作，不因默认目录而创建客户端配置。预览在同一详情栏展示将改的文件、精确配置项、匹配规则、前后值或原位置到回收区的变化、控制规则的实际范围与简短恢复说明，确认按钮明确操作。注册内命令、地址与凭证不在页面展开。取消不写入；执行完成后可直接预览恢复。历史独有、只读或受保护的入口显示实际限制，不按汇总名称批量修改。

地图只绘制当前指标具有正值的资源，不再附加“其他资源”列表；零值与未知资源保留在统一清单。预览复用盘点并定向核验目标及依赖；执行前仍重新核验内容、引用和保护，写入完成后失效缓存，由下一次读取更新盘点。

左侧常驻“资源清单”“恢复中心”和“操作记录”，各视图独立保留筛选与浏览状态；返回资源清单保留选择与地图范围。“恢复中心”统一查看尚未撤销的配置停用、入口回收及注册移除等变更，可预览恢复或另行确认永久清除。标题右侧更多菜单提供“扫描详情与设置”；扫描设置按需读取，手动来源也在这里添加。默认目录缺失、已删除项目、待适配来源等采集边界不作为日常待办，实际不可读、格式或引用问题按位置归并展示。页面不检测客户端是否安装，也不由目录或配置存在推断客户端已加载。历史客户端筛选仅来自历史使用记录。

主列表提供全部／已使用／未发现使用与收藏筛选，计数对应当前历史条件、位置条件及搜索范围。低频按正使用会话数不超过阈值判断，默认 2；长期未用按最后一次已记录使用距今达到阈值判断，默认 90 天。新发现的本地资源没有使用记录，也立即进入未发现使用。收藏与受管理资源照常分类，管理动作仍受保护；表格支持升降排序和每页 20／50／100 条。名称收藏保留原来的本体收藏保护，位置详情可取消旧位置收藏，取消名称收藏不会暗中删除位置收藏。

Skill／MCP 总览可切换列表或地图，首次使用列表，随后保留视图选择。地图按当前完整筛选结果中的正值资源绘制，默认面积为调用次数，可切换使用会话数；面积保持线性比例。Skill 调用次数包括显式调用和成功正文读取，原始证据类型保留在详情。颜色表示任何已记录调用或成功读取的最近日期，与面积指标无关。零值与未知资源通过统一清单查看，零调用不表示从未使用。没有确认数值的资源保留未知状态，不显示为零；界面不再单列待检查。

地图支持滚轮缩放、拖动、全屏、适应窗口和定位所选；定位资源支持名称搜索，缩放只改变视野。悬停或键盘聚焦查看名称、数值、占比、最近使用和保护状态，点击打开详情及具体本地入口；全屏选择资源时退出全屏以展示详情。使用证据跳转返回同一范围时保留缩放与平移位置。地图的指标上限只筛选已知数值，切换指标清空上限，切回列表沿用列表范围；搜索与历史／位置／状态筛选同时作用于两种视图。数值口径和交互说明可通过地图帮助查看。

本地盘点只读取已核验来源、已知项目和手动路径，不执行 Skill、启动 MCP 或全盘扫描。支持范围见 [资源来源矩阵](design/resource-support.md)。每个入口显示自身可用动作；未经核验的来源与插件缓存只读。停用使用已核验原生设置，保留资源本体并保存配置恢复备份；回收是入口隔离或所选注册移除，不卸载服务。符号链接操作保留其共享目标。旧备用档案归入回收区，继续可以恢复或另行确认永久清除，旧 API 与 CLI 调用保持兼容。

```sh
agent-manor resources status --json
agent-manor resources overview --candidate unused --page 1 --page-size 50
agent-manor resources overview --kind mcp --client codex --page-size 50
agent-manor resources usage --kind skill --sort sessions --json
agent-manor resources usage --kind mcp --client codex --json
agent-manor resources local --json
agent-manor resources detail <historyResourceId> --json
agent-manor resources evidence <historyResourceId> --page 2 --json
agent-manor resources favorite <resourceId> --json
agent-manor resources source-add /workspace/skills --kind skill --client codex --json
agent-manor resources preview trash --entry-id <entryId> --json
agent-manor resources apply <previewId> --confirm --json
agent-manor resources archives --state trash --json
agent-manor resources preview restore --operation-id <operationId> --json
agent-manor resources operations --json
```

写入必须先审阅该资源的具体预览，再确认对应 `previewId`；预览有效期为 15 分钟，执行前核验来源、共享入口和恢复材料。恢复不会覆盖原位置或目标注册中的新内容；冲突须重新检查。永久清除另行生成和确认 `purge` 预览，不自动清空回收区。成功仅表示本地修改完成，客户端显示待重新加载，不自动重启或探活。

资源 API 位于 `/api/v1/resources`，与 Web／CLI 共用服务：`status`、`overview`、`overview/:id`、`map`、`usage`、`usage/:id`、`usage/:id/evidence`、`local`、`local/:id`、`archives`、`operations`，以及 `refresh`、`favorites`、`sources`、`preview`、`apply`。分页只影响返回明细；所有历史事件参与相应范围统计。管理记录按资源范围筛选，不把历史使用日期当成操作日期。

`GET /api/v1/resources/map` 返回同一已发布版本下的完整轻量节点，包括正值和紧凑区节点；废弃的 `review` 集合保留为空，`counts.review` 保留为零，旧 `candidate=review` 查询按全部处理；复用总览缓存，仅在地图视图按需查询。支持 `kind`、`client`、`from`、`to`、`q`、`candidate`，以及地图专属的 `metric=calls|sessions|reads|uses`、`maxValue` 非负整数；MCP 不支持读取指标。`uses` 合计 Skill 显式调用与成功正文读取，MCP 则为工具请求次数；Web 默认采用此调用次数，可切换使用会话数。既有 `calls`、`reads` 口径保持不变，列表也支持 `sort=uses`。列表页码和排序不限制地图，不为绘图重新索引原始历史，也不返回 MCP 注册正文。

管理状态保存于数据目录的 `resources.sqlite`，恢复材料位于 `resource-vault/`，独立于 `index.sqlite`；收藏、手动来源、记录与恢复材料不随历史清缓存删除。管理库及材料使用受限权限，可能包含恢复所需的私密配置；不要上传或加入发布包。清除回收材料不声称其他系统备份也已清除。

正常运行使用持久数据目录，默认 `~/.agent-manor/`；临时目录仅用于隔离测试。新恢复材料按下面的结构存放，Agent 与完整原路径由恢复记录保存。来源标识区分不同入口或注册，同一资源每次操作也分别保存，不覆盖同名资源。

```text
resource-vault/
├── backups/skill-or-mcp/name--source-id/operation-id/material
└── trash/skill-or-mcp/name--source-id/operation-id/material
```

需要从旧数据目录迁移时，在源码工作区构建后运行以下工具。先停止服务，目标目录必须不存在；工具保留索引、偏好和管理记录，核对数据库与恢复材料，更新材料位置并使旧预览失效。原目录继续保留，不自动清理；随后使用新 `--home` 启动，或迁到默认目录后省略该参数。

```sh
npm run build
node scripts/migrate-data-home.mjs /path/to/old-data /path/to/new-data
```

不要只复制管理数据库：恢复依赖对应材料及位置记录。回收区不是系统废纸篓，停用预览显示的是恢复备份位置，永久清除须单独确认。
