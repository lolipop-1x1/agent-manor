# AgentManor

在本机浏览和搜索 Code Agent 历史，查看它们在当前 Git 仓库中的读取与修改活动。

支持 Codex、Claude Code、CodeFlicker CLI／桌面版、DeepSeek Harness、Pi、WorkBuddy、OpenCode、ZCode、CodeBuddy、Qoder。各来源按实际留存记录展示消息、工具与用量；缺失数据明确标注，格式边界见 [历史支持矩阵](docs/design/history-support.md)。

首版提供目录代码地图、文件与行覆盖率、活动和原始证据回查，以及共用一个本地后台的 Web、CLI 和 Agent Skill。精确对应与近似对应分别展示；不能确定的范围保留采集缺口。

当前是 `0.1.0` 本地交付版本，npm 包保持 `private`，尚未发布到 npm。运行目标为 Node.js 24 和 Git。**当前支持 macOS，已在 Apple Silicon 完成验收；暂未兼容 Windows。** Linux 尚未完成验收，不在当前支持范围内。许可证尚未选定。

## 安装与启动

取得构建好的 `agent-manor-0.1.0.tgz` 后，可安装到独立目录：

```sh
mkdir -p ~/agent-manor-local
cd ~/agent-manor-local
npm install /absolute/path/agent-manor-0.1.0.tgz
./node_modules/.bin/agent-manor register /absolute/path/to/repository --wait --json
./node_modules/.bin/agent-manor web
```

安装产物包含编译后的 CLI、后台、Worker、Web 和 Skill，安装用户无需再构建。SQLite 依赖 `better-sqlite3` 原生扩展：若目标平台没有可用预编译包，安装过程可能需要本机编译工具链。

开发者在源码仓库使用 Node 24 执行 `npm ci`、`npm run check`、`npm test`、`npm pack`；`npm pack` 会先构建并检查交付入口。

贡献前执行 `npm run check:public`，公开示例使用人工合成数据。个人与业务资料、真实历史和数据库不得提交；详细边界及本地禁用词配置见 [公开内容约定](docs/agents/public-content.md)。

登记成功后，将 JSON 中的 `repository.id` 用于后续查询：

```sh
agent-manor coverage <repositoryId> --json
agent-manor file <repositoryId> src/example.ts --version <analysisVersion> --json
agent-manor refresh <repositoryId> --wait --json
agent-manor status --json
agent-manor stop --json
```

`agent-manor` 需在 PATH 中，或换成安装目录的 `./node_modules/.bin/agent-manor`。第一次需要服务时自动启动后台；关闭网页后后台继续提供查询，`stop` 显式停止。

## 会话库

网页顶部“会话库”可浏览全部可发现历史，搜索标题与正文，切换简易对话、完整过程及消息轨迹，并查看模型、Token、缓存和 Tool／Skill／MCP 画像。无需先登记仓库。CLI 使用 `agent-manor sessions refresh --wait --json` 与 `agent-manor sessions list --json`；更多入口见 [使用指南](docs/usage.md#全局会话库)。

## 数据与统计

- 默认发现已注册客户端的本机历史目录，完整目录与覆盖配置见 [使用指南](docs/usage.md#数据目录后台与缓存)；无法可靠归属的来源单独列出，可手动关联。
- 默认统计当前工作区源码，包含未提交修改；配置与文档可切换。行数包括注释和空白行，依赖、生成物、二进制及链接目标默认排除。
- 成功读取且内容、范围可对应时进入覆盖；搜索、失败、缺失结果和未知范围单列。历史编辑次数不等于最终 Git diff。
- 分析索引默认在 `~/.agent-manor`。原始历史只读，会话索引保存浏览及搜索所需正文，代码地图索引保存所需历史源码片段；分析在本机完成，无需调用模型或上传历史。
- 代码地图每个仓库保留最近两个成功版本；会话内容保持完整。数据库空间整理只在服务启动时按空闲空间及时间阈值执行，详见 [数据目录与缓存](docs/usage.md#数据目录后台与缓存)。
- 所有下钻保持同一分析结果版本和筛选。当前代码改变时返回过期状态，刷新后再查看对应范围。

## 文档与 Agent 使用

| 内容 | 入口 |
| --- | --- |
| 完整 CLI、筛选、数据目录、停止与缓存重建 | [使用指南](docs/usage.md) |
| Agent 的 JSON 查询与证据回查流程 | [agent-manor Skill](skills/agent-manor/SKILL.md) |
| 历史格式与 Shell 支持边界 | [历史支持矩阵](docs/design/history-support.md) |
| 文件分母、分类与排除规则 | [仓库基线规则](docs/design/baseline-rules.md) |
| 精确／近似对应与覆盖口径 | [匹配规则](docs/design/matching-rules.md) |
| 产品规格、领域术语与架构决定 | [源码仓库](https://github.com/lolipop-1x1/agent-manor) |

包内 Skill 位于 `node_modules/agent-manor/skills/agent-manor/`。按所用客户端的 Skill 安装方式引用或复制该目录；包安装不会自动修改客户端配置。
