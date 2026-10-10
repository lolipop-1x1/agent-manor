---
name: AgentManor
description: 克制、精确、层次清楚的开发者工作台
colors:
  page: "#fafcfb"
  surface: "#fff"
  surface-alt: "#f3f6f5"
  text: "#1c302d"
  muted: "#637571"
  border: "#dce5e2"
  accent: "#126b5e"
  accent-soft: "#e7f2ee"
  near: "#947526"
  map-0: "#edf2f0"
  map-1: "#d8ece5"
  map-2: "#a8d3c4"
  map-3: "#64aa94"
  map-4: "#2c7d68"
  code-exact: "#dff0e9"
  code-near: "#f5eedb"
  danger: "#a23e35"
  danger-bg: "#fff0ed"
  page-dark: "#101b19"
  surface-dark: "#152320"
  surface-alt-dark: "#1b2c28"
  text-dark: "#e0eeea"
  muted-dark: "#a1b7af"
  border-dark: "#31463f"
  accent-dark: "#83cfb6"
  accent-soft-dark: "#203b32"
  near-dark: "#d8b963"
  map-0-dark: "#20312c"
  map-1-dark: "#29483d"
  map-2-dark: "#386650"
  map-3-dark: "#4b8e6c"
  map-4-dark: "#6eba94"
  code-exact-dark: "#254939"
  code-near-dark: "#3e3824"
  danger-dark: "#f4aa9f"
  danger-bg-dark: "#3a2520"
typography:
  title:
    fontFamily: '"Geist Variable", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 28px
    fontWeight: 550
    letterSpacing: -1px
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
    fontSize: 34px
    fontWeight: 500
    letterSpacing: -1.3px
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
  desktop-gutter: 28px
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
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
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.filter}"
    padding: 12px 14px
  metric-tabs:
    backgroundColor: "{colors.surface-alt}"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: 2px
---

# Design System: AgentManor

## Overview

**Creative North Star: "开发者工作台"**

把会话、代码和资源组织为同一张工作台上的不同工具。界面以克制、精确、层次清楚为气质，支持密集信息和连续操作。品牌出现在青绿语义色、页头标记、选中状态和细节反馈中。

工作区以平面为主，依靠页面、面板和次级底色建立区域关系，细边界帮助扫描。按钮、筛选、列表和容器紧凑、克制、反馈明确；临时浮层使用阴影说明其与底层内容的关系。

本文件记录已有实现，不授权更换视觉体系。基础值提取自当前 CSS，描述语言经用户确认；本次使用隔离合成数据查看了三个页面的桌面浅色和窄屏深色表现。没有完成所有状态的对比度、键盘或触屏审计。

**Key Characteristics:**

- 青绿主色与中性色工作区，赭金和砖红承担明确语义。
- 信息密集，字号与留白按任务分配，没有统一的等比字号阶梯。
- 细边界、小圆角、平面内容区域和临时浮层阴影。
- 筛选、选中、聚焦和异常状态有可辨认的反馈。
- 深浅主题与窄屏布局沿用同一套任务结构。

依据：[全局样式](web/shared/styles/base.css)、[应用导航](web/app/navigation.css)、[共享筛选](web/shared/ui/filter-controls.css)及各功能样式。产品事实见 [PRODUCT.md](PRODUCT.md)，本文件只约束视觉和交互呈现。

## Colors

调色盘由青绿主色、带轻微绿相的中性色、赭金关注色和砖红错误色构成。frontmatter 保存源码色值；不将浏览器转换后的 RGB 值另立为定义。

### Primary

- **青绿**：accent 用于主要操作、链接、选中和焦点；accent-soft 承担浅色选中底。深色主题采用对应的 accent-dark 与 accent-soft-dark，而不是仅把浅色背景反转。

### Neutral

- **雾白／深绿底**：page 是页面底色，surface 是主要面板，surface-alt 是次级区域、悬停、代码块及分段控件底色。
- **深墨／浅灰绿文字**：text 用于正文，muted 用于元信息和辅助标签，border 用于边界与分隔。
- 每个浅色 token 对应一个带 -dark 后缀的深色值；这些后缀用于文档区分两个主题，运行时继续由同名 CSS 变量覆盖。

### Semantic & Data Colors

- **赭金**：near 标记近似范围及相关需关注状态。收藏也使用该语义色，需结合图标和上下文阅读。
- **砖红**：danger 与 danger-bg 显示错误文字和异常区域。
- **代码范围底色**：code-exact 与 code-near 分别用于精确和近似对应，配合图例与范围说明。
- **地图五阶**：map-0 至 map-4 按当前指标表示强度。资源地图复用部分阶位描述时间类别，旧记录与时间缺失另有局部处理，不能套用代码覆盖率含义。
- 会话角色、轨迹类别和缓存输入还存在局部固定颜色，具体值留在对应组件源码，不作为新增全局品牌色。

**The Semantic Color Rule.** 青绿用于主要操作与选中；赭金用于近似、未知及需关注的记录；砖红用于错误。统计颜色必须与文字、图例和范围说明共同出现，不能替换其含义。

源码的五阶地图值为真实数据分级；.impeccable/design.json 中由原色生成的八阶色带只供面板预览，未进入生产 CSS。

## Typography

**界面与正文：** Geist Variable，中文按系统回退到 PingFang SC、Microsoft YaHei，再到 sans-serif。字体从本地依赖加载。

