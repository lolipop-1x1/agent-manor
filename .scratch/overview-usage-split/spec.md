# 总览用量按需查询

状态：已实现并验收；评审基点 `b9e0501`，结果见[验收记录](validation.md)。只拆用量的读取、计算和缓存，不删计时、资源或洞察功能，不改变统计口径。

## 用户结果

- 默认用量只返回趋势和组成所需的轻量统计，不构建完整会话报告、不恢复预览，不返回未显示维度的分布。Token、费用和请求数共用日期桶，显示指标与日／周／月切换不另算报告。
- 使用分布只查询当前选中维度，默认项目；切到客户端／模型时只请求该维度，按快照与维度复用缓存。工具沿用过程数据。完整排行只计算当前维度并服务端分页，不准备其他两个维度。
- 基础主子信息仍显示；详细主子请求／Token 分摊只在打开委派调查时计算。
- 筛选候选项独立读取或缓存，不能为了候选触发完整用量报告。模型身份编码和未知语义保持。
- 首次分区独立显示；全局筛选和刷新继续保留旧完整结果，固定进度、暂停旧下钻，同一快照的当前必需区域成功后替换。局部分布切换保持原布局，避免迟到响应覆盖新选择；错误可重试。
- 原始数据只读。缺失、覆盖、小计、费用精度、父子／复制排除、版本／日期／模型范围与证据不变。公开 report 和独立用量页继续兼容。

## 接口约定

- 用量模块增加 `UsageStatistics`，为 UsageReport 的 version、priceVersion、timezone、query、totals、undated、days、groups、facets 投影；没有 sessions、预览、pricing、buckets。`UsageStatisticsView` 为 totals、trend、distribution。`UsageManager.statistics(query, view)` 使用真正的轻量聚合；不要先构建完整报告再截断。trend 的日期桶 groups 为空；distribution 只生成 query.groupBy 指定维度；totals 不生成日期或分布。共享聚合语义和准备好的修订汇总。
- 总览既有六个默认分区保留；usage 分区只返回轻量 usage。新增按需 panel：distribution（额外 dimension=client|project|model）、delegation、facets。OverviewManager.panel(query, panel, dimension?)，distribution 的维度进入缓存身份，响应携带 dimension。
- OverviewPanelResult.data 使用独立的页面数据类型：usage 为 UsageStatistics，支持 delegationSummary（OverviewDelegation 的五个基础身份计数）；完整 OverviewReport 不改。core 输出轻量 delegationSummary，保留主页的 withChildActivity。delegation 分区输出完整用量分摊；打开委派证据调查时读取，并与证据一起绑定快照。
- 前端当前所需分区包含基础六项、facets 和当前非工具 distribution；维度切换只补 distribution。详细委派不进入默认批次。所有响应与同一 OverviewSnapshot 相符；新增 shape 更新结果缓存格式。
- 用量趋势、当前分布与筛选项使用独立的轻量执行通道，避免排在过程统计后面；冷事实准备仍保持单个写入通道。加载中改选维度立即查询当前所需结果，废弃维度不阻塞批次完成。
- 核心与洞察可复用 totals／distribution 轻量统计以避免旧 UsageReport 构建，但洞察规则及比较区间保持原约定，不增加功能。

## 验收

1. 自动测试能证明只查询所选维度、默认不计算详细委派、轻量路径没有完整报告／预览构建；完整排行不再计算三维。
2. 相同真实快照下，轻量总量、日期、组成、分布排行及委派与原结果等价，费用误差不超过 `1e-6`；覆盖与未知保持。
3. 请求次数、响应大小、首次未命中和缓存耗时分开记录，主页面不会因切换分布维度重新请求六分区。
4. 真实内置浏览器验证指标／粒度、维度切换与竞态、模型与全局筛选、排行分页、委派、原会话返回、主题语言与窄屏。
5. 类型、国际化、相关及完整测试、公开内容检查、独立两轴评审通过；真实证据留本机忽略目录。保留现有字体、布局和共享控件，不加解释小字。

## 任务图

| 任务 | 依赖 | 所有权 |
| --- | --- | --- |
| [01 轻量聚合](issues/01-statistics.md) | 无 | src/usage/ 与对应用量测试 |
| [02 总览服务](issues/02-service.md) | 01 接口可先并行 | src/overview/、overview 服务接入及测试、共享类型 |
| [03 页面](issues/03-web.md) | 02 合约可先并行 | web/features/overview/、双语目录及对应 Web 测试 |
| [04 整合验收](issues/04-validation.md) | 01、02、03 | 主任务：整合、真实数据、评审、文档与交付 |
