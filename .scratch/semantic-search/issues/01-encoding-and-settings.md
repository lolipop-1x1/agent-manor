# 模型连接、调用调度及凭据

Status: resolved
Type: task
Blocked by:

## 范围

实现 `src/semantic/config.ts`、`embedding.ts`、`scheduler.ts` 及对应测试。共享契约在 `src/semantic-contracts.ts`；规格和界面见上级目录。连接请求为 OpenAI 兼容 embedding API，凭据独立文件权限 0600，查询优先、限流、预算和重试受控。

## 验收

默认关闭；保存不调用历史模型；凭据显隐读取独立；完整输入验证、批次向量校验、失败重试与预算预留、同查询复用可测试。

## Comments

- 2026-10-18：用户授权实施，在 main 分工开发；真实模型验收使用本地 Ollama，真实历史只读。

## Answer

实现独立模型连接和受限权限凭据、完整向量响应校验、统一 token 估算、查询优先调度、限流、重试、原子预算预留、用途用量及取消。19 项 transport 回归通过，已知产品错误使用稳定中英文描述。
