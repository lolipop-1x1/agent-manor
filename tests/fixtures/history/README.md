# 历史适配器合成样本

全部 JSONL 由测试作者创建，只使用 `/synthetic/repo`、固定日期与合成源码；不包含个人日志、真实账户、仓库内容或历史命令输出。测试从不执行记录里的命令。

- `codex-modern.jsonl`：具体命令、file URI cwd、exec 外层、真实重复调用形态、失败搜索、多文件 FileChange。
- `codex-legacy.jsonl`：旧式 function_call、文本退出码头、sed 范围。
- `claude-tools.jsonl`：实际返回范围、调用 ID 重用、结构化编辑、纯删除、覆盖写入、失败 Bash。
- `codeflicker-native.jsonl`：原生顶层 message/content、成功 read JSON 文本、SDK EOF、edit/write 差异返回；返回模板核对安装的 CLI 执行器后匿名重建。

完整记录边界、半个 Unicode 字符的未完成尾行、追加回填、替换、来源移动、fork 引用与复制、重复 uuid、歧义 ID 重用及错误 Read 计数字段由测试在临时目录生成。
