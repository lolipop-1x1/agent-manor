# 总览与模型用量

用于了解近期工作、项目投入、模型成本和计价依据。

- `am overview snapshot --json` 取得完整快照。按帮助选择日期、客户端和项目，再用 `panel`、`review`、`review-detail`、`detail`、`report`、`evidence` 逐层核对。保留同一数据版本，不能混合不同刷新代次。
- `am usage report --json` 查询用量；`am usage requests --json` 查请求明细，`am usage status --json` 查看准备进度。
- `am usage pricing get --json` 读取价格和覆盖依据，此业务读取可能触发已有价格更新。`pricing refresh` 显式刷新；调整映射或价格用 `pricing set --input <file> --json`，先核对用户授权和参数帮助。

稳定 JSON 的原始值与单位为准。原生 Token、留存文本估算、缺失值分别表达；未知不填零。估算费用需要保留单价、缓存覆盖和币种，不能由对话文本量推断真实账单。

首 Token、首文本和工具输出边界不同；只有具备可靠起点与首响应字段时才报告真实 TTFT。日期、客户端和项目筛选必须在下钻保持一致，零分母不生成百分比。
