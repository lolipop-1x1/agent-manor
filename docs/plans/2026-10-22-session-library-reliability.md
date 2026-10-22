# 会话库可靠性修复 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复已确认的分页、局部请求失败和跨时区日期筛选缺陷，补齐回归并验证主干交付。

**Architecture:** 保留现有会话库、统一控件和固定版本查询。列表只在页码越界时校正；搜索组按查询范围复位；正文、画像与时间线在各自请求边界处理错误并核验版本。

**Tech Stack:** TypeScript、React、Fastify、SQLite、Node.js test、真实 Chrome。

---

## 1. 跨时区日期筛选

- 修改 `src/sessions/store.ts`，在 `tests/session-search-scope.test.ts` 经查询及 HTTP 验证旧参数和统一范围一致。
- 先运行偏移时区的起止边界测试确认失败，再统一日期比较；覆盖列表、记录搜索、分组搜索及未知时间。

## 2. 列表与组内分页

- 修改 `web/features/sessions/Sessions.tsx` 和 `SessionSearchGroups.tsx`。
- 新增 `scripts/e2e-session-reliability.mjs`，使用隔离发布版本复现普通列表及全局搜索越界、过程范围收窄后组内命中空白。
- 请求完成前保留旧完整结果；有效页不因版本变化回到首页，失效页重读；旧请求取消。

## 3. 局部请求与错误状态

- 修改 `Sessions.tsx`，分别提交同版本正文、画像和时间线；分别提供失败和重试。
- Chrome 注入画像、消息、时间线错误及版本不符，验证其他面板可用、旧模式不串入、失败不显示零节点，快速切换取消旧响应。

## 4. 回归脚本与交付

- 更新 `scripts/e2e-sessions.mjs` 的完整 CLI 输出与统一筛选定位，以及 `scripts/e2e-session-trace-zoom.mjs` 的聚合轨迹断言。
- 更新 `tests/auto-refresh-service.test.ts`，等待可观测的后台状态，不依赖保存偏好后的单次请求时序。
- 顺序运行构建、类型/翻译检查、专项和限并发全量测试，再运行 Chrome 脚本；避免构建过程覆盖浏览器正在使用的产物。
- 将合成验证结果记入会话验收文档；执行公开内容与差异检查，显式暂存本轮路径，提交并推送 origin/main，回读 SHA、ahead/behind 和工作区状态。
