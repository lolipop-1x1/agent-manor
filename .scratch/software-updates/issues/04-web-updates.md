# Web 版本与更新入口

Type: task
Status: resolved
Blocked by: 02

## 范围与验收

增加紧凑页头入口及共享对话框，展示版本、检查、设置、忽略和复制命令，不提供网页安装能力。复用产品视觉、动效与焦点规范，保持页面阅读状态，覆盖中英文、深浅主题与窄屏。

## Answer

- `web/features/updates/SoftwareUpdates.tsx` 与 `updates.css` 实现页头入口、Radix 对话框及检查、设置、忽略／恢复、命令复制。状态读取与主动联网分离，保留旧结果，失败可重试，复用主题、动效和焦点规则。
- `update-model.ts` 统一可见提醒与版本状态表达，避免把失效、失败或未知结果显示为最新版；忽略不会修改版本关系。
- `src/i18n/locales/{en,zh-CN}/update-ui.ts` 提供完整双语文案，目录由共享模块任务注册。
- `tests/software-updates-ui.test.ts` 四项定向测试通过，Web 类型检查通过。完整真实 Chrome 交互及截图由集成验收任务覆盖，截图只写入本机忽略目录。
