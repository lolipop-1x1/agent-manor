# npm 交付与 Skill 安装管理

Type: task
Status: resolved
Blocked by: none

规格：[整体方案](../../../docs/design/npm-cli-distribution.md)，[能力覆盖清单](../capability-matrix.md)。

## 范围

package.json、package-lock.json、构建/打包配置、skills/、packages/cli/src/skills/、CI 安装矩阵和配套测试

## 验收

统一产物、am bin、MIT/public registry，完整自包含 Skill，显式安装/状态/更新/移除、修改保护与备份。五种系统架构安装 CI。

管理写入与运行验收使用隔离的合成数据，禁止改变真实数据目录、模型 Key 或正在使用的服务。

## 实现与验证

- 根包采用 MIT/public registry，增加 `am`，CLI 为私有 workspace；统一编译保留包内后端、Worker、CLI 和 Web 路径及旧入口兼容。
- 配套 Skill 为场景路由和七份自包含 reference；安装管理支持两宿主的用户／项目范围、自定义父目录、完整副本、版本与文件校验、同版跳过、更新、冲突备份和安全移除。
- `npm run test:cli` 的七项隔离 Skill 测试通过；`check:cli`、后台构建、包入口与引用检查、中英文目录检查、公开检查通过。
- `npm run test:package` 已在 macOS arm64 / Node 24.19.0 包外真实安装并通过：两个 bin、只读诊断、SQLite 3.53.4 与向量扩展、Skill 冲突备份更新移除、后台／Worker／Web 静态脚本及停止。
- GitHub Actions 为五种 OS／架构安装同一 tarball；本机不能代表其他平台，其他矩阵结果在推送后以实际 CI 为准。本任务不执行 npm 公共发布。
