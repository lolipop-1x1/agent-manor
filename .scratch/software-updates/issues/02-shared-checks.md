# 安装级版本检查与提醒状态

Type: task
Status: resolved

## 范围与验收

实现 docs/design/software-updates.md 的共享版本、缓存、设置与提醒规则。模块由 Web 和 CLI 共用，支持依赖注入 mock，不增加生产 registry 覆盖开关。覆盖 SemVer、兼容性、正负缓存、超时与失败保留、并发、多安装与多目录、关闭及忽略版本、中英文诊断。

## 结果

- `src/service/releases.ts` 提供共享 ReleaseService，发布地址固定为官方公共 registry。设置按规范化安装路径和当前用户保存；设置、缓存和提醒分别原子写入，安装目录与文件分别使用当前用户权限。
- 支持严格稳定 SemVer、Node engines／系统／架构兼容性，24 小时正负缓存与失败尝试节流，5 秒超时、旧结果保留、安装级检查互斥与并发请求合并。
- 只有有效新结果触发自动提醒；同版本 24 小时去重，忽略、恢复和进程覆盖不会改变发布判断。显式版本不覆盖 latest 缓存。
- 更新文案使用 `updates` 中英文目录，Web 使用独立 `updateUi` 目录；引用检查纳入新目录，并排除历史适配器中的已知原始文件名。

## 验证

- `node --import tsx --test tests/release-checks.test.ts tests/i18n.test.ts`：42 项通过，其中共享检查 36 项；包括真实独立子进程的检查合并与提醒互斥。
- `npm run check:server` 与 `npm run check:i18n` 通过。
- 所有测试注入隔离目录与 fetch，不访问公共发布源或真实用户设置。CLI 安装与 Web 界面的整体验收由后续任务完成。
