# CLI 响应与行为修复

Status: resolved

用户已授权在 main 修复审计发现的13类问题，测试通过后提交并推送。本任务不发布 npm，不修改个人配置或停止现有用户后台。

## 已确认约定

- 默认CLI为轻量响应，默认人类格式是可读摘要/表格；--json仅改变格式。新增全局--full显式保留原完整API字段，供兼容和完整查询。
- CLI默认请求添加 response=summary；--full不添加。后台无此参数时保留Web现有API语义。此查询参数由公共HTTP输入校验识别，不改变统计、版本或筛选口径。
- 列表默认20条；移除contextSnapshots、usageReports、长诊断、重复会话等重字段，保留ID/版本/分页/后续读取定位。消息默认有界正文、明确textTruncated/offset等回读信息。
- profile默认统计摘要；steps/context/usageReports等明细通过section与分页读取（CLI profile --section summary|steps|context|reports|tools|resources；后台同参数），--full保持原形状。完整数据不删除。
- status/ready只返回状态、进度、关键计数、必要错误；gaps明细分页。价格get/set/refresh默认配置及目录摘要，增加pricing list用于分页/模型过滤。
- 各类写入/设置/刷新默认返回操作结果、稳定ID/版本/任务定位，不携带整个库。知识写入/审批的版本与确认摘要保持完整，不能丢失审批授权边界。
- 生命周期参数先校验再产生副作用；缺值全局参数不得吞后续flag；JSON stderr失败时保持可解析；pause --wait把请求暂停达到paused作为成功，而get --wait遇paused是否成功不混用。
- StoreError保留输入/来源错误；auto-refresh没有任务返回明确状态/原因且不改变调度；replay-evidence帮助与本地校验明确所有必需参数。
- 所有产品文案补中英文；JSON字段稳定不本地化。Skill/文档说明先搜索摘要，再按ID/版本回读，最后导出。

## 验收

1. 13类问题逐一有真实调用或正确层次回归；大量快照不使默认列表/单条消息元数据膨胀。
2. 无效restart保持原实例；无效ready保持停服；运行中start非法port拒绝；缺值参数JSON错误；Skill错误JSON单对象。
3. 三类pause --wait退出0且读回paused；不存在分支INVALID_INPUT；关闭策略auto-refresh明确跳过。
4. 默认输出、JSON、full、分页、长正文回读、版本绑定和写入状态读回；中英文、package外安装验证。
5. npm run check、test、test:cli、构建、公开检查及适当浏览器兼容检查；包外实际命令；工作区/远端读回。

完整原始证据仅本机.local/cli-audit；公开测试和文档使用合成数据。

## Answer

13 类问题已完成修复与回归，源码全量 1646 项、CLI workspace 37 项和实际安装包 21 组场景通过。实现、兼容约定及验收记录分别见 `docs/design/cli-responses.md` 与 `docs/validation/npm-cli-distribution.md`。任务 01—04 均已完成，交付范围不含公共 npm 发布及用户全局安装替换。
