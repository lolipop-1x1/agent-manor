# 管理确认与程序更新

Type: task
Status: claimed
Blocked by: none

规格：[整体方案](../../../docs/design/npm-cli-distribution.md)，[能力覆盖清单](../capability-matrix.md)。

## 范围

管理 API、packages/cli/src/runtime/update.ts、整合测试和文档

## 验收

管理授权绑定具体操作和修订，不伪造浏览器；显式软件更新与旧后台/在途任务边界，按各安装方式处理。

管理写入与运行验收使用隔离的合成数据，禁止改变真实数据目录、模型 Key 或正在使用的服务。

接口已与 01、02、03 明确，可并行实现；完整集成验收仍依赖三项任务的最终产物。