**代码与技术标识：** SFMono-Regular、Consolas、Liberation Mono、monospace。路径在需要时折行或省略，完整内容保留在详情或提示中。

### Hierarchy

- **页面标题：**代码地图采用 title；资源标题（24px）和会话标题（20px）按各自工作区收敛，不能机械套用同一尺寸。窄屏分别为地图（24px）、资源（21px）、会话（18px）。
- **区域标题：**section 用于全局二级标题；较小标题通常采用（13px，600）。
- **正文阅读：**message-body 用于会话消息正文；文章容器自身继承默认字号，不能把容器计算值当成正文样式。代码块通常为（12px）。
- **控件与元信息：**control、filter 和 label 分别服务按钮、筛选与紧凑标签；9–11px 的局部元信息不是所有正文的默认。
- **统计数值：**metric 用于地图主要数值；窄屏收敛至（27px），近似统计、文件详情和画像各保留自身层级。
- **数字：**分页、地图倍率及部分用量指标使用等宽数字便于比较；不为全部文本启用等宽字体。

## Layout

### 工作区

桌面使用导航／筛选、主内容、详情／画像的横向组织。三个页面复用可拖动面板工作区，但其高度、滚动和窄屏呈现由页面决定。展开面板可以恢复本次页面中的宽度，收起保留窄轨入口。

- 页头桌面高度（66px），水平内边距取 desktop-gutter。窗口收窄后允许换行；不能假设所有视口仍有固定页头高度。
- 视口大于（1250px）时侧栏默认（200px）、详情默认（320px）；中间档默认（175px／285px）。更窄档侧栏初始（170px）。
- 侧栏可调范围（160–480px），详情（260–640px），收起轨道（44px），主内容预算至少（360px）。这些是共享布局计算规则，不等同于小屏强制最小宽度。
- 代码地图主区默认内边距（31px 28px 28px）；会话和资源采用各自更紧凑的边距。提取的 spacing 是已有复用值，当前 CSS 没有由它们生成的统一间距 token 系统。

### 响应式

| 最大宽度 | 已有变化 |
| --- | --- |
| 1250px | 页面缩小边距与部分指标，调整面板默认宽度。 |
| 1050px | 页头开始允许换行。 |
| 1023px | 地图详情可移到主区下方；会话与资源侧栏、详情隐藏并通过临时面板访问。 |
| 767px | 地图上下排列、取消横向拖动面板；标题、工具栏、间距及对话框进一步收敛。 |
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
- **对话框：**（0 16px 55px #00000029），配合半透明深绿遮罩。
- **消息定位：**（0 0 0 2px color-mix(in srgb, var(--accent) 16%, transparent)），是定位状态而非静态卡片阴影。

**The Temporary Layer Rule.** 保持工作区的平面组织，使用底色和边界区分内容。阴影优先用于菜单、提示和对话框；已有消息定位光圈和分段选中阴影继续作为状态反馈保留。

## Shapes

以细边界和小圆角维持紧凑秩序。地图块采用 map-tile，标签和紧凑行使用 compact，通用按钮和代码容器使用 control，筛选与消息卡使用 filter，资源管理卡可使用 resource-card，浮层和对话框使用 overlay。

这些值是不同角色的现有形状，不能把所有元素统一成同一个圆角。通常边界为（1px）；选中描边、键盘焦点和代码范围标记保留其自身状态表达。品牌标记沿用现有页头与 favicon，图标来自现有 Phosphor 使用方式。

## Components

### Buttons

紧凑、克制，优先清楚表达动作。通用按钮最小高度（34px）、内部间隔取 control-gap；主要按钮使用青绿底和 surface 文字，中性按钮使用 surface 底与细边界，轻按钮保持透明。主要悬停为亮度（0.94），中性悬停使用 surface-alt。

通用图标按钮宽（34px），资源分页图标按钮为局部紧凑规格（28px）。禁用通常降低透明度至（0.55）并取消可用鼠标提示；不把局部更小规格提升为所有按钮的要求。

### Inputs & Filters

枚举筛选复用 [FilterSelect](web/shared/ui/FilterSelect.tsx)，项目／长列表搜索复用 [ProjectPicker](web/shared/ui/ProjectPicker.tsx)，日期复用 [DatePicker](web/shared/ui/DatePicker.tsx)。筛选触发器高（34px），鼠标悬停或打开时改变边界与底色；键盘焦点有（2px）青绿轮廓。

列表浮层通过 Portal 脱离侧栏裁剪，尺寸受视口和 Radix 可用高度约束。选中、键盘高亮和勾选标记分别可辨认；较长项目名显示完整路径，空搜索结果保留明确提示。

日期沿用现有紧凑日历、选择及清空入口。搜索字段按页面角色采用资源搜索框或会话搜索框的已有样式，不用原生 select 或日期 input 重建同类筛选。

### Navigation

产品导航在页头并列三块入口，当前页用 accent-soft 底、accent 文字和（600）字重标识；悬停使用 surface-alt。资源视图和会话阅读方式还使用细底线或分段按钮区分层级，不能把所有层级都改成页头导航样式。

### Chips & Containers

资源状态标签紧凑，采用 resource-tag 的边距与形状，边界与底色轻，关注状态用 near。会话角色标签属于自己的更小规格（9px），其中部分颜色来自局部源码。

消息卡使用细边界、surface 底及 message-card 的桌面边距，窄屏内边距（10px）。已定位消息增加青绿边界和定位光圈。资源管理卡的圆角和内边距是资源专用规则，工作区不额外套卡。

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
