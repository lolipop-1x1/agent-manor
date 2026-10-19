# 官网更新验证

## 结果

- `npm run check`：i18n、服务端及产品Web类型检查通过。
- `npm run check:site`、`npm run check:i18n`：通过。
- `npm run test:site`：11项通过。
- `npm run build`、`npm run build:site`：通过，保留已有的大体积构建分块提示。
- `node scripts/capture-site-previews.mjs`：生成七种画面、中英文共14张1440×1000截图；逐张人工检查。会话费用与资源详情均等待实际加载完成。
- `npm run test:site:e2e`：12项真实Chrome场景通过，验证14张预览、复制安装／查询／Skill命令、宿主与语言切换、键盘、镜头、暂停、离屏、减少动态效果及WebGL降级。
- 浏览器检查900和1440宽度无页面横向溢出；静态官网访问未发出外部请求或产品API请求。
- `npm run check:public`及`git diff --check`：通过；人工检查图片与提交身份。

## 范围

图片全部来自临时数据目录内的合成项目、会话、知识及配置，通过实际产品后台生成；未使用个人历史，未调用付费模型。诊断与浏览器报告位于已忽略的`.local/`。

本轮修改官网、翻译、截图夹具和验收脚本，不修改产品Web或后端业务逻辑。未执行npm发布或Pages部署；安装文案按发布后使用流程编排。

设计检测保留现有官网字体与色板提示；沿用已确认的庄园视觉，没有更换产品设计体系。
