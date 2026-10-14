# 刷新菜单与紧凑工具栏

Type: task
Status: resolved

## 目标

将会话库自动刷新与历史更新状态收进全局历史菜单，移除会话库独立动作行；总览标题、筛选及操作同排；外观弹层使用统一字号与控件高度。来源与缺口不在本次范围。

## 实施计划

1. 修改共享自动刷新控件与历史菜单，保留独立偏好、可见页面调度、全部客户端主按钮及局部检查。验证菜单键盘选择、关闭焦点、保存失败与更新中状态。
2. 修改会话库结构与总览工具栏。验证三栏工作区直接接在页头下，桌面同排、窄屏换行，筛选与阅读状态保持。
3. 修改外观弹层字号与按钮规格。验证中英文、深浅主题、预设切换及自定义颜色保存。
4. 更新相关浏览器断言与设计、使用文档；运行类型、翻译、构建、公开内容及浏览器检查。

## 相关文件

- `web/features/sessions/SessionRefresh.tsx`、`Sessions.tsx`、`session.css`
- `web/shared/ui/AutoRefreshControl.tsx`、`RefreshControl.tsx`、`refresh-controls.css`
- `web/features/overview/Overview.tsx`、`overview.css`
- `web/shared/ui/AppearanceMenu.tsx`、`appearance.css`
- `scripts/e2e-refresh-workflow.mjs`、`scripts/e2e-visible-auto-refresh.mjs`

## Answer

- 已将会话库自动刷新与更新时间合并到历史菜单，移除会话库动作行及全局独立状态图标。运行中仍可查看状态，重复手动检查禁用，失败保持可见。
- 桌面间隔子菜单与窄屏直接展开采用同一份独立偏好；总览工具栏同排，外观字号与控件高度统一。来源与缺口未修改。
- 16 项定向测试、10 组历史更新、12 组自动刷新、68 项总览、56 项外观及 4 项窄屏补充验证通过；类型、翻译、构建及公开内容检查通过。
- 验收方法与结果见 [刷新工作流验收](../../../docs/validation/refresh-workflow.md)。
