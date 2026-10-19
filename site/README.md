# AgentManor 官网

独立的桌面产品介绍页。Three.js 实时渲染体素庄园，围墙外的游园路径连接池塘小桥、玻璃温室与藤架花境，四位 Agent 机器人围桌喝茶，蓝领结管家循环添茶。水面、涟漪与花穗共用场景暂停控制。网站只加载随站点构建的文件，产品预览来自隔离合成数据，不连接本机产品 API。

## 本地运行

```sh
npm ci
npm run dev:site
```

检查与生产预览：

```sh
npm run check:site
npm run check:i18n
npm run test:site
npm run build:site
npm run preview:site
```

输出为 site/dist，独立于产品 dist/web。通过 SITE_BASE_PATH 指定项目站点前缀，例如 SITE_BASE_PATH=/agent-manor/ npm run build:site。普通滚轮继续阅读页面；拖动庄园旋转，Control/Command 加滚轮缩放；聚焦画布后可用方向键和加减键。

桌面端到端验收运行 `npm run test:site:e2e`，需要本地 playwright-cli 和 Chrome；它以 /agent-manor/ 项目路径构建并验证镜头、键盘、语言、暂停、降级和十四张产品预览，诊断写入已忽略的 .local/manor-site-e2e/。

## 产品截图

```sh
npm run capture:site
```

脚本使用全新临时数据目录、明确的客户端根目录和人工历史，经真实产品后台解析并截图；不读取个人历史。需要本地 playwright-cli 和 Chrome。公开前仍需检查十四张截图。

## GitHub Pages

pages.yml 在 main 的官网相关变更时检查并构建。正式发布前，在仓库 Settings → Pages 选择 GitHub Actions，再手动运行 Manor website 工作流。需要后续自动发布时，将仓库变量 PAGES_ENABLED 设为 true。工作流不会更改仓库可见性或自动启用 Pages。

## 安装与 Agent 使用展示

安装面板面向公共 npm 交付：`npm install -g agent-manor`，然后 `am web` 启动本地后台并打开网页。页面不展示平台矩阵。

产品区包含总览、会话库、知识库 Beta、代码地图、用量统计和资源管理。代码地图可切换分布与回放预览，共七种画面、中英文十四张。知识与父子回放记录均来自隔离合成数据，截图不调用付费模型。

CLI 区展示会话与知识检索，并提供 Codex／Claude Code 的 Skill 安装命令及复制。历史处理在本地完成；可选知识提炼和语义搜索按用户的模型配置请求服务。

页面内容按发布后的安装流程编排；构建、代码推送不会执行 npm 发布、启用 Pages 或修改仓库可见性。
