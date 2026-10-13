# AgentManor 官网

独立的桌面产品介绍页。Three.js 实时渲染体素庄园，四位 Agent 机器人围桌喝茶，蓝领结管家循环添茶。网站只加载随站点构建的文件，产品预览来自隔离合成数据，不连接本机产品 API。

## 本地运行

```sh
npm ci
npm run dev:site
```

检查与生产预览：

```sh
npm run check:site
npm run check:i18n
npm run build:site
npm run preview:site
```

输出为 site/dist，独立于产品 dist/web。通过 SITE_BASE_PATH 指定项目站点前缀，例如 SITE_BASE_PATH=/agent-manor/ npm run build:site。普通滚轮继续阅读页面；拖动庄园旋转，Control/Command 加滚轮缩放；聚焦画布后可用方向键和加减键。

## 产品截图

```sh
npm run capture:site
```

脚本使用全新临时数据目录、明确的客户端根目录和人工历史，经真实产品后台解析并截图；不读取个人历史。需要本地 playwright-cli 和 Chrome。公开前仍需检查八张截图。

## GitHub Pages

pages.yml 在 main 的官网相关变更时检查并构建。正式发布前，在仓库 Settings → Pages 选择 GitHub Actions，再手动运行 Manor website 工作流。需要后续自动发布时，将仓库变量 PAGES_ENABLED 设为 true。工作流不会更改仓库可见性或自动启用 Pages。

安装面板的 npm install -g agent-manor 与 agent-manor start 是明确标注的规划占位。当前安装方式和平台支持以产品使用指南为准；本官网不改变 CLI 或 npm 发布状态。
