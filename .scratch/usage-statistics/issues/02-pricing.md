# 模型价格获取、配置与计费

Type: task
Status: resolved

## 所有权与范围

`src/usage/pricing.ts`、随包价格快照及生成脚本、`tests/usage-pricing.test.ts`。公共类型见 `src/usage-contracts.ts`。不修改统计聚合、服务器、前端或国际化目录；产品错误使用稳定描述标识，由集成补充目录。

## 工作

完整实现 [规格](../spec.md) 的价格获取、兜底、任意模型覆盖、模型映射、价格版本和请求费用。固定公开地址后台拉取，24 小时缓存，网络失败保留最近成功目录，逐模型随包兜底。用户单价最高优先且独立保存；未知与缺失不能变成零费用，保留服务商和上下文档位。

## 接口

导出 `PricingService`，构造 `(home: string, options?: { fetch?: typeof globalThis.fetch; now?: () => Date })`；方法 `status(): PricingStatus`、`refresh(force?: boolean): Promise<PricingStatus>`、`configure(configuration: PricingConfiguration): PricingStatus`、`estimate(usage: SessionUsage, client?: string): RequestCost`。可为版本一致性增加 `view(version?: string)`，返回固定价格视图/估价闭包；需要新字段先与主 agent 沟通。

## 验收

使用隔离本地目录与合成网络响应测试：手动价优先、重启保存、映射、未知模型、真零、缺失、档位、同步失败与无效响应不覆盖有效缓存。快照来源和许可证实际保留，不复制业务源码。

## Comments

- 直接在 main 工作，按文件所有权并行，不创建分支或提交；主 agent 统一验证和提交。

## Answer

固定公开价格目录、逐模型网络／成功缓存／随包兜底、24 小时更新检查和手动刷新已实现。用户可为任意原始模型配置价格，优先于自动目录与映射；配置独立持久化，重启保留，网络刷新不覆盖用户设置。明确映射保留目标服务商及模型，原始名称保持不变。

请求费用保留零值、缺 Token、缺价格、分项歧义与上下文档位依据；统计使用固定价格版本，进程内保留最近八个视图。随包价格快照包含实际获取日期、来源、内容版本及 MIT 授权，提供可重复生成的更新脚本。

最终价格回归 15 项通过，覆盖手动优先、持久化、明确映射、逐模型兜底、离线失败、并发更新、版本、档位、缓存／推理／音频边界和实际计价依据。已纳入 681 项完整自动测试；真实浏览器价格交互由集成任务记录。
