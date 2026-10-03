# 代码活动地图界面原型

Type: prototype
Status: resolved

## Question

比较三种信息层级，确定用户更适合从整仓地图、文件证据还是目录覆盖情况进入分析。

## Scope

三个结构不同的 UI，挂载于 `/prototype/activity-map?variant=A|B|C`。
当前仓库没有可嵌入的产品页面，因此使用独立的临时页面。
使用内存示例数据，支持筛选、目录下钻、文件证据、精确与近似区分及模拟刷新。
不接入本机历史、不实现分析后端、不持久化。

## Primary source

原型分支：`codex/activity-map-prototype`。
源文件：`web/activity-map.prototype/`。
启动：`npm run prototype`。

## Verdict

用户于 2026-10-03 表示“原型不错，就照着方案开始开发”。正式开发默认采用 A 地图优先，保留原型分支作为布局探索的原始材料。

## Answer

已完成三个可点击的结构方案，问题现在可以通过实际界面对比。

- A 地图优先：目录导航、面积按行数绘制的 treemap、文件证据侧栏。
- B 证据工作台：文件列表、当前代码、单次工具返回证据并排呈现。
- C 目录纵览：先比较模块覆盖情况，随后展开局部地图与文件内容。
- URL 参数与底部按钮／键盘支持回环切换，切换保留筛选和文件状态。
- 筛选会重新计算覆盖率。主指标只包含精确对应，近似单列。
- 所有数据、代码片段和刷新状态均明确标为示例，没有真实分析能力。
- 页面底部可展开完整相关状态，控制台也会在状态变化时输出。

验证：TypeScript 与 Vite 构建通过；手动操作了三种布局、客户端和时间筛选、
目录下钻、代码弹窗、空状态、刷新成功／失败、键盘切换、390px 窄屏与明暗主题。
Lighthouse 本地构建版单次复查：Performance 93、Accessibility 100、Best Practices 100，
LCP 2.41 秒、CLS 0.087。该审查只针对原型，不代替真实历史与正式产品验收。
未编写测试，符合 prototype 的临时探索约定。

捕获分支仍为 `codex/activity-map-prototype`，暂不合入 main。

## Comments

- 采用 React、Radix Themes、D3 treemap；低动效、单一青绿色强调色。
- 原型遵循两个显式调用的 skill，不把原型代码提升到 main。
