# 知识沉淀优化实施契约

用户已授权在 main 实现本轮十三项优化；沿用统一控件、主题、国际化和动效，真实数据及凭据不进公开内容。开发者使用并行执行；共享 main 工作区，文件所有权见各任务，不提交其他人的代码。

## 任务图

- 08：输入节流、有限回读、主题卡片/程序身份、关系归并、可选语义召回。
- 09：逐任务调用与缓存明细、事件历史、任务预算，兼容旧任务缺失数据。
- 10：新建/记录入口、会话选择、任务详情、列表调宽、搜索焦点、设置样式与 Key 查看、Beta。
- 11：主线程负责本机凭据端点、可选候选向量比较适配、全局导航 Beta、集成测试和真实小输入验收、文档与交付。

## 接口协调

- 09 拥有 src/knowledge-contracts.ts、manager.ts、generation.ts、config.ts；先发布新增类型给 08/10。
- 08 拥有 pipeline.ts、input.ts、可选新增 topic 模块；PipelineHooks 增加 request 回调（09 定义 KnowledgeRequestObserver），scheduler.execute 的第七个参数接受该回调。09 将每次请求的预留/成功/失败及缓存细项计入任务 usage/events，并在请求前检查任务预算。回读 purpose 可新增 reread，需要所有计数按兼容缺省归零。
- 08 的 pipeline 构造函数可增加可选第四参数 options；similarity?: (candidate: KnowledgeDraft, others: readonly KnowledgeDraft[], config: KnowledgeConfig, signal?: AbortSignal) => Promise<number[] | undefined>。主线程接入已有知识向量连接，只做少量候选的可选召回，不依赖完整索引，失败回退并记录限制。
- 09 的 KnowledgeManager 构造函数增加可选第四参数 pipeline options，透传。任何旧进度不得以新分片方案恢复；固定配置与来源哈希，已完成覆盖不失效。
- 09 提供 job.title（任务主对象显示名）、job.usage（逐任务累计）、job.events（有界事件数组）、generation.taskInputTokenBudget、taskBudget、cachedInputPricePerMillion（均可选）；预览和明细使用已有接口，历史摘要不伪造旧用量/事件。
- 10 使用 page=new 为新建沉淀、page=tasks 为任务记录，taskId 在任务记录路由定位任务；会话入口改 page=new。选择器复用 /sessions 只读接口、共享筛选及分页。新建预览和已有任务状态分离。不把真实 Key 写入普通 settings 响应。
- 11 增加 POST /api/v1/knowledge/settings/key 请求 {kind:generation|embedding}，仅本机 Web 管理通道，返回 {key:string}、no-store；设置查看/复制不标记配置变化，关闭/离页隐藏并清除读取的明文。
- 10 拥有中英文 knowledge.ts 的所有新增文案；09/08 向 10 报告所需 descriptor key。

## 验收

假模型覆盖同义异名、已有ID、独立/冲突/纠正、工具省略与有界回读、无价值、预算/重试/缓存明细、暂停恢复。浏览器覆盖来源选择、历史深链、Key 查看、宽度持久化、焦点、双语言双主题与窄屏。真实 DeepSeek 测试仅短合成输入，预先限制请求数及 Token，不启动原会话全量任务，不改用户模型配置。最终 check/build/test/public 和代码审查通过，提交推送 main 后回读远端并更新本机服务；保持原任务暂停。
