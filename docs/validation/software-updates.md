# 产品更新验证

## 验证方法

版本检查与安装分开验证。公共包尚未发布，发布版本、网络错误和安装器使用合成 mock；命令解析、安装锁、实例身份、数据备份、返回格式和浏览器交互走实际产品代码。

- `tests/release-checks.test.ts`：版本关系、Node／系统／架构要求、24 小时正负缓存、失败保留旧结果、超时、跨进程检查合并、设置与提醒互斥、忽略与恢复、两种命令引用规则。
- `tests/cli-update.test.ts`、`tests/installation-update-guard.test.ts`：安装确认、精确目标复核、降级拒绝、任务与多目录保护、空间不足、备份恢复、清单及锁文件核验、端口恢复、重启准备进度、JSON 与中英文输出。
- `tests/npm-install-process.test.ts`：启动合成 Node 父子进程，验证取消、超时、输出超限和遗留后代的收束；方法返回后持续观察合成文件，确认后代停止写入。
- `tests/release-routes.test.ts`：真实本地服务上的只读状态、主动检查、设置校验、同源写入保护及失败隔离。
- `scripts/e2e-update-cli.mjs`：复制编译产物到隔离安装，实际启动 CLI 子进程；预加载模块只替换 registry 查询和 npm 执行器。
- `scripts/e2e-software-updates.mjs`：真实本地后台与 Chrome，只有发布响应为合成数据。验证忽略、恢复、手动检查、关闭自动检查、复制命令、焦点恢复、主题与语言、窄屏和页面状态保留。

## 复现

```bash
npm run check
npm run check:cli
npm test
npm run test:cli
npm run build
node scripts/e2e-update-cli.mjs
node scripts/e2e-software-updates.mjs
```

资源紧张时可用 `node --import tsx --test --test-concurrency=2 tests/*.test.ts` 限制全量测试并发。本轮一次高并发回归中，已有用量 Worker 用例出现临时数据库打开失败；该文件独立复验 12 项通过，收尾全量采用受限并发，不改动用量实现。

浏览器脚本使用本机已安装的 `playwright-cli` 与 Chrome。所有管理写操作使用隔离目录；不会替换用户的现有产品安装。截图、命令输出和详细报告保存在本机忽略目录 `.local/software-updates/`，不进入发布包或仓库。

## 结果与边界

| 验证 | 本轮结果 |
| --- | --- |
| 全量测试 | 限制两个文件并发，1745 项通过，无跳过 |
| CLI workspace 回归 | 45 项通过 |
| 实际 CLI 子进程 | 15 个 mock 发布／安装场景通过 |
| Chrome 交互 | 8 组交互场景通过，10 张截图，无运行时异常 |
| tarball 包外安装 | 两个入口、自定义全局 prefix、原生扩展、后台／Web／Skill 与安装进程树验证通过 |
| 规范与规格审查 | 所有可行动问题修复后复核通过 |

类型检查、中英文目录、CLI workspace 检查、构建、公开内容与安装包链接检查均通过。真实 tarball 在隔离 prefix 中安装后，核验自定义全局安装识别、两个命令入口、SQLite、后台、Web、Skill，以及安装进程的取消和遗留后代。

- 定向检查包含成功、失败、并发和中断，不只检查命令是否能执行。
- 实际 CLI 子进程验收覆盖 15 个场景，保留每次标准输出、标准错误和退出码。
- Chrome 验收保留 10 张状态截图，覆盖中文浅色、英文浅色、英文深色窄屏，以及未检查、有更新、忽略、失败、相同版本、不兼容、过期和检查中。
- 中断安装的真实进程树测试在当前 macOS 执行；Windows 使用受控 Job、独立取消管道及 PowerShell 引用实现，不能据此声称完成 Windows 实机升级验收。
- 尚未对公共 registry 中的新产品版本执行真实在线升级，不宣称任意未来数据库迁移、跨版本回退或所有 npm 生命周期脚本均已获实机验证。遇到安装或准备失败，保留备份、日志和服务实际状态供人工恢复。

源码安装、临时运行及无法确认依赖归属的 workspace 不自行覆盖；升级不自动修改宿主中的 Skill 副本。
