# 原生 LevelDB 与 IndexedDB 只读解析

Type: task
Status: resolved
Blocked by: 02

## 目标

实现 Node.js 运行时中的有界原生缓存读取，保留活动表、WAL、版本、删除标记、外置 blob 和一致性检查。不依赖用户安装 Python，不写入或锁定原始库。

## 读取契约

`src/history/adapters/doubao-work-store.ts` 导出 `readDoubaoWorkCache(currentPath)`，输入实际原生 LevelDB 的 CURRENT 文件路径，返回 `{ records: { account: string; value: Record<string, unknown> }[]; fingerprint: string }`。仅解码豆包账号分区中的 conversations store；account 是稳定的账号分区命名空间。

## 完成条件

使用合成容器验证 WAL／SST、活动版本、删除、Snappy、外置 blob、损坏、体积上限与并发变化；对真实隔离副本核对已有消息，不公开原始载荷。

## Answer

已实现纯 Node 的有界 LevelDB／IndexedDB 读取器，覆盖活动 MANIFEST、SST／WAL、删除标记、校验、Snappy、外置 blob 与一致性。19 项合成测试通过，真实稳定副本与当前源读取通过；未知账号／store 结构报错，合法空 store 可发布空结果。
