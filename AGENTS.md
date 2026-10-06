## Agent skills

### 主干开发

- 当前处于快速开发阶段，后续直接在 `main` 主干开发、测试、提交和推送，不主动创建开发分支。用户另有明确要求时，以新的要求为准。

### 前端统一组件

- 后续前端开发先复用项目现有的统一组件；新增同类交互不要在页面中另写一套控件。通用交互优先基于现有 Radix 组件封装，复用主题、尺寸、焦点及弹层规范。
- 普通枚举筛选统一复用 `web/FilterSelect.tsx`，底层采用 Radix Select；项目等选项较多的筛选复用 `web/ProjectPicker.tsx`，采用 Radix Popover 与 cmdk，支持名称及完整路径搜索。
- 日期选择统一复用 `web/DatePicker.tsx`，采用 Radix Popover 与 React DayPicker；沿用本机时区和 `YYYY-MM-DD` 筛选值，提供选择及清空入口。
- 新增同类筛选沿用这些组件，不再使用原生 `<select>`、`input[type="date"]` 或手写键盘、焦点管理。菜单高度受视口约束，内容独立滚动，通过 Portal 避免侧栏裁剪。
- 样式复用现有主题变量及 `web/filter-controls.css`，保持代码地图与会话库、深浅主题一致。鼠标点击使用轻微边框反馈，键盘 `:focus-visible` 保留明确焦点标识，不全局删除焦点轮廓。
- 保留明确的可访问名称、选中标记和 Escape 关闭后的焦点恢复；同名项目在选项中显示完整路径，不改变原筛选值或统计语义。
- 修改筛选后，以真实浏览器验证鼠标选择、键盘导航、搜索／空结果、长列表滚动、日期选择／清空、主题与窄屏定位；端到端测试通过角色和可访问名称定位控件，避免依赖原生标签。

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
