---
version: 1
slug: "web-features-resources-resources-tsx"
primary_target: "web/features/resources/Resources.tsx"
related_targets: ["web/features/resources/ResourceMap.tsx", "web/features/resources/ResourceChange.tsx", "web/features/resources/resources.css", "web/shared/layout/workspace-layout.ts"]
---

# 资源管理：清单与并排详情

模式：Operate。交付：正式资源管理页面，沿用现有本地 API、主题和共享组件；静态文档核对不代替真实页面验收。

## Direction contract

THESIS: Skill／MCP 各用一个按名称汇总的清单，同时回答历史使用和本地位置；详情与变更预览逐层展开。移除使用总览／本地资源双清单与理论客户端归属，保留列表／地图同范围切换。

OWN-WORLD: 沿用 AgentManor 的白底、蓝灰次级表面、主题蓝交互、紧凑字体与 5–8px 控件圆角。使用平面列表、对齐数字与细分隔线；无嵌套卡片、大数字看板、装饰渐变或重复状态标签。

STORY: 找到资源，判断本地是否发现及全局／项目分布，查看历史证据；选择一个具体文件、配置入口或注册后，理解修改前后、影响范围和恢复方式，再确认变更或恢复。

FIRST VIEWPORT: 保留产品顶部导航；资源页标题同行 Skill／MCP、刷新、更多。左栏默认 220px，放本地是否发现、全局／项目位置和时间，历史客户端、历史项目及关注条件收进更多筛选；中栏搜索、列表／地图切换、使用状态和收藏衔接统一清单。选中后展开右栏，默认随视口采用 360／400／440px，三栏可调宽。详情标题仅一次，以概览、文件／配置位置、使用记录组织。具体项预览替换右栏内容，保留返回和底部动作区；窄屏通过筛选面板与占满工作区的详情操作。

FORM: 用户选择第三张“清单与并排详情”，grounded candidate 7，seed key e59bad99。统一既有产品视觉和逻辑是用户明确约束。地图保留并与列表共用筛选、指标与资源选择。管理签名交互是具体配置字段的前后差异或实际路径移动预览，而不是笼统管理按钮。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## 约束

Skill 按具体文件或客户端控制入口管理，MCP 按具体配置注册管理；名称不是写入身份。本地位置筛选只按实际入口的 scope／project，selectionScopes 仅说明客户端生效上下文，不能把共享文件复制成项目位置。MCP 配置启用不等于在线，注册变更预览不展示命令、URL 或凭证。

管理动作从具体位置进入，展示配置文件、字段或匹配条件的 before／after，文件回收则展示实际路径移动；确认区同时提供影响、恢复与客户端待重新加载的边界。停用、回收和操作记录及盘点设置收进更多菜单，返回统一清单时恢复浏览上下文。真实错误必须可见，未知不补零；来源诊断按需查看。

筛选、日期、分页、帮助和面板调宽复用既有共享组件，地图继续使用共享色块层与相机。刷新保留上一完整结果，等待或失败期间暂停旧结果下钻；保留深浅主题、中英文、键盘、触屏、窄屏和列表上下文。公开文档与测试使用合成数据，实际历史、配置及截图只留本机。
