# 删除接口与登记复用

Type: task
Status: resolved
Blocked by: 01

依据 [规格](../spec.md) 和 [共同契约](../map.md)，拥有 `src/server.ts`、必要的 `src/cli.ts` 响应适配、`tests/service-http.test.ts` 与 `tests/web-api.test.ts`。新增删除接口，复用后台提供的方法；重复登记不启动分析，子目录与 worktree 继续遵循现有解析。不要更改公共契约文件。

验证接口输入、旧任务查询、删除后的查询和重启状态、全局会话与资源保留、重复登记及子目录／worktree，使用隔离合成资源。后台方法落地前可准备接口和测试，集成检查等后台完成。

## Comments

- 与其他任务共享 `main`，不得撤销他人修改；公共契约由主任务维护。

## Answer

- `src/server.ts` 新增 `DELETE /api/v1/repositories/:id`，空请求体校验后调用 Worker 的仓库删除方法，并返回 `repositoryId`。已删除仓库和旧任务遵循既有对象不存在错误契约。
- 登记接口采用 `registerRepositoryResult`，只为新登记仓库创建分析任务；重复登记返回已有仓库且省略 `job`。CLI 既有等待逻辑仅在存在 `job` 字段时执行，无需改动。
- `tests/service-http.test.ts` 用隔离合成 Git 仓库与历史验证重复登记不产生任务、子目录归根、worktree 独立登记、八张仓库专属表全部清理、其他仓库和全局会话／资源收藏保留、原始文件保留、服务重启不复现已删除仓库、同路径重登重新分析及旧任务仍为 404，并覆盖请求体和跨站写入校验。
- `tests/web-api.test.ts` 验证无任务登记响应、删除请求及不存在仓库错误契约。
- `node --import tsx --test tests/service-http.test.ts tests/web-api.test.ts`：15 项全部通过；`npm run check:server` 与本任务文件的 `git diff --check` 通过。未操作真实运行数据库，未提交或推送。
