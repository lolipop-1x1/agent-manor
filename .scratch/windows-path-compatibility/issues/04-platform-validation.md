# Windows 运行与平台验收

Type: task
Status: needs-triage

## TODO

- 修正安装测试中的 `.cmd` 启动方式与硬编码路径分隔符。
- 核验真实包外安装、原生 SQLite、CLI、后台服务启停及 Web 入口。
- 增加 Windows 原生自动化验收，并在 macOS／Linux 验证外来 Windows 历史路径。
- 按各适配任务确定测试范围，保留未验证环境、客户端版本和能力缺口。
- 仅在相应功能通过原生 Windows 验收后更新平台支持说明，不能用静态分支或合成路径测试替代完整运行验收。

## Comments

- 当前暂停。已有跨平台代码不构成 Windows 支持承诺；当前支持 macOS，暂未兼容 Windows。
