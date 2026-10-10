# 工作台外观与连续阅读验收

整理日期：2026-10-11。实现范围为 `683c117` 的工作台与共享主题、`6209371` 的呈现细化与连续阅读。本页归档该轮已执行的检查，文档同步不视为重新执行浏览器验收。当前交互见 [使用指南](../usage.md)，呈现规范见 [设计系统](../../DESIGN.md)，数据边界见 [会话设计](../design/session-history.md)。

## 已执行的浏览器检查

检查使用 macOS、真实 Chrome、隔离后台与合成数据。各脚本覆盖范围不同，不将检查数量相加作为完整产品验收数量。

| 入口 | 已通过的范围 |
| --- | --- |
| [外观](../../scripts/e2e-appearance.mjs) | 53 项检查：六种预设、明暗模式、自定义极端颜色、共享偏好与旧设置迁移、16／32 像素主题图标、切换后状态保留；无页面运行错误。 |
| [地图加载](../../scripts/e2e-map-loading-layout.mjs) | 中英文 × 桌面／窄屏 × 会话／覆盖率加载，共 8 种场景；标题固定槽位中的加载反馈不使主内容移位。 |
| [会话可用性](../../scripts/e2e-session-usability.mjs) | 110 轮合成历史：紧凑轮次菜单、首末／前后轮、问题目录、来源浮层、搜索、复制、导出、焦点恢复，以及中英文与窄屏。 |
| [连续阅读与详情](../../scripts/e2e-session-reading.mjs) | 27 项检查：21 轮从末轮连续上滑至首轮、补载锚点稳定且无重复、664 条长轮记录、边界失败重试、用户与 AI 区分；全宽表格、下方详情拖动与键盘调节、比例重载保留、放大／返回／Escape、前后节点、长正文末尾可达、工具输入／结果切换、深浅主题及英文 390px 窄屏；无页面运行错误。 |
| [可见页面自动刷新](../../scripts/e2e-visible-auto-refresh.mjs) | 12 组场景：新版切换保留消息锚点，失败保留旧结果并可重试，末尾接续、分支切换、跨页轨迹定位，以及会话／地图独立刷新、状态保持、中英文与窄屏。 |

资源页另完成专项浏览器核对：桌面与窄屏、中英文管理导航、使用总览／本地资源、列表／地图和详情入口。该专项不代替完整资源管理写操作套件。

## 自动检查与边界

`6209371` 提交前的 `npm run check`、`npm run build`、`npm run check:public` 与暂存差异检查通过；构建仍有前端大包提示。连续窗口、阅读呈现、轨迹及会话存储共 60 项定向单元测试通过，不能据此声明该次完整测试套件已运行。

部分旧浏览器脚本仅同步了控件定位并通过语法检查，未重新执行全部场景。以上结论只覆盖列明的路径；不宣称所有客户端历史格式、全部资源管理写操作或完整无障碍认证均已验收。

原始报告和截图保留在本机忽略目录，公开文档只记录方法、结果及范围，不提交真实会话、机器路径或原始会话标识。

2026-10-11 文档同步另执行 `npm run check`、`npm run check:public` 与完整 `npm test`：624 项通过、0 失败、0 跳过。此次只修改文档，未重跑上述浏览器脚本；全量单元测试不能替代浏览器验收。

## 重放入口

需要 Node.js 24、Chrome 和可用的 `playwright-cli`。先构建，再按需逐个运行脚本；脚本建立合成来源与隔离数据目录，不使用日常历史。截图和报告写入被忽略的 `.local/`，不应加入提交。

```sh
npm run build
node scripts/e2e-appearance.mjs
node scripts/e2e-map-loading-layout.mjs
node scripts/e2e-session-usability.mjs
node scripts/e2e-session-reading.mjs
node scripts/e2e-visible-auto-refresh.mjs
```

定向单元测试可独立执行：

```sh
node --import tsx --test tests/session-reading-window.test.ts tests/session-reading-presentation.test.ts tests/session-trace.test.ts tests/session-store.test.ts
```
