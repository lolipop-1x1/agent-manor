# HTTP 索引写入异步化

Type: task
Status: resolved

用独立轻量命令 Worker 承担任务管理及索引短写；跨进程持锁时验证状态响应，保留原 API 和发布边界。

验证：全量 1767 项、CLI 专项 45 项、构建、国际化、公开内容检查及真实安装运行通过。详见 `docs/validation/backend-task-isolation.md`。
