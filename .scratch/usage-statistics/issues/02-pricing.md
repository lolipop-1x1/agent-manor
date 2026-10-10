# 模型价格获取、配置与计费

Type: task
Status: claimed

## 所有权与范围

`src/usage/pricing.ts`、随包价格快照及生成脚本、`tests/usage-pricing.test.ts`。公共类型见 `src/usage-contracts.ts`。不修改统计聚合、服务器、前端或国际化目录；产品错误使用稳定描述标识，由集成补充目录。

## 工作

完整实现 [规格](../spec.md) 的价格获取、兜底、任意模型覆盖、模型映射、价格版本和请求费用。固定公开地址后台拉取，24 小时缓存，网络失败保留最近成功目录，逐模型随包兜底。用户单价最高优先且独立保存；未知与缺失不能变成零费用，保留服务商和上下文档位。不得含外部实现来源说明。

## 接口

导出 `PricingService`，构造 `(home: string, options?: { fetch?: typeof globalThis.fetch; now?: () => Date })`；方法 `status(): PricingStatus`、`refresh(force?: boolean): Promise<PricingStatus>`、`configure(configuration: PricingConfiguration): PricingStatus`、`estimate(usage: SessionUsage, client?: string): RequestCost`。可为版本一致性增加 `view(version?: string)`，返回固定价格视图/估价闭包；需要新字段先与主 agent 沟通。

## 验收

使用隔离本地目录与合成网络响应测试：手动价优先、重启保存、映射、未知模型、真零、缺失、档位、同步失败与无效响应不覆盖有效缓存。快照来源和许可证实际保留，不复制业务源码。

## Comments

- 直接在 main 工作，按文件所有权并行，不创建分支或提交；主 agent 统一验证和提交。
