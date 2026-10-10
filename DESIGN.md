---
name: AgentManor
description: 克制、精确、层次清楚的开发者工作台
colors:
  page: "#ffffff"
  surface: "#ffffff"
  surface-alt: "#f3f6fb"
  text: "#19273c"
  muted: "#5c6c82"
  border: "#dce4ef"
  accent: "#3267d2"
  accent-soft: "#e8eefa"
  on-accent: "#ffffff"
  near: "#86651b"
  map-0: "#f4f7fd"
  map-1: "#dce5f8"
  map-2: "#b9ccf0"
  map-3: "#88a7e6"
  map-4: "#3268d4"
  code-exact: "#e0e8f8"
  code-near: "#f5eedb"
  danger: "#a23e35"
  danger-bg: "#fff0ed"
  accent-hover: "#2c5bb9"
  map-strong-text: "#ffffff"
  map-0-text: "#000000"
  map-1-text: "#000000"
  map-2-text: "#000000"
  map-3-text: "#000000"
  map-4-text: "#ffffff"
  page-dark: "#111722"
  surface-dark: "#171d28"
  surface-alt-dark: "#1d2635"
  text-dark: "#e7edf7"
  muted-dark: "#a6b4ca"
  border-dark: "#334057"
  accent-dark: "#678fdf"
  accent-soft-dark: "#202a3c"
  on-accent-dark: "#111722"
  near-dark: "#e0bc6e"
  map-0-dark: "#1a2232"
  map-1-dark: "#212d46"
  map-2-dark: "#2a3e65"
  map-3-dark: "#37558f"
  map-4-dark: "#4f7dda"
  code-exact-dark: "#232e43"
  code-near-dark: "#3e3824"
  danger-dark: "#f4aa9f"
  danger-bg-dark: "#3a2520"
  accent-hover-dark: "#799ce3"
  map-strong-text-dark: "#111722"
  map-0-text-dark: "#ffffff"
  map-1-text-dark: "#ffffff"
  map-2-text-dark: "#ffffff"
  map-3-text-dark: "#ffffff"
  map-4-text-dark: "#000000"
typography:
  title:
    fontFamily: '"Geist Variable", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 22px
    fontWeight: 550
    letterSpacing: -0.5px
  section:
    fontFamily: '"Geist Variable", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 19px
    fontWeight: 550
    letterSpacing: -0.4px
  message-body:
    fontFamily: '"Geist Variable", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 14px
    lineHeight: 1.75
  control:
    fontFamily: '"Geist Variable", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 12px
    fontWeight: 500
  filter:
    fontFamily: '"Geist Variable", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 11px
  label:
    fontFamily: '"Geist Variable", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 10px
  metric:
    fontFamily: '"Geist Variable", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 25px
    fontWeight: 500
    letterSpacing: -0.7px
  mono:
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
rounded:
  map-tile: 3px
  compact: 4px
  control: 5px
  filter: 6px
  resource-card: 7px
  overlay: 8px
spacing:
  option-inset: 4px
  control-gap: 7px
  inline-gap: 8px
  group-gap: 12px
  section-gap: 16px
  desktop-gutter: 22px
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: 8px 11px
  button-neutral:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: 8px 11px
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: 8px 11px
  filter-trigger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.filter}"
    rounded: "{rounded.filter}"
    padding: 0 10px
    height: 34px
  resource-search:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.filter}"
    padding: 8px 10px
  product-navigation:
    backgroundColor: transparent
    textColor: "{colors.muted}"
    rounded: "{rounded.filter}"
    padding: 9px 14px
  resource-tag:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.compact}"
    padding: 3px 6px
  message-card:
    backgroundColor: transparent
    textColor: "{colors.text}"
    rounded: 0px
    padding: 16px 18px 22px
  metric-tabs:
    backgroundColor: "{colors.surface-alt}"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: 2px
---

# Design System: AgentManor

## Overview

**Creative North Star: "开发者工作台"**

