# 服务端产品诊断与原始详情

Type: task
Status: resolved
Blocked by: 02

## 目标与范围

迁移 API 错误、输入校验、代码地图／会话刷新阶段、历史适配器采集缺口与事件原因、资源管理预览及结果。生成端提供稳定消息标识／参数，保留现有 message、reason、phase 等字段与原始诊断。

## 验收

- 自有产品诊断可由 Web／CLI 翻译，不依赖中文句子匹配或运行时替换。
- 历史解析与持久化保留描述标识；已有索引中的旧文本无需重建即可作为原始详情展示。
- 外部错误保留原文，不把未知诊断猜成已翻译的产品消息。
- 描述、原字段、稳定代码及 JSON 与显示语言无关，查询／统计语义不变。
- 合成测试覆盖错误、刷新、缺口、管理预览／结果，以及旧数据兼容。

## Answer

已实现。服务端自有提示在生成点附加稳定消息描述，完整中英文诊断目录共 418 项；所有既有 `message`、`reason`、`phase`、`error` 和稳定代码继续保留原值。已分配的消息 key 不随原始中文文案修改而改名。

- 契约使用 `Gap.messageDescriptor/details`、`HistoryEvent.reasonDescriptor`、`Mapping.unknownReasonDescriptors`、`Job/SessionJob.phaseDescriptor/errorDescriptor`、`ApiErrorResponse.error.messageDescriptor`、管理预览的 `restorationDescriptor` 及操作结果的 `messageDescriptor/details`。
- 历史核心、全部产生诊断的适配器、规范化会话、用量回调、匹配到覆盖、API 错误和请求错误透传均保留描述；成功或更换原因时同步清除／替换旧描述。DSH 副本选择、匹配组合原因及备份清理反馈保存完整子描述，避免把中文子句放入参数。
- SQLite 保持现有 schema 和规则版本，通过完整 JSON 保存可选字段，不回填旧记录，不因显示语言重建索引。没有明确描述的旧数据或外部错误保留原文；安全概述仍按原有 API 边界返回。
- 自动启动的后台 `serve` 明确使用 `--lang auto`，避免父 CLI 的显式语言覆盖被子进程继承的低优先级无效语言设置阻断。后台不将显示语言写入索引。

验证：服务端类型检查、目录完整性／参数检查、公开内容检查与 diff 空白检查通过。原有定向套件 242 项中，首次 8 项因沙箱禁止监听而失败；允许本机临时端口后 HTTP 与会话刷新补验通过，旧的精确错误 JSON 断言已按新增可选字段更新。新增 7 项诊断测试通过；最终资源地图／使用、DSH 和诊断组合套件 44 项通过。HTTP 另验证中英文请求的完整错误 JSON 相同以及 RequestError 描述透传。

关键验证文件：[诊断与旧数据测试](../../../tests/i18n-diagnostics.test.ts)、[DSH 副本测试](../../../tests/native-event-clients.test.ts)、[管理预览／结果测试](../../../tests/resource-management.test.ts)、[HTTP 契约测试](../../../tests/service-http.test.ts)。Web 与 CLI 呈现以及完整双语浏览器验收由后续任务整合。

## Comments
