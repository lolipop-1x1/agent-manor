# 单会话概览与覆盖说明验证

- 字符、轮次边界、明确与推断终答、有效时间、零值、复制/注入、分块与子会话隔离使用人工记录验证。
- `tests/session-round-metrics.test.ts`、`tests/session-store.test.ts`、`tests/session-service.test.ts`、`tests/session-reading-presentation.test.ts` 已通过相关回归；后续统一检查会纳入新增 Unicode 共用函数。
- `node scripts/e2e-session-round-metrics.mjs`：19 项合成 Chrome 验收通过，包含三项均值、部分缓存比例、Token/费用小字迁移、请求范围移除、帮助计数、焦点恢复、父子切换、未结束与零值、英文单位及深色窄屏。
- 浏览器截图已人工检查，沿用既有字体、主题与统计行，无页面横向溢出。真实会话与接口性能由完整复盘任务统一回读，不以合成结果代替真实运行结论。

## 最终集成与真实页面

- 完整测试 976 项通过；服务端、Web、国际化检查、构建、安装包检查与公开内容检查通过。
- 用户指定的真实长会话已回读 HTTP 和浏览器。概览显示平均模型步骤、平均轮次耗时、平均提示词字数；部分覆盖的缓存读取占比可见，缺失记录没有补零。概览与用量页已移除指定的覆盖计数、费用副标题和重复请求范围。
- 同一真实会话摘要首次 HTTP 284 ms、重复 9 ms；首次测量与周复盘冷算并发，不能当作独立性能基准。
- 真实原文、标识及截图保存在本机 `.local/weekly-review-validation/`，不进入公开文件。复盘口径和完整验收见 [七天复盘验收](../overview-insights-review/validation.md)。
