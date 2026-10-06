# DeepSeek Harness 与 Pi 适配

Type: task
Status: ready-for-agent
Blocked by: 03

## Scope

实现两类事件历史的只读发现、解码、规范化、工具提取与原始证据回查，依据 [来源研究](02-source-research.md)。只修改两类适配器及其匿名测试。

## Acceptance

- DeepSeek Harness V3／V4 压缩记录及代际副本去重，委派／分叉继承、压缩摘要、尝试终态与缓存桶不混淆。
- Pi 树结构、最后已保存叶、分叉父文件、额外 usage 与压缩／分支摘要保留；工具专用用量不冒充模型用量。
- 两者 reasoning 是输出子集，不能重复加总；缺少最终标记时遵循可解释推断和中断规则。
- 本机真实来源能解码，回归样本覆盖工具、分支、压缩、继承和缺失。
