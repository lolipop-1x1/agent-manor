# 回放播放器、多轨与地图联动

Status: complete

## 范围

负责 `web/features/code-map/ActivityReplay.tsx`、新增回放组件／样式／纯模型、`web/features/code-map/CodeMap.tsx` 必要扩展及回放纯模型测试。可新增独立 `replay.zh-CN.ts`、`replay.en.ts` 文案文件，由主实现者接入目录。

## 上下文

先读 `../spec.md`、`../design.md`、`DESIGN.md`、Impeccable `reference/craft-floor.md`。最终静态参考在 `.local/design/session-code-replay/activity-replay.png`。不是像素贴图，复用真实地图、主题、共享控件与可访问交互。

## 集成契约

导出 `ActivityReplay`，props 为 `{ repositoryId: string; active: boolean; theme: Theme; targetSessionId?: string; onSession(target: {sessionId: string; messageId?: string}): void; onTargetChange?(sessionId: string): void }`；Theme 使用项目已有 light/dark 类型。数据类型见 `src/replay-contracts.ts`，接口见任务 01。

## 要求

- 搜索会话选择、主／子轨、共同历史时间／播放头、播放暂停、慢速倍速、前后活动、拖动、长空档共同折叠；有边界的轨道纵向／横向滚动。
- 保留累计痕迹与并行当前高亮，同次调用多文件一组；颜色辅助轨道、形状区分活动。缺时间独立访问。
- 显式点选才请求证据并暂停；播放高亮不驱动文件详情网络请求。地图布局固定，向后定位正确清除未来痕迹。
- 只读活动证据、查看原始记录及回到消息。没有映射的路径仍可访问。
- 切页／隐藏网页暂停；切 Tab 保留目标与位置；后台版本变化不替换当前播放。
- 中英、深浅主题、窄屏、键盘、减少动态效果、加载／失败／重试／无活动。
- 纯模型用二分和可复用索引处理时间定位、空档映射与累计状态，避免每帧扫描全部事件／文件。

## 验证

纯模型测试、check:web。不要修改 CodeMapPage、App、Sessions 或共享目录注册，主实现者负责。

## Comments

- 用户已授权直接 main 开发与最终推送，所有实现者在共享 main 上按文件所有权协作，不创建分支／worktree、不自行提交推送。

- 已完成播放器、目录搜索范围、同刻完整候选、同版进度保存、分隔线空间联动与固定版本证据返回；6 项模型测试与完整浏览器验收通过。两轴审查的诊断翻译、英文复数与键盘空档帮助已修复。

- 最大真实 363 轨样本暴露通高动态层的 GPU 开销。将动态层限制为滚动视口，按纵向滚动移动可见段，保留全部轨道；同时缓存静态轨道、断轴、标尺及会话选择器。正式浏览器复测 120 次帧回调均值约 6.94 毫秒、95 分位约 7.1 毫秒，所有 API 请求为零。新增完整原生合成 363 轨压力回归，验证末轨、缩放、空档帮助、焦点及精确滚动高度。
