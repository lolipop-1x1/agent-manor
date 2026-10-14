# 原生客户端扩展

Type: task
Status: claimed

## 已确定范围

- 新增 Gemini CLI、Qwen Code、新版 Kimi Code CLI、Oh My Pi、Grok Build、Reasonix、Codewhale 七个客户端。
- 覆盖现有产品全部能力：会话发现、浏览、搜索、执行轨迹、代码地图、用量与费用估算、资源使用、Skill／MCP 盘点及停用、回收、恢复。
- 首轮依据固定上游版本的生产写入和配置加载源码，使用人工合成来源验收；原生客户端运行效果单独标注为未验证。
- 版本基线采用当前正式发布版，Grok Build 固定源码提交；不额外增加旧代际适配。
- 资源管理沿用原生控制范围，在预览中明确影响；普通资源缺少停用开关时提供回收与恢复，受保护或写入方式未核验的入口保持只读。
- 持续沿用客户端身份、历史格式、配置来源、资源本体和资源入口之间的领域边界；来源缺失的字段保留未知。
- 文档、代码、任务记录和提交信息只描述本产品的能力、证据与决策。

## 设计树

1. 支持范围：全部现有能力，已确定。
2. 验收层次：源码核对与合成测试先交付，原生运行未验证，已确定。
3. 上游版本与格式：正式版本与 Grok 固定提交，七个客户端写入与加载规则已静态核对。
4. 资源管理：保留原生控制范围及既有保护，无停用开关时使用回收与恢复，已确定。
5. 实现与交付：已确认，直接在 main 开发、测试、审查，验证通过后交付。

## 执行规则

- 按文件职责并行实现，不创建开发分支或独立开发工作区；各任务保留其他任务的改动。
- 先交付规格和任务图，再实现全部范围；完成两轴审查及必要修复后交付代码。

## 任务

- [01 支持范围与验收边界](issues/01-support-scope.md)：resolved。
- [02 客户端声明与共享适配边界](issues/02-client-contracts.md)：main 集成基础。
- [03 Gemini 与 Qwen 原生历史](issues/03-gemini-qwen-history.md)：依赖 02。
- [04 Kimi 与 Oh My Pi 原生历史](issues/04-kimi-omp-history.md)：依赖 02。
- [05 Grok、Reasonix 与 Codewhale 原生历史](issues/05-grok-reasonix-codewhale-history.md)：依赖 02。
- [06 原生资源盘点与可恢复管理](issues/06-resource-management.md)：依赖 02。
- [07 产品集成与完整验收](issues/07-product-validation.md)：依赖 03、04、05、06。
- [08 两轴审查与修复](issues/08-review.md)：依赖 07。
- [09 交付与远端回读](issues/09-delivery.md)：依赖 08。
- [完整规格](spec.md)：现有能力接入与验收要求。
- [来源支持矩阵](source-matrix.md)：固定版本、原生存储、资源控制和已知缺口。
