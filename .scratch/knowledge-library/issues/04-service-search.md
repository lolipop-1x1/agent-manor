# 04 服务、会话证据与语义索引

Type: task
Status: resolved
Blocked by: 01, 02

## Scope

src/knowledge/sources.ts、semantic.ts、src/service/knowledge-routes.ts、src/server.ts 接入与相应测试；管理写权限、完整来源读取、可选语义索引和稳定错误。

规格：`docs/design/knowledge-library.md`。接口约定：`.scratch/knowledge-library/implementation.md`。用户已明确授权开发测试，直接 main；CLI 与 Skill 不在范围。

## Acceptance

通过完整方案中对应验收，记录实际检查和未验证边界，不以静态审查冒充真实运行。

## Answer

已完成本机 HTTP、独立知识存储接入、只读来源 Worker 与独立可重建向量库。来源读取覆盖完整轮次与工具分页、消息身份及内容哈希、跨分支共享祖先去重、来源变化/缺失核验及原对话定位。普通实例调用可提交待审知识，审阅与可用性变更走同源 Web 管理入口；不将该约束宣称为账号身份鉴别。关键词不依赖生成模型或 Embedding。语义连接支持复用或独立配置，显式预览构建、暂停恢复、当前修订与状态复核。来源、HTTP、语义与实际全链路验收通过，具体见 docs/validation/knowledge-library.md。
