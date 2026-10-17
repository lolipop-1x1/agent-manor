# 可重建语义索引与检索 Worker

Status: resolved
Type: task
Blocked by:

## 范围

实现 `src/semantic/engine.ts`、`documents.ts`、`worker.ts` 及对应测试。读取已发布会话索引，轮次切块、内容 hash 复用、持久化计划、来源位置、版本发布及筛选后向量搜索。独立 SQLite，向量算子使用 sqlite-vec；所有扫描在 Worker。

## 验收

预览不编码；复制内容只生成唯一输入；保留范围外有效位置；内容失效及时排除；共享向量引用正确；构建完成再发布；查询先筛选来源，不以全库截断后过滤替代。

## Comments

- 2026-10-18：开始实现，接口以共享契约及分工约定为准。

## Answer

实现独立 SQLite／sqlite-vec、轮次与分支文档、精确输入 hash 复用、持久计划与检查点、完整发布、窗口保留／清理及先筛选再精确余弦匹配。15 项 engine 回归通过，追加保留未变位置，编辑、删除、拆轮、顺序与分支变化正确失效。
