# 精简会话控件

Type: task
Status: resolved

## 任务

按规格精简会话入口，复用共享分页组件并完成合成浏览器验收。

## Answer

已移除左侧导入详情、标题来源详情和重复轮次数；共享 ResourcePagination 新增紧凑单行模式，会话列表及分组搜索均复用。轮次输入焦点描边贴合边界。

验证：check:web、check:i18n、check:public、build、git diff --check；23 项相关单元测试；e2e-session-usability 与 e2e-page-request-performance 通过。合成浏览器验收覆盖桌面、390px、中英文、深浅主题、页码非法输入与首末边界、回车及按钮跳页、轮次跳转和 Escape 焦点恢复。全局导入详情相关旧脚本已同步；完整 e2e-i18n 仅做语法检查，本轮未执行。

Impeccable 扫描提示既有 CSS 的 42 处问题，本次新增共享分页样式无提示；未扩大修改无关样式。截图保存在 .local/session-usability-e2e/。