把会话、代码和资源组织为同一张工作台上的不同工具。界面以克制、精确、层次清楚为气质，支持密集信息和连续操作。默认以纸白、午夜墨色与清晰蓝色建立品牌辨识；六种预设与自定义配色共享同一套布局。

工作区以平面为主，依靠页面、面板和次级底色建立区域关系，细边界帮助扫描。按钮、筛选、列表和容器紧凑、克制、反馈明确；临时浮层使用阴影说明其与底层内容的关系。

本文件记录用户确认的工作台改版。基础中性色来自 CSS，默认主题色由 src/appearance.ts 派生。验收使用隔离合成数据；覆盖范围见 .scratch/workbench-redesign，不将局部对比度测试等同于全面无障碍认证。

**Key Characteristics:**

- 纸白与午夜墨色构成工作区，主题色用于操作与选中，赭金和砖红承担独立语义。
- 信息密集，字号与留白按任务分配，没有统一的等比字号阶梯。
- 细边界、小圆角、平面内容区域和临时浮层阴影。
- 筛选、选中、聚焦和异常状态有可辨认的反馈。
- 深浅主题与窄屏布局沿用同一套任务结构。

依据：[全局样式](web/shared/styles/base.css)、[应用导航](web/app/navigation.css)、[共享筛选](web/shared/ui/filter-controls.css)及各功能样式。产品事实见 [PRODUCT.md](PRODUCT.md)，本文件只约束视觉和交互呈现。

## Colors

中性色保持稳定；蓝色、赤陶、青瓷、琥珀、莓红、石墨六个预设和用户自定义色种派生操作色、选中底与地图色阶。frontmatter 保存默认蓝色的实际生成值；生产来源为 src/appearance.ts 与基础 CSS。

### Primary

- **主题色**：accent 用于主要操作、链接、选中和焦点；accent-soft 用于选中底，on-accent 为主按钮文字。明亮、深色、跟随系统独立于配色选择；自定义使用点选色盘和应用按钮，无需填写色值。
- **标签图标**：复用页头领结形状，浏览器 favicon 随当前主题使用 accent 底与 on-accent 图形；首次加载的静态图标采用默认蓝色。

### Neutral

- **纸白／午夜底**：page 是页面底色，surface 是主要面板，surface-alt 是次级区域、悬停、代码块及分段控件底色。
- **午夜墨／浅色文字**：text 用于正文，muted 用于元信息和辅助标签，border 用于边界与分隔。
- 每个浅色 token 对应一个带 -dark 后缀的深色值；这些后缀用于文档区分两个主题，运行时继续由同名 CSS 变量覆盖。

### Semantic & Data Colors

- **赭金**：near 标记近似范围及相关需关注状态。收藏也使用该语义色，需结合图标和上下文阅读。
- **砖红**：danger 与 danger-bg 显示错误文字和异常区域。
- **代码范围底色**：code-exact 与 code-near 分别用于精确和近似对应，配合图例与范围说明。
- **地图五阶**：map-0 至 map-4 按当前指标表示强度。资源地图复用部分阶位描述时间类别，旧记录与时间缺失另有局部处理，不能套用代码覆盖率含义。
- 角色、轨迹类别和异常保留可辨认语义，不将所有类别都替换为主题色。

**The Semantic Color Rule.** 主题色用于主要操作与选中；赭金用于近似、未知及需关注的记录；砖红用于错误。统计颜色必须与文字、图例和范围说明共同出现，不能替换其含义。

地图五阶随主题色变化，各阶文字使用对应的 map-N-text，保持低到高的明度顺序与可读性。按钮与地图文字目标对比度至少 4.5。侧车预览色带仅作展示，不替代生产派生逻辑。

## Typography

**界面与正文：** Geist Variable，中文按系统回退到 PingFang SC、Microsoft YaHei，再到 sans-serif。字体从本地依赖加载。

**代码与技术标识：** SFMono-Regular、Consolas、Liberation Mono、monospace。路径在需要时折行或省略，完整内容保留在详情或提示中。

### Hierarchy

