# 地图优先 Web 与证据下钻

Type: task
Status: resolved
Blocked by: 02

## Scope

责任文件：web/、tests/web*.test.ts。
参考 codex/activity-map-prototype 的 VariantA，重新实现正式页面。React／D3／CodeMirror 6／Radix。无示例数据，无原型切换器；服务未就绪时围绕共享协议构建，最终真实 API。

## Acceptance

登记／选择仓库、客户端／时间／类别／目录筛选、读取／修改／次数地图、代码高亮与事件／原始证据、手动关联、缺口、刷新进度／失败旧版、过期内容。面积为行数，精确／近似分开；桌面／窄屏／明暗／键盘可用。

## Comments

- 2026-10-03：采用已确认首版规格，自行实现。

## Answer

- Web 实现提交：`b11a4803d96cfbf878cf28d67083e44f3e48b6f3`；独立分支以 `--no-ff` 合并，合并提交：`fa0a67114975665347c9845a1b774e649caf4d1a`。已有共享契约内容自动合并，未产生额外差异。
- `npm run check:web`、`npm run build:web`、`node --import tsx --test tests/web*.test.ts`（5/5）和合并差异 `git diff --check` 均通过。
- 验证覆盖类型、生产资源构建与 Web 数据模型；真实 API 联调、桌面／窄屏、明暗、键盘和真实浏览器交互尚待验收。构建提示 CodeViewer 压缩后资源略大于 500 kB，未阻断构建。
