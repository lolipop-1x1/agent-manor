# CLI 全命令默认字段审计

审计基准：2026-10-19，Commander 注册的 126 条命令及根级默认动作。`repositories` 默认动作单独计数；帮助与版本快捷参数不重复计数。

本表记录源码调用链和默认字段用途，不表示每条命令都在真实用户环境执行。修改项由合成回归、HTTP 与包外命令验证；管理测试使用隔离数据，模型测试使用本地桩服务。

共 126 项：保留 73 项，显式读取 35 项，已优化 18 项。已优化表示本轮发现并调整；保留表示现有摘要符合场景；显式读取表示内容本身就是用户请求的结果。

| 命令 | 场景 | 结论 | 默认字段边界与回读方式 |
| --- | --- | --- | --- |
| `am sessions status` | 状态查询 | 保留 | 索引版本、会话/来源计数、同步状态与必要错误；诊断另读 gaps。 |
| `am sessions list` | 查找会话 | 保留 | 核心身份与标题、客户端、项目、更新时间；分页固定版本。 |
| `am sessions search` | 查找会话 | 保留 | 核心会话与命中片段/消息定位；原始快照不进入结果。 |
| `am sessions messages` | 对话读取 | 显式读取 | 用户明确读取消息/过程；正文有界并提供原文续读。 |
| `am sessions profile` | 画像读取 | 保留 | 默认汇总；步骤、上下文及用量报告通过 section 分页。 |
| `am sessions refresh` | 同步 | 保留 | 任务身份、状态和错误，wait 核对最终结果。 |
| `am sessions cacheclear` | 重建索引 | 保留 | 任务身份、状态和错误；不重复历史数据。 |
| `am sessions facets` | 读取筛选项 | 显式读取 | 选项名称就是结果，不把名称改成计数。 |
| `am sessions gaps` | 读取诊断 | 显式读取 | 分页读取缺口，保留来源、版本和原始诊断。 |
| `am sessions groups` | 查找会话 | 保留 | 每组只返回一份核心会话，命中保持消息定位。 |
| `am sessions turns` | 定位轮次 | 已优化 | 每页20条，问题预览240字符并标记截短；messages 按轮次回读。 |
| `am sessions matches` | 定位消息 | 保留 | 只返回实际命中位置与版本。 |
| `am sessions timeline` | 浏览过程 | 已优化 | 默认最多200个时间线表示项；保留 total、聚合范围、真实消息定位与时间缺失。 |
| `am sessions cost` | 费用查询 | 保留 | 版本、价格版本、统计范围、未知值及费用依据。 |
| `am sessions locate` | 原生身份定位 | 保留 | 规范会话/消息目标；不返回整份历史。 |
| `am sessions auto-refresh` | 按策略同步 | 保留 | 任务或关闭策略的跳过结果，不扩展范围。 |
| `am sessions export` | 完整导出 | 显式读取 | 明确导出全部对话；output 写文件并返回文件摘要。 |
| `am resources status` | 来源状态 | 保留 | 计数与观察时间；full 读取来源、能力及诊断。 |
| `am resources refresh` | 盘点刷新 | 保留 | 计数与观察时间，不重复完整资源目录。 |
| `am resources overview` | 查找资源 | 保留 | 核心资源与使用统计、观察/保护状态、分页。 |
| `am resources usage` | 查找历史资源 | 保留 | 核心身份与使用统计、版本和分页。 |
| `am resources local` | 查找本地资源 | 保留 | 本体身份与入口数量；detail local 取得真实入口及权限。 |
| `am resources detail` | 资源详情 | 已优化 | 明确详情保留趋势、分布、入口与权限；去掉全局收藏回显，盘点缺口限相关来源。 |
| `am resources evidence` | 读取证据 | 显式读取 | 按页读取实际调用证据与原生来源，不含参数/结果正文。 |
| `am resources favorite` | 收藏变更 | 保留 | 目标身份、收藏状态与总数。 |
| `am resources archives` | 恢复记录 | 保留 | 分页身份、恢复状态和目标；不返回内部归档存储路径。 |
| `am resources operations` | 操作记录 | 保留 | 分页操作身份、状态、关键消息与定位；full 读全部字段。 |
| `am resources source-add` | 登记来源 | 保留 | 实际变更来源与计数，不重复整份盘点。 |
| `am resources source-remove` | 移除来源 | 保留 | 被移除身份、结果和计数。 |
| `am resources preview` | 管理授权预览 | 显式读取 | 保留路径、前后值、受影响入口、保护原因、确认要求及有效期。 |
| `am resources apply` | 执行管理 | 已优化 | 保留结果及部分失败诊断、受影响入口与链接状态，避免摘要遗漏实际影响。 |
| `am resources map` | 查询地图指标 | 已优化 | 保留全部节点、所选 value/share、未知/保护/观测状态；省略别名收藏数组和其他指标副本。 |
| `am register` | 登记仓库 | 保留 | 仓库身份及最终任务状态。 |
| `am repositories` | 查找仓库 | 保留 | 根默认动作与 list 相同，只返回核心身份、路径、版本和新鲜度。 |
| `am repositories list` | 查找仓库 | 保留 | 核心身份、路径、版本和新鲜度。 |
| `am repositories register` | 登记仓库 | 保留 | 仓库身份及最终任务状态。 |
| `am repositories remove` | 移除登记 | 保留 | 被移除仓库身份，原始文件只读。 |
| `am repositories sessions` | 查找仓库会话 | 保留 | 规范身份、标题、计数与版本，不重复原始会话。 |
| `am repositories gaps` | 读取仓库诊断 | 显式读取 | 同版缺口正文是该命令的结果。 |
| `am repositories replay-sessions` | 选择回放会话 | 保留 | 规范身份、标题、关系、计数与双版本。 |
| `am repositories replay` | 读取回放 | 已优化 | 保留轨迹、步骤、顺序依据及双版本；只移除 repository.commonDir。 |
| `am repositories replay-evidence` | 读取回放证据 | 显式读取 | 明确事件/会话和双版本；保留原始证据与来源定位。 |
| `am repositories auto-refresh` | 按策略刷新 | 保留 | 实际任务或策略关闭的跳过结果。 |
| `am coverage` | 覆盖查询 | 已优化 | 保留完整基线分母和行区间；省略 commonDir、逐文件 hash 与缺口正文；gaps 同版回读。 |
| `am unobserved` | 未观察范围 | 已优化 | 保留实际文件、行数与范围；省略内部目录、逐文件 hash 与缺口正文。 |
| `am sources` | 读取历史来源 | 显式读取 | 来源选择键、哈希与原生位置是核验及关联所需证据。 |
| `am hotspots` | 热点排行 | 已优化 | 保留请求指标、排行与范围；省略内部目录、逐文件 hash 与缺口正文。 |
| `am file` | 读取文件 | 已优化 | 保留源码、哈希/过期状态和行区间；嵌入 events 仅返回摘要，evidence 同版读取调用正文。 |
| `am events` | 查找活动 | 已优化 | 默认20条活动元数据；原始 input/output/fragments 与来源明细通过 evidence 读取。 |
| `am evidence` | 读取活动证据 | 显式读取 | 保留单事件、原始 records、不可用来源和固定版本。 |
| `am associate` | 确认来源归属 | 保留 | 操作/任务身份及实际状态，来源读取不裁剪。 |
| `am refresh` | 刷新仓库 | 保留 | 任务身份及最终成功/失败。 |
| `am cacheclear` | 重建仓库缓存 | 保留 | 任务身份及最终成功/失败。 |
| `am jobs` | 跟踪任务 | 保留 | 有界任务进度、阶段、错误与版本。 |
| `am overview snapshot` | 总览快照 | 保留 | 仅版本、价格版本、时区、范围和查询；不包含整页 dashboard。 |
| `am overview panel` | 单面板查询 | 显式读取 | 只读取明确选择的面板；面板统计、缺失/覆盖语义保留。 |
| `am overview review` | 近期复盘 | 显式读取 | 有上限的重点记录、排行和统计依据。 |
| `am overview review-detail` | 复盘明细 | 显式读取 | 指定明细分页，保留版本和证据。 |
| `am overview detail` | 总览明细 | 显式读取 | 指定范围的分页下钻结果。 |
| `am overview report` | 完整总览报告 | 显式读取 | 该入口明确请求整份报告；窄读使用 snapshot + panel。 |
| `am overview evidence` | 总览来源核对 | 显式读取 | 选定统计的来源和完整性依据。 |
| `am usage report` | 用量统计 | 已优化 | 保留趋势 buckets、分组、总数和分页会话摘要；移除重复 days 与筛选候选 facets。 |
| `am usage status` | 准备状态 | 保留 | 版本、阶段和已处理/总会话数。 |
| `am usage requests` | 请求明细 | 显式读取 | 用户指定会话后分页读取请求、计价与证据；不机械移除请求字段。 |
| `am usage pricing get` | 配置读取 | 显式读取 | 完整可编辑映射和覆盖配置；价格明细通过 list 分页。 |
| `am usage pricing list` | 价格明细 | 显式读取 | 模型、来源、版本、费率及分页。 |
| `am usage pricing refresh` | 刷新目录 | 已优化 | 版本、状态、时间、错误和条目计数；配置由 get 读取。 |
| `am usage pricing set` | 配置保存 | 显式读取 | 核对整份有效价格配置；不返回整份模型价格目录。 |
| `am knowledge list` | 查找知识 | 保留 | 核心条目/修订、标题、分类、状态与分页；正文按身份读取。 |
| `am knowledge search` | 查找知识 | 保留 | 核心条目/修订、标题、分类、状态与分页；正文按身份读取。 |
| `am knowledge facets` | 读取筛选项 | 显式读取 | 项目、客户端与标签名称就是结果。 |
| `am knowledge get` | 知识正文读取 | 显式读取 | 指定正文、适用条件、状态与紧凑来源锚点；完整摘录用 full。 |
| `am knowledge write` | 提交知识 | 保留 | 条目/修订身份、版本与待审状态；正文可按返回身份读取。 |
| `am knowledge revise` | 提交知识 | 保留 | 条目/修订身份、版本与待审状态；正文可按返回身份读取。 |
| `am knowledge restore` | 提交知识 | 保留 | 条目/修订身份、版本与待审状态；正文可按返回身份读取。 |
| `am knowledge revisions` | 知识历史目录 | 保留 | 修订身份、版本、标题、状态及变更信息；逐版读取正文。 |
| `am knowledge revision` | 知识正文读取 | 显式读取 | 指定正文、适用条件、状态与紧凑来源锚点；完整摘录用 full。 |
| `am knowledge review` | 人工确认管理 | 显式读取 | 授权前保留完整具体版本；授权绑定精确路径；成功结果只回传身份/状态。 |
| `am knowledge availability` | 人工确认管理 | 显式读取 | 授权前保留完整具体版本；授权绑定精确路径；成功结果只回传身份/状态。 |
| `am knowledge settings get` | 读取模型配置 | 显式读取 | 保留可精确编辑的配置，包含提示词/范围；凭据只返回已配置标记。 |
| `am knowledge settings defaults` | 读取默认配置 | 显式读取 | 完整默认配置用于生成可编辑输入，固定提示词保留。 |
| `am knowledge settings set` | 保存模型配置 | 保留 | 保存结果、指纹及凭据已配置标记，不回显配置和密钥。 |
| `am knowledge settings test` | 模型连接测试 | 保留 | 连接成功/失败；测试调用需用户已授权。 |
| `am knowledge settings try` | 试提炼 | 显式读取 | 候选正文、判定、限制和用量就是试运行结果。 |
| `am knowledge settings key` | 明确查看凭据 | 显式读取 | 仅在该次管理授权后读取；普通诊断不调用。 |
| `am knowledge extraction preview` | 抽取范围预览 | 已优化 | 整体估算与完整目标数、最多20个目标摘要；full 读取全部 manifest 后确认执行范围。 |
| `am knowledge extraction preview-get` | 抽取范围预览 | 已优化 | 整体估算与完整目标数、最多20个目标摘要；full 读取全部 manifest 后确认执行范围。 |
| `am knowledge extraction start` | 跟踪/控制抽取 | 保留 | 分页历史、任务进度/错误/用量及结果计数；完整事件和结果由 full 读取。 |
| `am knowledge extraction list` | 跟踪/控制抽取 | 保留 | 分页历史、任务进度/错误/用量及结果计数；完整事件和结果由 full 读取。 |
| `am knowledge extraction get` | 跟踪/控制抽取 | 保留 | 分页历史、任务进度/错误/用量及结果计数；完整事件和结果由 full 读取。 |
| `am knowledge extraction pause` | 跟踪/控制抽取 | 保留 | 分页历史、任务进度/错误/用量及结果计数；完整事件和结果由 full 读取。 |
| `am knowledge extraction resume` | 跟踪/控制抽取 | 保留 | 分页历史、任务进度/错误/用量及结果计数；完整事件和结果由 full 读取。 |
| `am knowledge extraction retry` | 跟踪/控制抽取 | 保留 | 分页历史、任务进度/错误/用量及结果计数；完整事件和结果由 full 读取。 |
| `am knowledge index status` | 知识索引任务 | 保留 | 索引状态、范围计数、估算、指纹、进度和错误有实际用途。 |
| `am knowledge index preview` | 知识索引任务 | 保留 | 索引状态、范围计数、估算、指纹、进度和错误有实际用途。 |
| `am knowledge index build` | 知识索引任务 | 保留 | 索引状态、范围计数、估算、指纹、进度和错误有实际用途。 |
| `am knowledge index pause` | 知识索引任务 | 保留 | 索引状态、范围计数、估算、指纹、进度和错误有实际用途。 |
| `am knowledge index resume` | 知识索引任务 | 保留 | 索引状态、范围计数、估算、指纹、进度和错误有实际用途。 |
| `am semantic facets` | 读取筛选项 | 显式读取 | 可用项目、模型和客户端名称就是结果。 |
| `am semantic status` | 语义索引任务 | 保留 | 状态、范围计数、预览指纹、进度/错误及用量有实际用途。 |
| `am semantic settings get` | 读取模型配置 | 显式读取 | 保留可精确编辑的配置，包含提示词/范围；凭据只返回已配置标记。 |
| `am semantic settings set` | 保存模型配置 | 保留 | 保存结果、指纹及凭据已配置标记，不回显配置和密钥。 |
| `am semantic settings key` | 明确查看凭据 | 显式读取 | 仅在该次管理授权后读取；普通诊断不调用。 |
| `am semantic test` | 语义索引任务 | 保留 | 状态、范围计数、预览指纹、进度/错误及用量有实际用途。 |
| `am semantic preview` | 语义索引任务 | 保留 | 状态、范围计数、预览指纹、进度/错误及用量有实际用途。 |
| `am semantic search` | 语义查找会话 | 保留 | 默认20条核心会话和有界命中片段；不包含原始会话快照。 |
| `am semantic build` | 语义索引任务 | 保留 | 状态、范围计数、预览指纹、进度/错误及用量有实际用途。 |
| `am semantic pause` | 语义索引任务 | 保留 | 状态、范围计数、预览指纹、进度/错误及用量有实际用途。 |
| `am semantic resume` | 语义索引任务 | 保留 | 状态、范围计数、预览指纹、进度/错误及用量有实际用途。 |
| `am preferences get` | 读取偏好 | 显式读取 | 语言、主题和刷新偏好都是可编辑配置。 |
| `am preferences set` | 局部偏好写入 | 已优化 | saved 与本次变更字段的有效值；appearance 保留合并后的有效对象。 |
| `am start` | 启动服务 | 保留 | 实际实例、地址、版本和日志路径。 |
| `am restart` | 重启服务 | 保留 | 实际实例、地址、版本和日志路径。 |
| `am serve` | 前台服务 | 保留 | 实例身份与实际地址。 |
| `am status` | 综合状态 | 保留 | 一份状态摘要及必要计数、准备结果、任务定位和错误。 |
| `am stop` | 停止服务 | 已优化 | 返回 stopped 及实际实例；已完成停止不再声称 stopping。 |
| `am ready` | 等待准备 | 已优化 | 实例/协议、准备阶段、完成时间和错误；不重复会话/仓库计数。 |
| `am version` | 版本查询 | 保留 | 产品、API、Node 及平台版本信息。 |
| `am update` | 更新产品 | 保留 | 检查/安装结果、版本、安装位置和回滚定位。 |
| `am update status` | 读取安装级缓存，不联网不启动后台；返回版本关系、兼容性和设置 | — | — |
| `am update settings get` | 读取安装级自动检查和忽略版本设置 | — | — |
| `am update settings set` | 修改 autoCheck/ignoredVersion 并返回合并后设置 | — | — |
| `am doctor` | 诊断 | 显式读取 | 环境、安装与服务诊断；不作为普通查找命令裁剪。 |
| `am logs` | 日志读取 | 显式读取 | 有界日志或增量 follow 文本，保留日志路径和轮换提示。 |
| `am web` | 打开页面 | 保留 | 实例与实际地址。 |
| `am skills install` | Skill 管理 | 保留 | 状态、目标路径、版本、冲突和备份定位是修改保护所需结果。 |
| `am skills status` | Skill 管理 | 保留 | 状态、目标路径、版本、冲突和备份定位是修改保护所需结果。 |
| `am skills update` | Skill 管理 | 保留 | 状态、目标路径、版本、冲突和备份定位是修改保护所需结果。 |
| `am skills remove` | Skill 管理 | 保留 | 状态、目标路径、版本、冲突和备份定位是修改保护所需结果。 |

## 验证边界

- 默认 JSON 与人类输出采用同一投影；`--full` 保留原接口的完整字段及显式分页。例外是修正错误表述后的 stop，不再返回误导性的 stopping。
- 估算、未知值、原始错误和授权材料保留；覆盖范围与统计分母不随展示精简改变。
- 抽取预览的目标展示上限不改变执行范围：sessionCount/targetCount 和所有预算始终针对完整预览；targetsTruncated 表示必须显式查看其余目标。
- 时间线使用已有聚合机制，maxEvents 控制表示项数量，total 仍表示原始消息总数；聚合项不是全部原始步骤。
- 源码、会话正文、证据、日志、完整配置及明确的报告可能仍较大；这类入口用过滤、分页或导出文件控制范围。
