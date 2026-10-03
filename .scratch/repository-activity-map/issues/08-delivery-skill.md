# npm 交付与 Agent 查询 Skill

Type: task
Status: resolved
Blocked by: 06, 07

## Scope

责任文件：skills/agent-manor/、README.md、docs/usage.md、tests/install*.test.ts。
从 npm pack 产物安装运行，验证 CLI／后台／Worker／Web 资源，提供 Agent Skill。说明支持矩阵／缺口、Node 24／Git、缓存位置、清缓存与停止。

## Acceptance

包外目录安装无需再构建；macOS Apple Silicon 后台与 SQLite 成功。独立 Agent 按 Skill 完成覆盖率 JSON、文件和证据回读。真实历史不上传、不提交。不发布 npm、不合并 PR。

## Answer

- 2026-10-04：实现提交 `98a849ff707855c02fe30358d71b313b88eef34d`，合并提交 `0a4286ef99d061f0ce26c50d2a14ebcac82050a9`。交付 Skill、README、完整使用指南与真实安装回归，说明 Node 24／Git、支持矩阵、筛选和结果版本、采集缺口、缓存位置、清缓存／停止及隐私边界。
- 根代理明确授权扩展两项责任范围：`package.json` 仅追加使用指南与三份设计支持／规则文档的 `files` 白名单，未修改 private／license 等其他配置；`src/cli.ts` 仅修复 npm bin 符号链接入口判断。旧入口按未解链接的 argv 路径比较，导致 npm `.bin/agent-manor` 空输出退出；修复后以可控 realpath 确认，入口不可解析时普通导入没有副作用。
- 在空包外目录真实 `npm pack`／`npm install --omit=dev`，使用官方 registry 与临时 npm 缓存；macOS darwin/arm64、Node v24.19.0。tarball 含 77 个交付文件，包含编译 CLI／后台／Worker／正式 Web／Skill／用户文档，不含 src／tests／.scratch；安装后的 Markdown 相对链接全部可达。安装用户没有 TypeScript／Vite，不需要再构建；better-sqlite3 实际执行 SQL，后台与 Worker 从安装产物加载。
- 真正 npm `.bin` 在无关 cwd 完成版本、register --wait、coverage、file、events、evidence、refresh --wait、cacheclear --wait、web --no-open、status 和 stop。两客户端合成来源、同版本下钻、原记录回读与原始来源字节不变均验证；正式 Web 首页和打包 JS 经 HTTP 可用，停止后再次 stop 不启动后台。
- 独立 real_index Agent 仅按安装包 Skill 完成 repositories → coverage → file → events → evidence，同一结果版本；人工样本 3 文件 6 行、精确读取 2 文件 5 行，成功回读 2 条原始记录并 stop。未保存原始正文；独立验收证据由 09 集成记录。
- 合并树 `npm run check`、`npm run build`、`npm test`、`git diff --check` 通过，实际共 83 项测试，包含重新打包与真实安装回归；Skill quick_validate 通过。普通导入与不存在 argv 入口无副作用已回归。
- 未发布 npm、未合并 PR。Windows／Linux 安装未验证；Vite 的 CodeMirror 502.55 kB 分包提示保留。真实浏览器、真实个人历史业务验收与最终审查由 09 汇总，不用安装测试替代。

## Comments

- 2026-10-03：采用已确认首版规格，自行实现。
