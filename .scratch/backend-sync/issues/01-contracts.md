# 同步状态合同与任务图

Status: resolved
Type: task
Blocked by:

## 范围

确定共享状态与各任务的文件责任。审查基准为实施前的 main 提交 e6c7def；所有工作直接在 main 同一工作区按文件归属协作。

## Answer

会话摘要可附加 `autoSync: SessionAutoSyncStatus`：`intervalMs`、`state`（disabled／waiting／pending／running／backoff）、`nextRunAt`、`lastSuccessAt`、`consecutiveFailures`、调度器所跟踪的全局 `job`、`error`／`errorDescriptor`。原摘要的 `job` 仍可表示当前局部任务；两者不可混用。接口只有状态读取不会触发同步。

任务 02、03、04 依赖本任务，可并行；任务 05 依赖它们完成后进行集成、双轴审查、浏览器验收与本地重启。
