# 桌面／IDE SQLite 历史兼容

Type: task
Status: resolved
Blocked by:

## Scope

用户要求现有 CodeFlicker 桌面版同时兼容 `~/.codeflicker/data/codeflicker/` 的 SQLite 历史。保留 CLI 独立身份、新版主缓存与原始来源只读原则。

## Validation

逐会话发现和缓存、标题与工作区元数据、完整／简易消息、工具与读写证据、SQLite WAL 更新、来源删除、人工端到端及本机原始数据核对。真实资料仅留在忽略目录。

## Answer

现有桌面版注册同时发现新版 JSONL 和旧 IDE SQLite。SQLite 以真实文件路径和原生会话选择器逐会话索引，支持主历史、正式标题与工作区、早期关系表问答、迁移副本去重和原始证据回查。CLI 保持独立。

207 项自动化回归及真实 Chrome 端到端通过；最后补充早期关系表消息变动指纹后，类型检查、后端构建和 7 项 SQLite 专项回归再次通过。本机只读核对 138 个会话、1,996 次工具调用、302 个带实际范围的成功读取，主库与标题库哈希保持一致。缺少明确工具终态或逐请求用量的记录保留未知／缺失。详见 [公开验收记录](../../../docs/validation/codeflicker-desktop.md)。
