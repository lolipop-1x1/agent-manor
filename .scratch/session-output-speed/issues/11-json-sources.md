# JSON 历史请求速度

Type: task
Status: resolved
Blocked by: 10

规格：[来源与区间](../spec.md)。用户已授权全部可计算来源接入。

## Scope

接入 CodeBuddy、WorkBuddy、Qoder；明确请求身份、校验结束、排除复杂回合及工具等待。

## Validation

合成数据覆盖完整结束、取消、缺失、重复、门槛和消息关联；原始历史只读，公开内容不保留真实输入。

## Answer

CodeBuddy、WorkBuddy、Qoder 已接入请求身份和时间证据。CodeBuddy 排除包含工具或多次模型调用的复杂回合；WorkBuddy、Qoder 校验明确结束或全部匹配工具结果支持的推断结束。缺用量、未知结束、冲突及部分响应保留原因。九项新合成回归及既有八项原生 JSON 测试通过。
