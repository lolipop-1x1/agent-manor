# 01 统一管家领结品牌

Type: task
Status: resolved

替换页头与浏览器图标，调整字标，使用隔离数据完成真实浏览器验收。

## Comments

- 已确认采用管家领结方案；品牌色、导航与动态标题机制沿用当前实现。

## Answer

- 页头与 favicon 使用相同的三块领结几何，页头按主题着色；字标使用 450／650 字重。
- favicon 引用增加版本参数，避免继续使用旧叠层图标缓存。
- `npm run check`、`npm run build`、`npm run check:public` 和 `git diff --check` 通过。
- 内置浏览器使用隔离合成数据验证中英文三个视图标题、深浅主题、390／320 像素窄屏和品牌键盘焦点。
- 16／32／64／128 像素 favicon 完成真实渲染检查；截图保留在忽略的 `.local/brand-bowtie/`。
