# 语言目录、格式与共享偏好基础

Type: task
Status: resolved
Blocked by: 01

## 目标与范围

建立 src/i18n/ 共享目录、消息标识／参数契约、语言注册、回退与格式工具；实现按数据目录持久化的手动语言偏好与本地服务读写入口。核验并锁定公开依赖版本，不加入远程翻译服务。

## 验收

- 简中／英文的检测、回退、插值与复数可验证，启用语言有完整目录、日历／格式配置；运行时不展示裸露翻译键。
- 目录检查发现缺失键、参数或复数不匹配时失败；各后续模块向同一目录补齐文案。
- 手动偏好与自动模式可读写，数据目录隔离，重启／清索引后保留，失败如实反馈。
- 返回设置及消息描述不改变已有机器字段；偏好更新不触发索引或其他管理写操作。
- 覆盖正常写入、保存失败、自动检测及不同目录的合成测试。

## Answer

已实现共享基础，页面、CLI 与产品诊断迁移由后续任务接入：

- `src/i18n/` 提供 `Language`、`LanguagePreference`、`MessageDescriptor`、语言注册表、顺序语言检测、`translate`／`translateMessage` 与数字、百分比、日期时间格式工具；纯浏览器可用入口不依赖 Node 文件或设置模块。
- 中英文使用共用、代码地图、会话、资源、诊断和 CLI 六个独立目录，稳定消息标识采用所属目录前缀。`npm run check:i18n` 已并入 `npm run check`，检查消息、参数、本语言复数、目录及格式／日历配置；运行时缺失先回退英文，未知键采用英文通用提示。
- 公开 npm 依赖固定为 `i18next@26.4.2` 与 `react-i18next@17.0.16`；React 绑定的 peer 范围兼容当前 React、TypeScript 及 i18next。两者只使用本地目录，不配置远程翻译服务。
- `src/service/preferences.ts` 按服务现有 `dataHome` 在独立 `preferences.json` 保存手动选择；自动模式保存空对象去掉覆盖。写入使用 0600 临时文件与原子替换，失败不返回成功；GET／PUT `/api/v1/preferences` 沿用现有输入、Host、Origin 与错误契约，不触发分析任务。
- 10 项合成测试覆盖语言系列／未支持语言、插值／复数／英文回退、格式与输入稳定、目录负例、目录隔离、损坏与保存失败、真实 HTTP 安全契约、服务重启、清索引及派生数据库移除后保留。真实 HTTP 测试在隔离目录运行。

验证通过：`npm run check`、`npm run check:public`、`npm run build`，以及 `node --import tsx --test tests/i18n.test.ts tests/preferences.test.ts`（10/10）。构建仍有既有大体积 chunk 提示。浏览器语言菜单、CLI 覆盖优先级与完整模块目录由 03–08 后续实施及验收。

## Comments
