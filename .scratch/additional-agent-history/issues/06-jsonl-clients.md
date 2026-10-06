# WorkBuddy、CodeBuddy 与 Qoder 适配

Type: task
Status: ready-for-agent
Blocked by: 03

## Scope

实现三类 JSONL 历史的发现、规范化和元信息补充；共享相同格式规则但保留产品身份。只修改三类适配器及匿名测试。

## Acceptance

- WorkBuddy function_call／result 按原生身份配对，SQLite 元信息与正文关联，保留 reasoning、用量和压缩／注入标记。
- CodeBuddy 本机仅用户记录的来源正常展示缺失，不补造助手／工具／用量。
- Qoder workspace 元信息首行不阻止正文发现；工具和用量能解析；agentId 或 parentUuid 单独不足以确认委派。
- 未核验用量分母不计算缓存比例；原始证据回查与目录归属保留依据。
