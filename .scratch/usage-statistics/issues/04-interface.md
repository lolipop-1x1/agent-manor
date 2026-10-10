# 用量页面、筛选图表与价格管理

Type: task
Status: resolved
Blocked by: 02, 03

## 所有权与范围

`web/features/usage/`、必要的共享多选控件、`web/app/App.tsx` 导航集成、`src/i18n/locales/en.ts` 与 `zh-CN.ts`（以实际目录为准）、必要 Web 测试。不能修改价格/聚合/服务器。复用 `web/shared/api.ts` request；公共类型 `src/usage-contracts.ts`。

## 工作

依据 [规格](../spec.md) 实现完整视觉与交互；参照 PRODUCT.md、DESIGN.md、AGENTS.md、i18n 规范，复用 Radix、cmdk、DatePicker、HelpPopover、ResourcePagination。默认近 30 天，全部筛选与多选/排除/搜索、指标切换、粒度/分组、趋势、组成、横条排行、热力图、可排序明细及请求下钻；任意模型价格和映射编辑、恢复自动价、更新来源状态。

## API

`GET /api/v1/usage` query 使用 UsageQuery，数组为 JSON 编码字符串，返回 UsageReport；`GET /usage/pricing` 返回 PricingStatus；`POST /usage/pricing/refresh` body `{}` 强制刷新；`PUT /usage/pricing` body PricingConfiguration。统计请求携带固定 version 与 priceVersion，初次并行读取 `/sessions/status?summary=true` 和 pricing，再加载 report。后台自动检查可由 GET pricing 触发，前端刷新状态即可。

顶层导出 `Usage({ active, onSession })`，onSession 接收 `{ sessionId, messageId? }`。Hash 使用 #usage? 保留筛选及视图，页面保持隐藏挂载，跨页面切换保存 hash 与位置。不将代理状态码、账户余额等不存在指标加进去。

## 验收

中英文目录完整、键盘及触屏精确值、可访问名称、数据缺失与加载错误、长名字搜索、深浅主题与窄屏。不要将缺失值填零，统计分页与图表分离。价格和聚合并行实施，先按公共契约搭页面。

## Comments

- 直接在 main 共享工作区按文件边界实施，不创建分支或提交。

## Answer

- 新增独立用量页，保留隐藏挂载、地址中的筛选与显示状态、会话返回位置；所有图与明细使用服务端同一查询结果。
- 完整日期、多选包含／排除／搜索、覆盖与关系筛选、数值范围、趋势粒度／指标／分组／柱线切换、互斥组成、排行、日历和分页明细已实现。区间下钻与当前范围取交集，小时保留半开边界。
- 请求明细按版本与筛选独立分页读取；价格管理支持任意模型覆盖、目录价格修改、恢复自动、明确映射、目录刷新与兜底状态。
- 新增共享 MultiFilterPicker 和中英文 usage 目录；图表支持焦点与触屏选择精确值，缺失和部分覆盖直接可见。
- 验证：Web 类型与国际化检查通过；6 个模型行为测试通过，覆盖地址校验、30 天本机日历边界、小时范围、互斥组成及动态文案。真实浏览器验收由综合验证任务负责。
