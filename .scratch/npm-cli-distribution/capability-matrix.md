# Web、API 与 CLI 功能覆盖清单

Type: research
Status: resolved

基于当前源码注册和页面调用进行静态核对，未执行真实业务请求。所有路径省略公共前缀 /api/v1。表中“缺”表示目前 CLI 缺少对应业务入口，不表示服务端未实现；最终命令名及参数由实施清单固定。

| 领域与操作 | 现有 API | 现有 CLI | 交付要求 |
|---|---|---|---|
| 总览、分区及下钻 | GET /overview/snapshot、panel、review、review/detail、detail、report、evidence | 缺 | 提供范围、面板、明细和来源读取，保持同一快照版本 |
| 会话列表及搜索 | GET /sessions、/sessions/facets、/sessions/search、/sessions/search/groups | 已有 list/search，缺分组及筛选项入口 | 筛选、分页、分组和语义结果可完整查询 |
| 消息、轮次及定位 | GET /sessions/:id/messages、turns、matches、timeline；GET /sessions/locate | 已有 messages，其他缺 | 可按消息、轮次、分支和版本读取连续上下文与执行轨迹 |
| 会话画像及费用 | GET /sessions/:id/profile、cost | 已有 profile，缺 cost | 读取原生统计和估算费用，保留覆盖边界 |
| 会话更新 | GET /sessions/status；POST /sessions/refresh；DELETE /sessions/cache | 已有 status/refresh/cacheclear | 保留现有行为，补统一任务等待与输出 |
| 会话导出 | Web 当前从消息 API 读取后生成 Markdown，无独立导出接口 | 缺 | 复用消息 API 和共享导出规则，必要时补接口，避免维护两种不同正文语义 |
| 会话语义查询 | POST /semantic/search，现有会话搜索适配 | 已支持 search --mode semantic | 继续共用语义配置、范围、缓存、预算和索引 |
| 语义设置和索引管理 | GET /semantic/settings、key、facets、status；PUT /semantic/settings；POST /semantic/test、preview、build、action | 缺 | 配置、Key、测试、预览、构建和暂停恢复可操作，凭据查看走明确管理流程 |
| 知识查询与直接写入 | GET /knowledge/entries、facets、entries/:id；POST /knowledge/search、entries、entries/:id/revisions | 缺 | 搜索、正文、范围、标签、stdin/文件及幂等提交；默认待审 |
| 知识修订和来源 | GET /knowledge/entries/:id/revisions、revisions/:revisionId；POST /knowledge/entries/:id/restore | 缺 | 读取历史及其来源，恢复形成新待审修订，不能覆盖历史 |
| 知识人工管理 | POST /knowledge/entries/:id/reviews、availability | 缺，现有 CLI 请求形式会被管理校验拒绝 | 为具体修订设计用户核对与明确确认入口，不伪造同源浏览器请求 |
| 知识模型、语言与提示词 | GET /knowledge/settings/defaults、settings；POST /knowledge/settings/key、test、prompts/try；PUT /knowledge/settings | 缺 | 连接、预算、语言、提示词及试抽取可操作，默认配置输出脱敏 |
| 沉淀任务与历史 | POST /knowledge/extractions/preview、extractions；GET /knowledge/extractions/previews/:id、extractions、extractions/:id；POST /knowledge/extractions/:id/pause、resume、retry | 缺 | 预览、显式启动、任务历史、过程、用量、结果和控制均可查询或执行 |
| 知识语义索引 | GET /knowledge/index/status；POST /knowledge/index/preview、build、pause、resume | 缺 | 预览与明确构建、维护范围、覆盖和任务状态保持一致 |
| 仓库生命周期 | GET/POST /repositories；DELETE /repositories/:id；关联、刷新、缓存及自动刷新相关路由 | 已有登记、列表、关联、刷新和缓存；缺删除登记及部分策略入口 | 删除登记保留 Git 与全局会话；预览、任务和独立生命周期一致 |
| 代码活动查询 | GET /repositories/:id/sessions、coverage、coverage/gaps、unobserved、sources、hotspots、file、events、evidence/:eventId | 大部分已有，缺 gaps 和部分会话入口 | 覆盖、缺口、事件及原始证据保持版本和过滤条件 |
| 活动回放数据 | GET /repositories/:id/replay/sessions、replay、replay/evidence/:eventId | 缺 | 提供会话、轨迹和证据数据，不复刻地图绘制或播放器交互 |
| 用量、价格及请求明细 | GET /usage、/usage/status、/usage/requests、/usage/pricing；POST /usage/pricing/refresh；PUT /usage/pricing | 缺独立命令组，resources usage 不是模型用量 | 报告、请求、价格、映射与准备状态均覆盖，保留估算和未知 |
| 资源查询与地图 | GET /resources/status、overview、map、overview/:id、usage、usage/:id、usage/:id/evidence、local、local/:id | 大部分已有，缺 map | 补齐底层数据查询；资源名称与具体管理入口分别表达 |
| 资源管理与恢复 | GET /resources/archives、operations；POST /resources/refresh、favorites、sources、preview、apply；DELETE /resources/sources/:id | 大部分已有 | 保留预览、确认、恢复、冲突与操作记录，补统一输入输出 |
| 共享偏好与自动策略 | GET/PUT /preferences；POST /sessions/auto-refresh；仓库自动刷新路由 | 缺持久偏好及策略入口；已有单次语言覆盖 | 语言、外观、全局历史与地图策略分别处理，读取状态不安排新同步 |
| 服务及全局任务 | GET /status；POST /stop；GET /jobs/:id | 已有 status/stop/jobs | status 改为不启动服务，补 start/restart/logs、版本握手和启动准备状态 |
| Skill 与自身更新 | 目前没有安装及更新管理 API，属于本机程序交付职责 | 缺 | CLI 直接管理已核验的安装目标、模板副本、程序安装与版本，不为这些操作强行增加 HTTP API |

## 管理与实现边界

- 知识 reviews、availability 和 settings/key 目前只接受明确的管理页面请求。完整 CLI 必须建立自身管理确认路径，不能通过仿造浏览器请求头实现。
- 会话语义与知识的 Key 查看约束目前不同。新 CLI 普通输出统一脱敏，明确查看凭据使用管理入口，不能把约束较少的接口当作绕过另一领域规则的通道。
- GET /usage/pricing 当前读取可能触发后台价格刷新；CLI 对应入口需如实说明联网更新行为。状态、版本和只读诊断不为取得价格而走这条路径。
- 生命周期、Skill 复制和软件安装是本机职责；业务查询、写入和任务控制复用后台 API。纯图形渲染、拖拽及播放帧不建立形式化的一对一命令，底层数据和可保存偏好仍须覆盖。
- 原始历史只读；知识、偏好、管理状态和恢复材料独立于可重建索引。表格只标识功能缺口，不把 API 存在当作 CLI 或平台验收通过。

## 核对入口

- CLI 注册：src/cli.ts；通用请求与实例：src/service/runtime.ts。
- 主路由与状态：src/server.ts；总览：src/service/overview-routes.ts。
- 语义、知识、用量：src/service/semantic-routes.ts、knowledge-routes.ts、usage-routes.ts。
- 代码地图与回放：src/service/map-query-routes.ts、replay-routes.ts。
- 资源与偏好：src/service/resource-routes.ts、preferences.ts。
- 页面总览调用：web/features/overview/loading.ts；会话导出通过页面读取消息后生成。
