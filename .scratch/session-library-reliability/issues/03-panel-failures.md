# 正文画像时间线独立失败恢复

Type: task
Status: resolved

## 验收

遵循 ../spec.md 与实施计划，使用隔离合成数据验证。

## Comments

已由用户批准实施、测试与推送。

## Answer

对应修复及隔离回归已通过，具体检查见 docs/validation/session-history.md 的本轮记录。

补充验收发现并修复：重复点击当前查看模式清空展开状态；跨页定位因组件身份变化丢失时间线缩放。对应 Chrome 回归通过。
