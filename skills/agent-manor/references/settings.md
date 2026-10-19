# 模型、索引与共享偏好

只在用户要求修改配置、构建索引或诊断时使用。settings get/status 不调用模型；test/try/search/build 可能调用已配置服务，不作为普通查询的前置动作。

## 读取 → 编辑 → 保存

```sh
am knowledge settings get --json
am semantic settings get --json
am preferences get --json
am knowledge settings set --input knowledge-settings.json --json
am semantic settings set --input semantic-settings.json --json
```

先取当前值，将需要修改的 config 复制到文件后编辑。两类模型设置都是**完整 config**，不是局部 patch；不要把返回的 fingerprint、hasKey 等外壳字段混进 config。

| 设置输入 | 结构与含义 |
|---|---|
| 知识 | `{ "config": <完整config>, "generationKey": "可选新凭据", "embeddingKey": "可选新凭据" }` |
| 语义 | `{ "config": <完整config>, "apiKey": "可选新凭据" }` |
| 凭据省略 / null | 省略保留已有凭据；null 明确清除；不要从 hasKey 猜出真实值 |
| 保存结果 | 默认 `{saved:true,fingerprint,hasGenerationKey,hasEmbeddingKey}` 或 hasKey；不回显完整配置，get 回读验证 |

知识 config 字段：

| 字段 | 关键配置 |
|---|---|
| `generation` | url/model、contextTokens/outputTokens、timeoutMs、retries、requestsPerMinute；reasoningEffort=none/low/medium/high；可选单价和 dailyBudget/taskInputTokenBudget/taskBudget |
| `outputLanguage` | zh-CN 或 en；控制生成知识语言，与 CLI 显示语言独立 |
| `extractionPrompt` / `mergePrompt` | 提炼／归并提示词；先取 get/defaults，修改后可小范围 try 验证 |
| `automatic` | enabled、intervalMinutes、quietMinutes、scope；scope 与[会话沉淀](knowledge-extraction.md)一致；主动查询不顺带开启自动任务 |
| `embedding` | mode=off/reuse/independent；reuse 复用会话语义配置，independent 使用自身 connection；还含 timeoutMs/retries/requestsPerMinute 等 |

语义 config 字段为 enabled、connection、scope、strategy。connection 含 HTTP(S) url、model、可选 dimensions、documentPrefix/queryPrefix；启用时连接必须完整。scope 见[语义搜索示例](../examples/semantic-search.json)，注意该示例文件是搜索输入，不是整个配置。strategy 包含并发／批次／Token预算／速率／超时／重试、chunkChars/overlapChars、安静等待与窗口清理。重叠须小于分片长度；保留 get 返回的其他值，避免一份“最小配置”重置用户策略。

## 测试、试提炼与凭据

```sh
am knowledge settings test --json
am semantic test --json
am knowledge settings try --input try.json --json
am knowledge settings defaults --language en --json
```

knowledge settings test 可无输入使用已保存配置，也可传与 knowledge settings set 同结构的完整设置输入。semantic test 可无输入使用已保存连接／凭据；临时输入为 `{ "connection": <完整连接>, "apiKey": <可选字符串或null> }`，不使用 config 外壳。try 输入为 `{ "scope": <完整抽取范围>, "settings": <可选知识设置输入> }`，返回 candidates/disposition/limitations/usage，不持久化知识。disposition 为 knowledge/no_value/needs_context。测试同样会调用模型；先限定单会话少量轮次与预算。

get 返回 config、fingerprint 及是否已保存凭据的布尔值；不含明文 key。确需查看时用 `knowledge settings key generation`、`knowledge settings key embedding` 或 `semantic settings key`，按[审阅授权](knowledge-review.md)相同的具体操作确认机制办理。凭据不写入日志、公开资料或回答正文。

## 建索引与语义查询

```sh
am semantic status --json
am semantic preview --data '{}' --json
am semantic build <previewId> --wait --timeout 300 --json
am semantic search --input semantic-search.json --json
am knowledge index status --json
am knowledge index preview --json
am knowledge index build <previewId> --wait --json
```

semantic preview `{}` 使用保存的 scope（需连接完整、timeRange 已选择）；也可传 `{ "scope": ... }`。搜索输入取[示例](../examples/semantic-search.json)，q 非空，scope 完整，默认每页20；使用 sessions search --mode semantic 可复用常用 CLI 筛选。

知识索引与会话索引分别预览、分别用各自 previewId build，不互换。status 中 `ready` 或知识索引 `status=ready` 才表示可用；fingerprint 不一致需重新 preview。语义关闭或未就绪时，可先使用关键词搜索，不能把未构建当作无知识。pause/resume 可控，`--wait` 超时不取消；预览和设置变化后重新检查预算。

## 共享偏好使用 patch

```sh
am preferences set --data '{"language":"zh-CN","appearance":{"mode":"dark","preset":"berry"}}' --json
am preferences get --json
```

language=auto/zh-CN/en；sessionsAutoRefreshInterval/mapAutoRefreshInterval 单位毫秒，可选0/5000/10000/30000/60000/300000/600000，0关闭。appearance 是部分对象：mode=auto/light/dark，preset=blue/terracotta/celadon/amber/berry/graphite/custom，customColor 为 #RRGGBB。set 默认仅返回 saved 和此次实际修改字段；get 核对合并结果。

完成条件：回读配置验证预期字段，确认旧凭据的保留／清除语义和索引状态；报告是否发生模型调用及任务终态，不把保存成功说成索引已可用。