- **页面标题：**代码地图采用 title（22px）；会话与资源根据工作区使用 18–22px 的紧凑标题。
- **区域标题：**section 用于全局二级标题；较小标题通常采用（13px，600）。
- **正文阅读：**message-body 用于会话消息正文；文章容器自身继承默认字号，不能把容器计算值当成正文样式。代码块通常为（12px）。
- **控件与元信息：**control、filter 和 label 分别服务按钮、筛选与紧凑标签；9–11px 的局部元信息不是所有正文的默认。
- **统计数值：**地图数值使用 metric（25px），与名称并排，分母在下一行；画像用对齐的标签与数字，避免仪表盘式大数字挤占正文。
- **数字：**分页、地图倍率及部分用量指标使用等宽数字便于比较；不为全部文本启用等宽字体。

## Layout

### 工作区

桌面使用导航／筛选、主内容、详情／画像的横向组织。三个页面复用可拖动面板工作区，但其高度、滚动和窄屏呈现由页面决定。展开面板可以恢复本次页面中的宽度，收起保留窄轨入口。

- 页头桌面高度（58px），水平内边距取 desktop-gutter。窗口收窄后允许换行；不能假设所有视口仍有固定页头高度。
- 默认宽度按任务区分：地图大屏（200px／320px），会话（300px／260px），资源（180px／340px）；用户拖动宽度优先。地图与资源无初始选择时收起详情，选择对象后展开。
- 侧栏可调范围（160–480px），详情（260–640px），收起轨道（44px），主内容预算至少（360px）。这些是共享布局计算规则，不等同于小屏强制最小宽度。
- 代码地图主区默认内边距（20px 22px 24px）；会话和资源采用各自更紧凑的边距。提取的 spacing 是已有复用值，当前 CSS 没有由它们生成的统一间距 token 系统。

### 响应式

| 最大宽度 | 已有变化 |
| --- | --- |
| 1250px | 页面缩小边距与部分指标，调整面板默认宽度。 |
| 1050px | 页头开始允许换行。 |
| 1023px | 地图详情可移到主区下方；会话与资源侧栏、详情隐藏并通过临时面板访问。 |
| 767px | 地图上下排列、取消横向拖动面板；仓库导航默认收起，入口保留仓库与目录范围；标题、工具栏、间距及对话框进一步收敛，绘图区高（300px）。 |
| 599px | 页头隐藏品牌文字，导航更紧凑，操作区域允许占独立一行。 |

会话与资源的表格、轨迹、列表和长正文在各自区域内滚动，窄屏表格保留横向滚动；不将表格的局部溢出写成整页横向滚动。

### 代码与资源地图

两类地图都使用矩形树图与共享相机。文件地图面积由物理行数决定；资源地图面积由选中使用指标线性决定。面积与着色承担不同信息，零面积项仍能从列表访问。

矩形绘制间隔最多为（1 CSS px），不会随地图放大变粗。标签根据可用面积逐级出现，不通过不断缩小字号塞进所有信息。平移、缩放及全屏只改变视野；选中目录与统计筛选改变范围。

## Elevation & Depth

采用平面工作区与临时浮层阴影的组合。面板和普通卡片依靠底色、细边界及间距区分；菜单、地图提示和对话框使用不同强度的阴影。

### Shadow Vocabulary

- **轻微选中：**分段按钮中的（0 1px 2px #0000000d），用于已选片段。
- **地图提示：**（0 3px 14px #00000020），让悬停信息与地图分离。
- **筛选浮层：**（0 6px 24px #00000018），配合边界和视口内定位。
- **下拉菜单：**（0 8px 30px #00000015），承载资源或仓库入口。
- **对话框：**（0 16px 55px #00000029），配合半透明午夜墨色遮罩。
- **消息定位：**（0 0 0 2px color-mix(in srgb, var(--accent) 16%, transparent)），是定位状态而非静态卡片阴影。

**The Temporary Layer Rule.** 保持工作区的平面组织，使用底色和边界区分内容。阴影优先用于菜单、提示和对话框；已有消息定位光圈和分段选中阴影继续作为状态反馈保留。

