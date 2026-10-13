# AgentManor 庄园官网

## 已确认范围

- 在 main 开发独立 site/ 静态官网，适合 GitHub Pages 项目路径；不依赖产品后台，不加载个人历史。
- 目标为桌面访客理解本地优先的 Agent 工作环境管家并进入安装指南。
- 首屏为精细体素实时 3D 庄园：中央主馆、两侧翼楼、正式园林、喷泉、围墙和大门；奶油白石材、蓝灰屋顶与蓝领结品牌。
- 四位不同配色的 Agent 机器人围桌喝茶，一位蓝领结管家沿桌外路线自动逐个添茶。机器人有显示屏面部、机械关节，动作包含行走、停稳、抬壶、倒茶、回应与离开。
- 支持旋转、缩放、暂停、重置、茶庭近景和建筑功能入口；正常向下滚动阅读产品。
- 点击开始使用，镜头推近茶庭与入口并展开可关闭安装面板；关闭、返回或 Escape 恢复原视角和焦点。计划命令 npm install -g agent-manor 与 agent-manor start 明确标作规划占位，不改 CLI。
- 下方介绍总览、会话库、代码地图、Skill/MCP 资源管理。使用完全隔离的人工合成数据生成真实产品截图，不使用个人资料；不宣称多 Agent 自动调度或已公共发布。
- 网站中英双语文案进入共享翻译目录，使用现有品牌图形与 Radix 弹层；官网语言保存在浏览器，不调用本地产品偏好 API。
- WebGL 不可用时仍能阅读介绍和打开安装面板。减少动态效果、暂停、离屏/后台暂停及键盘焦点需要覆盖。
- 完成构建、公开内容检查、浏览器验收和独立代码审查。本轮先本地交付；公开仓库、npm 发布和 Pages 正式上线保持后续确认范围。

## 集成约定

- 世界坐标 Y 向上、+Z 为前方。庄园范围约 x=-14..14、z=-12..13；主馆靠后 z=-6，两翼 x=±10，前方大门 z=12。茶桌中心 x=5.8、z=5.7，地面 y=0.35；茶庭外圈半径约4.1。喷泉 x=-6、z=4。
- estate.ts 导出 createEstate(): { group: THREE.Group; hotspots: { object: THREE.Object3D; feature: 'overview'|'sessions'|'code-map'|'resources' }[]; update(time: number): void }。建筑采用合并或实例化几何减少调用。
- tea.ts 导出 createTeaScene(): { group: THREE.Group; update(time: number): void; cycleDuration: number }，根组位于茶桌中心，动画由外部传入秒数，暂停时不自行推进。
- Scene.tsx 由主实现者负责，导出 ManorScene，props 为 installationOpen:boolean、paused:boolean、view:'estate'|'tea'、language:'zh-CN'|'en'、onFeature(feature):void、onReady():void、onError():void。view 切换与 installationOpen 分开，安装打开前保存镜头。
- main.tsx、App.tsx、style.css、安装交互和共享 site 翻译由页面实现者负责；模型文件、控制器、截图和构建分别由其他实现者负责。所有人只修改自己的文件，不切换分支、不提交他人改动。
