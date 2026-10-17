# 回放数据投影与版本化 API

Status: complete

## 范围

负责 `src/replay/`、`src/service/replay-routes.ts`、`src/server.ts` 的路由接入、`src/sessions/store.ts` 中回放专用只读查询，以及相应后端测试。契约固定于 `src/replay-contracts.ts`，修改契约先与主实现者协调。

## 要求

- GET `/api/v1/repositories/:id/replay/sessions?version=&sessionVersion=` 返回 `ReplaySessionsResult`。
- GET `/api/v1/repositories/:id/replay?sessionId=&version=&sessionVersion=` 返回 `ReplayResult`。
- 分别固定仓库与会话版本；候选包含有活动子会话的主会话。明确 child 关系递归，不把 fork 自动合并。
- 活动覆盖读取／修改／搜索、成功／失败／未知、基线外历史路径；轻量投影不带工具正文及片段。
- 原生调用身份可靠时合并同次调用多文件；同一时间不能作为分组依据。缺时间保留轨道内可靠顺序，不编造跨轨时间。
- 时间、顺序与消息定位关联已有来源位置和调用身份；避免 N×M 匹配及 N 次完整 profile 聚合。新增必要的轻量只读批量查询。
- 缓存绑定两个不可变版本、目标与规则；发布后不混版，版本淘汰仍明确失败。完整序列没有隐性采样上限。
- 不执行真实历史扫描。合成测试验证分组、父子、fork、缺时间、相同时间、版本变化、错误和性能边界。

## 验证

相关测试、check:server。返回可供主实现者运行的命令、API 行为和未解决事项。

## Comments

- 用户已授权直接 main 开发与最终推送，所有实现者在共享 main 上按文件所有权协作，不创建分支／worktree、不自行提交推送。

## 实现与验证

- `src/replay/service.ts` 实现双版本投影、明确子树候选、原生调用与来源位置分组、未定时顺序、目录搜索范围及两组版本缓存。缓存命中先核对版本保留状态；不加载工具正文、不截断活动。
- `SessionStore.replayDirectory/replayMessages` 批量读取身份和调用元数据；`AnalysisStore.analysisVersion` 提供轻量版本存在性校验。轨道采用父子层级前序排列，不合并 fork。
- 回放两接口已接入服务。`ReplayStep.orderKnown=false` 表示缺少可比较来源顺序，保留稳定展示但不宣称已证明先后。活动时间优先取地图事件，精确关联到原生请求时允许补充同次请求的已记录时间；不从工具结果或邻近事件推测时间。
- `node --import tsx --test tests/replay-api.test.ts`：6 项通过，包含 12000 步无采样、重复调用身份与缓存、父子／fork、缺时间、相同时间、基线外路径、目录搜索、双版本淘汰及 HTTP 错误。
- `node --import tsx --test tests/session-store.test.ts tests/index-store.test.ts tests/service-http.test.ts`：86 项通过。`npm run check:server` 通过。
- 本票不扫描真实历史、不启动真实刷新。真实来源的关系覆盖、画面与 API 的浏览器一致性由后续验收票核对；只有可定位到已发布会话索引的原生身份才进入可选择候选。

### 全量只读性能修正

- 实际大索引查询计划发现普通 JSON 数组 JOIN 会将目标数组置于全版本消息读取之后；改成复合主键 `version + session_id IN (...)` 点查，并只取回放会使用的工具请求。新增实际执行语句的查询计划回归断言。
- 仓库专用 `getReplaySnapshot` 通过 JSONB 分块遍历仅返回文件元数据、事件身份／来源／路径及映射路径；不取基线正文、历史片段内容与范围、覆盖区间和完整来源列表。原覆盖查询不变。
- 对同一完整版本的 64,735 条活动、1,077 个基线文件及 21,647 条映射逐项核对身份、来源、路径与缺口，并比较完整多轨回放，结果一致。进程首次最小投影约 1.17 秒，原去正文覆盖快照约 2.02 秒；暖回放不再扫描消息全集。
- 新回放测试现为 7 项通过；回放、索引和覆盖相关 39 项通过，`check:server` 与 `check:public` 通过。本轮仅只读已发布日常索引，未写入、迁移、复制或刷新该数据库；详细材料只保存在忽略目录。

- 最终回放 API 测试 12 项通过。补齐双版本与来源所属校验的专用证据读取、按分析版本复用的最小快照缓存，以及跨连接淘汰时完整读取或明确失败的事务回归。后续冷读观察为 9–19 秒，较早的 1.17 秒单次结果不代表稳定保证；完整边界以验收文档为准。
