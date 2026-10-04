# Chrome 页面资源被误拒绝导致黑屏

Type: task
Status: resolved
Blocked by: 11

## Scope

修复真实 Chrome 请求的 Origin 丢失端口时，后台拒绝脚本和样式导致页面黑屏的问题。保留本机 Host 校验和跨站请求边界。

## Acceptance

- 同主机无端口 Origin 仅在 Sec-Fetch-Site=same-origin 且 Referer 精确匹配当前服务源时兼容。
- 普通同源请求仍通过；异站、异端口、空源、缺少同源证据的请求仍拒绝。
- 回归先复现 403，再通过；真实 Chrome 显示地图且可以刷新。

## Comments

- 2026-10-04：用户反馈 4317 黑屏。真实 Chrome 脚本请求 Host=127.0.0.1:4317、Origin=http://127.0.0.1、Referer=http://127.0.0.1:4317/、Sec-Fetch-Site=same-origin，响应 403；直接 HTTP 和内置浏览器可加载。

## Answer

- 兼容范围限制为同协议、同主机且无端口的 Origin，并同时核对浏览器 `same-origin` 标记和 Referer 的完整源。其他 Host、Origin、跨站写入和实例校验保持有效；不返回宽泛的 CORS 允许头。
- 回归在旧实现上复现 `403 !== 200`；修复后 HTTP 五项回归、类型检查和生产构建通过。覆盖页面、API 查询、真实 Worker 刷新，以及缺失/伪造同源线索、异站、异端口和无效源的拒绝路径。
- 4317 服务已重启。实际用户 Chrome 中地图和统计恢复；点击“刷新分析”显示“刷新完成”，发布新版本 `historical-source-redacted`。关闭排查用开发者工具，保留页面。
- 重启时曾因诊断启动器的 `--input-type=module` 被 Worker 继承而刷新失败，已换成正常文件入口并复测启动检查和页面刷新成功；这不是产品 CLI 的启动方式。
- 目前确认请求头丢失端口，未定位是哪个浏览器扩展或环境修改了它；兼容判断依据见 [W3C Fetch Metadata](https://www.w3.org/TR/fetch-metadata/#sec-fetch-site-header)。不把 HTTP 200 单独当作页面渲染验收。