## Shapes

以细边界和小圆角维持紧凑秩序。地图块采用 map-tile，标签和紧凑行使用 compact，通用按钮和代码容器使用 control，筛选使用 filter，会话正文使用平直的连续阅读区域，资源管理卡可使用 resource-card，浮层和对话框使用 overlay。

这些值是不同角色的现有形状，不能把所有元素统一成同一个圆角。通常边界为（1px）；选中描边、键盘焦点和代码范围标记保留其自身状态表达。品牌标记沿用现有页头与 favicon，图标来自现有 Phosphor 使用方式。

## Components

### Buttons

紧凑、克制，优先清楚表达动作。通用按钮最小高度（34px）、内部间隔取 control-gap；主要按钮使用主题色底和 on-accent 文字，中性按钮使用 surface 底与细边界，轻按钮保持透明。主要悬停使用 accent-hover，中性悬停使用 surface-alt。

通用图标按钮宽（34px），资源分页图标按钮为局部紧凑规格（28px）。禁用通常降低透明度至（0.55）并取消可用鼠标提示；不把局部更小规格提升为所有按钮的要求。

### Inputs & Filters

枚举筛选复用 [FilterSelect](web/shared/ui/FilterSelect.tsx)，项目／长列表搜索复用 [ProjectPicker](web/shared/ui/ProjectPicker.tsx)，日期复用 [DatePicker](web/shared/ui/DatePicker.tsx)。筛选触发器高（34px），鼠标悬停或打开时改变边界与底色；键盘焦点有（2px）主题色轮廓。

列表浮层通过 Portal 脱离侧栏裁剪，尺寸受视口和 Radix 可用高度约束。选中、键盘高亮和勾选标记分别可辨认；较长项目名显示完整路径，空搜索结果保留明确提示。

日期沿用现有紧凑日历、选择及清空入口。搜索字段按页面角色采用资源搜索框或会话搜索框的已有样式，不用原生 select 或日期 input 重建同类筛选。

### Navigation

产品导航在页头并列三块入口，当前页用 accent-soft 底、accent 文字和（600）字重标识；悬停使用 surface-alt。资源视图和会话阅读方式还使用细底线或分段按钮区分层级，不能把所有层级都改成页头导航样式。

资源页标题与 Skill／MCP 同排，下一行整合使用总览／本地资源、搜索和适用视图的列表／地图切换。数量衔接主列表；停用、回收与操作记录放在筛选侧栏的独立导航区，窄屏沿用筛选面板。使用状态保留直接筛选，低频与长期未用归入关注条件，收藏仍直接可达；数量沿用相应筛选口径。涉及 Agent 表示本地入口与历史客户端并集，使用 Agent 分布只展示历史使用，详细定义放入已有帮助。

会话页头左侧展示标题与元信息，来源详情以内联入口按需弹出；右侧集中代码地图与导出。下一行统一阅读模式、会话内搜索与轮次导航，只在工具栏下保留一条主分隔线。轮次显示当前轮／总数，点击后可输入跳转或选择首末轮；前后轮和问题目录保持直达。工具组根据中心面板宽度整体换行，窄屏的会话级动作收为图标并保留可访问名称。问题目录采用轮次列加两行可读摘要，移除 Markdown 链接目标和已识别的技能正文，原始消息保持完整。

### Chips & Containers

资源状态标签紧凑，采用 resource-tag 的边距与形状，边界与底色轻，关注状态用 near。会话角色标签属于自己的更小规格（9px），其中部分颜色来自局部源码。

会话正文采用连续消息与轮次分隔，用户问题使用轻主题色底和左侧细线，AI 回复使用开放正文并显示 AI 与模型名称。未确认结束的回复通过按需详情说明，不常驻状态徽标。消息左右内边距为 18px，窄屏为 12px，正文最大 75ch；代码和表格继续在各自容器中横向滚动。已定位消息保留主题色边界和定位状态。资源管理卡的圆角和内边距是资源专用规则，工作区不额外套卡。

