---
status: accepted
date: 2026-10-19
---

# 独立 CLI 工程与统一产品交付

CLI 使用独立的工程、命令模块、构建配置与测试边界；对外由一个 npm 产品包统一交付 CLI、本地后台、Worker、已构建 Web 与配套 Skill，保持同版本。独立工程用于维护完整的命令行能力，统一交付使用户一次安装即可使用网页和 CLI，也便于校验前后端、任务协议及 Skill 命令的一致性。

CLI 延续 TypeScript 与 Commander.js，在 `packages/cli/` 形成内部私有 workspace；框架负责命令解析与帮助，服务连接、任务等待、输出和管理确认使用产品自己的公共层。沿用已有框架与共享契约，避免因工程拆分重写同一套命令行为；业务读写仍由本地后台 API 承担。

首版分发编译后的 JavaScript 和 Web 资源，用户使用 Node.js 24 运行。根产品构建收集各工程产物，`agent-manor` 与 `am` 共用 `dist/cli.js` 入口；内部 workspace 不成为用户需要另装的公开包。该选择沿用 [ADR 0003](0003-typescript-and-sqlite.md) 的运行时要求，减少内置运行时、原生依赖和多平台可执行文件的额外分发工作。

本轮不分别发布需要用户组合安装的 CLI、后台和 Web 包，避免安装顺序与版本搭配成为使用前提。具体工程职责、打包和验收见 [交付设计](../design/npm-cli-distribution.md)；本决定不表示公共 npm 发布、跨平台安装或升级验收已经完成。
