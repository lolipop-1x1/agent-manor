# Commander CLI 工程与全部业务命令

Type: task
Status: resolved
Blocked by: none

规格：[整体方案](../../../docs/design/npm-cli-distribution.md)，[能力覆盖清单](../capability-matrix.md)。

## 范围

packages/cli（skills 与 runtime/update.ts 除外）、src/cli.ts、CLI 翻译及命令测试

## 验收

建立私有 CLI workspace，拆分命令与公共层，保持旧命令兼容，补齐 capability-matrix.md 的所有业务 API、输入与输出、知识管理入口和任务等待。核对命令实际返回数据。

管理写入与运行验收使用隔离的合成数据，禁止改变真实数据目录、模型 Key 或正在使用的服务。

实现与验证：[CLI 工程结果](../cli-engineering-results.md)。
