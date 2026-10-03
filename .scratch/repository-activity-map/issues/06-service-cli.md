# 本地 API、后台生命周期与 CLI

Type: task
Status: resolved
Blocked by: 02, 05

## Scope

责任文件：src/server.ts、src/service/、src/cli.ts、tests/service*.test.ts。
Fastify API、静态 Web、CLI JSON／人类输出、自动启动、启动更新检查、任务等待、状态／停止、分页活动和原始证据回读。协议见 implementation-contract.md。

## Acceptance

同筛选／版本 API 和 CLI 一致，覆盖热点、未观察到读取、目录／文件／证据。回环绑定、登记仓库路径、拒绝穿越和跨站写入。并发启动只有一个后台，网页关闭后可查询，显式停止。

## Answer

- 2026-10-04：实现提交 `ba035d65b36a586dbd197024742a060216c30b97`，以非快进合并提交 `961db84ebe0bbc42d602501856344c70c35ab3ad` 合入正式实现分支。
- Fastify 提供契约中的版本化 REST 与 `dist/web` 静态资源，Commander CLI 覆盖登记、仓库、覆盖率、热点、未观察读取、文件、分页活动、原始证据、来源关联、刷新、任务等待、状态、停止、缓存重建和 Web。CLI 查询仅通过 HTTP，与 Web 共用分析结果版本和筛选；JSON 保持 API 对象，覆盖率人类输出包含中文汇总与文件表。
- 后台按需启动，启动时为已登记仓库入队检查刷新；默认随机空闲回环端口，可指定端口和数据／历史目录。独占锁及实例 PID／随机标识核验避免并发重复启动；异常状态不用于终止任意 PID，显式停止不会触发自动启动。
- 当前文件读回时核对内容哈希，过期返回 `content:null`／`contentStale:true` 且不提供旧事件高亮；拒绝路径穿越、文件和父目录符号链接。证据仅从已发布索引引用读取原始物理记录并核对记录哈希，来源追加后旧记录可回查，记录改写显示不可用。限制 Host／Origin、跨站写入、非 JSON 与未知请求体字段，静态路径拒绝链接逃逸，服务日志关闭。
- 合并树执行 `npm run check`、`npm run build`、`npm test` 和 `git diff --check` 全部通过，共 77 项测试。服务专项 5 项是真实 HTTP／CLI 集成验证，覆盖临时 Git 仓库的版本与筛选、来源关联、清缓存、过期内容、证据追加与替换、请求安全、4 个并发 CLI 单实例、源码和编译 Worker 的包外 cwd、重启刷新与停止。
- 同树编译后台从包外 cwd 启动，正式 Web 首页及本次构建的 JS 资源经 HTTP 返回 200。Vite 构建通过，CodeMirror 分包 502.55 kB 的体积提示保留到交付审查。
- 此票未执行 npm 包安装、真实浏览器操作或真实个人历史业务验收；这些结果由 08 的独立交付验收记录，不以此票测试通过替代。

## Comments

- 2026-10-03：采用已确认首版规格，自行实现。
