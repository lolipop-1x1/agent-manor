## Agent skills

### 公开内容边界

- 本仓库面向开源。代码、文档、任务记录、提交消息、图片及发布包不得包含真实个人姓名、私人邮箱、本机用户路径、公司内部域名、业务仓库名称、业务源码或原始会话标识。
- 示例与测试使用人工合成数据、`example.invalid` 地址和通用路径；真实历史验证只公开方法、结论与必要的支持边界，详细输入和截图留在本机 `.local/` 或仓库外。
- 公开客户端、开源项目和依赖的名称、官方链接可以保留。依赖必须使用公开 registry，不写公司镜像地址。
- 提交前执行 `npm run check:public`，并人工检查新增图片及 Git 作者信息。公开检查不替代图片和 Git 历史审查。
- 已推送的隐私信息必须同时评估历史中的副本；重写历史与强制推送应在列明影响后取得明确授权。

### Issue tracker

使用本地 Markdown 跟踪任务，存放于 `.scratch/<feature>/`。
具体约定见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认的五种分诊标签。
角色映射见 `docs/agents/triage-labels.md`。

### Domain docs

采用 single-context：根目录 `CONTEXT.md` 与 `docs/adr/`。
读取规则见 `docs/agents/domain.md`。
