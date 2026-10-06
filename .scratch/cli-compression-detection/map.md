# CLI 压缩摘要识别

## 已作决策

- 有显式压缩标记的摘要归类为过程记录，不增加用户轮次。
- 解析回归、缓存失效和真实会话显示分别验证。
- 显式 `isCompactSummary: true` 已纳入压缩分类及 CLI 缓存规则；合成回归与真实浏览器验收通过。

## 任务

- [01 识别与索引更新](issues/01-compression-detection.md)：resolved