轨迹节点保留全宽表格，选中后的正文位于下方，默认分配约一半可用高度；分隔线支持拖动和键盘调节，并记住比例。放大详情覆盖中间工作区，可前后切换本页节点，返回或 Escape 恢复列表位置和焦点。单条正文不额外套标签页，工具输入／结果保留切换；时间线可收起，子会话入口集中在画像中。

### 信息与操作层级

- 会话库保留客户端和项目直达筛选，低频条件进入“更多筛选”，激活条件数量可见；每会话默认一条命中摘要，证据按页加载真实对象或记录片段。
- 资源详情先呈现具体客户端入口、作用域、路径与预览动作，使用统计和分布按需展开。
- 地图压缩标题、指标与工具栏；活动列表限制高度，使当前事件详情就近可达。刷新进行中和失败直接呈现，完成时间在分析信息与刷新提示中查看。
- 地图会话与覆盖率后台加载在标题旁的固定槽位显示带可访问名称的进度图标，不在筛选下方挤入文字，也不改变内容高度。
- 用量指标相同的部分记录范围合并为一条说明，列明适用指标；不同范围单独保留，避免每格重复绘制边框徽标。
- 不放置常驻教程、重复副标题或解释性小字。统计定义与范围说明进入已有帮助；错误、缺失、近似、估算和部分记录仍直接可见。

### Help, Pagination & Dialogs

短定义使用现有 Tooltip，统计公式和操作说明复用 [HelpPopover](web/shared/ui/HelpPopover.tsx)。说明按区域合并，影响解读的异常状态直接可见。浮层有独立滚动、关闭入口和焦点恢复。

资源分页复用 [ResourcePagination](web/shared/ui/ResourcePagination.tsx)，包含区间、首尾页、页码、跳转和每页条数。对话框使用现有 Radix 结构，宽度受视口约束，长内容在浮层内滚动。

**The Shared Control Rule.** 新增同类筛选、日期、帮助和分页沿用现有共享组件，不在页面中另外实现键盘、焦点及弹层管理。

### Feedback & Motion

反馈以颜色、边界、勾选、底线及有限的缩放／旋转为主。地图悬停亮度过渡为（0.12s ease）；会话折叠箭头过渡为（0.15s）；全局加载旋转为（1.4s linear infinite），会话加载旋转为（1.1s linear infinite）。已有 reduced-motion 规则停止旋转并移除对应过渡，不能把这次记录扩写成新增全局动画系统。

侧车提供九个独立 HTML/CSS 视觉样例，供 live 面板展示。它们复用当前变量、状态和形状，不含 React／Radix 的运行行为；实际产品继续使用已有组件实现。

## Do's and Don'ts

### Do:

- **Do** 使用同一 CSS 变量的深浅主题值，状态、图表和编辑器范围沿用原有语义。
- **Do** 按已有控件角色复用枚举筛选、项目搜索、日期、帮助和完整分页入口。
- **Do** 保留键盘焦点、选中标记、可访问名称和 Escape 后的焦点恢复。
- **Do** 根据所处页面保留真实响应式行为：地图上下排列，会话与资源使用临时面板。
- **Do** 用文件或资源列表补充地图小块的访问路径，密集表格在自己的区域内滚动。
- **Do** 将错误、缺失、近似、估算和部分记录直接呈现，将详细解释放入按需帮助。

### Don't:

- **Don't** 把每个区域都改成带阴影的卡片，或给现有紧凑控件套上大圆角。
- **Don't** 把侧车中的预览色阶当成生产图表的颜色分级；地图沿用源码中的实际五阶颜色。
- **Don't** 为不同主题另建一套控件，或删除键盘焦点来消除鼠标点击反馈。
- **Don't** 把图表类别的局部颜色升级为全局品牌色，或只靠颜色区分数据状态。
- **Don't** 将地图缩放、搜索、语言或主题变化误写成统计范围改变。
- **Don't** 从本次设计记录推断全面无障碍达标或所有客户端状态已验收。
