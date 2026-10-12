# 思考程度结构化采集

Type: task
Status: resolved

## 目标

将支持来源明确记录的思考程度绑定到请求，支持生效区间与默认缺失，不用 reasoning Token 倒推等级。保留原始字段取值，不因不同客户端枚举而补造映射，解析升级只失效受影响来源。

## Comments

- 必须覆盖 Codex 及现有确有明确字段的来源；不能把当前没有结构字段当成来源没有信息。
- 已增加消息与请求的 `reasoningEffort`；Codex 按 `turn_context.effort` / `reasoning_effort` 生效区间、Pi 按分支祖先 `thinking_level_change`、Qoder 按 `runtime-config.reasoningEffort` 绑定。
- Claude 助手明确 `effort` 与桌面镜像同一请求的明确设置已采集；CLI CodeFlicker 保留助手请求明确字段。null、缺失与未知来源不根据推理 Token 补档位。
- `reasoning-effort-v1` 只失效支持来源的会话解析缓存，普通快速刷新即可补齐，原始历史不回写。
- 验证：新增六项生效区间／分支／快刷回归，相关解析、速度与刷新测试共 82 项通过；服务端类型检查通过。

## Answer

支持来源的明确设置已绑定请求。重复请求快照保留请求开始时的首个已知设置，缺失首值才允许后续补齐，不被后来的设置改写。Codex、Claude、CodeFlicker CLI／Desktop 使用 `reasoning-effort-v2` 修订指纹，Pi 和 Qoder 沿用有效的 v1；迁移测试验证只重解析受影响来源，原始历史不回写。真实索引已完成升级，最终页面展示已知设置排行，未知数量保留在详情。
