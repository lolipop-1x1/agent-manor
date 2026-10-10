# 规范与规格双轴代码审查

Type: task
Status: resolved
Blocked by: 05

以实施前提交作为固定基线，分别审查仓库规范及完整规格。整合问题后由一个实现子任务修复，完成必要回归和最终交付检查。

## Comments

- 用户要求直接在 `main` 开发，审查实际工作区或已提交 diff。
- 固定基线为实施前提交 `f1f9f8abc88c5c29f53dde6f811d04c7c5d002c7`，审查 `git diff <基线>...HEAD`。
- 两轴有效问题由同一实现子任务修复：`WorkerManager.finished` 在完成通知后释放对应取消缓存，`failed`（含关闭）释放所有取消缓存；通知前的新等待者仍取得取消结果。同 ID 的登记状态由已有版本退回无版本时，复用页面作用域清理、递增请求 epoch，并重挂载来源弹窗，使旧地图、详情、会话和迟到响应失效。
- 后台生命周期测试增加完成通知前／后取消结果及缓存释放检查，覆盖真实 Worker 异常终止和关闭边界；生命周期、HTTP 和 Web API 相关回归 24 项通过。完整类型／翻译检查及服务端／前端构建通过，日志保存在 `.local/repository-lifecycle-e2e/review-tests.log`、`review-check.log` 与 `review-build.log`。
- 同路径复用 ID 的组合浏览器回归验证真实排队、发布失败及恢复分析三种状态，旧地图／文件／会话选择和列表不恢复，新版本自动加载。扩展后的 11 组真实 Chrome 验收全部通过；新增三张截图已人工查看，公开方法与结果见 `docs/validation/repository-lifecycle.md`，详细日志、结果 JSON 和截图留在已忽略的 `.local/repository-lifecycle-e2e/`。

## Answer

### Standards

未发现文档规范违例。发现 1 项 P2 判断性问题：取消结果在 Worker 完成后无界保留，属于可能的 Speculative Generality。修复后完成通知、失败和关闭都会释放缓存，通知前的等待者仍正常收束；真实 Worker 边界测试通过。

### Spec

发现 1 项 P2 实现错误：另一标签页在两次状态检查之间删除并同路径重登时，复用仓库 ID 使旧地图未清理。修复后版本退回无结果会重置整个页面作用域。真实排队、发布失败与恢复分析的组合浏览器回归通过。

两个轴各 1 项问题，各自最严重级别均为 P2；全部修复，无未处理问题。主任务已核查修复 diff、后台结果和关键截图，完整自动测试 638 项全部通过。
