# 庄园花园横幅导出记录

使用内置imagegen生成花园简笔画第二版，原始尺寸1983×793。用户明确授权使用本地图像工具进行不拉伸裁切，并要求保留原图。

- 原图：`docs/assets/readme/agent-manor-banner-sketch-garden-source.png`。
- README横幅：`docs/assets/readme/agent-manor-banner-sketch-garden-wide.png`。
- 裁切范围：从左上角横向1、纵向160像素处，裁取1980×396像素，比例严格为5:1；不缩放、不拉伸。
- 原图保留生成来源元数据；裁切版为本地派生图，生成后由系统图像工具导出。
- 中英文README引用相同横幅，前几版均保留；本轮不提交、不推送。

```sh
sips --cropToHeightWidth 396 1980 --cropOffset 160 1 \
  docs/assets/readme/agent-manor-banner-sketch-garden-source.png \
  --out docs/assets/readme/agent-manor-banner-sketch-garden-wide.png
```

## 原始生成提示词

```text
Create an illustration file with a VERY WIDE 5:1 aspect ratio, width 2560 pixels, height 512 pixels. It is a shallow README banner, not a full scene poster. Use the whole width. Make the canvas five times wider than it is tall.

Draw a friendly robot butler welcoming visitors into a rich manor garden. Simple hand-drawn line art: warm ivory background, thin slightly imperfect dark pen contours, open unfilled forms, no shadows or rendering. Only the bow tie is cobalt blue, shaped like two rounded triangular wings with a central knot. No text.

Composition designed specifically for the shallow height: a SMALL waist-up robot butler near the left occupies about 18% of the width and 80% of the height, with a round rectangular head, dot eyes, smile, waistcoat, and one hand held open. Behind the robot and across the entire width is a continuous garden panorama. A broad low manor building is in the center-right, with trees behind it and a little pavilion at the far right. Low hedges, a garden gate, wall, paths, flower beds, and a few simple foreground flowers connect the scene from edge to edge. Keep the manor roof lower than the tops of the trees. Every major element fits within the shallow banner. Very little empty sky, no blank center, no big empty side margins. Environment should be fuller than a logo illustration but use clear medium-sized shapes that remain readable at a 900 x 180 display size. Avoid dense small texture.

IMPORTANT OUTPUT REQUIREMENT: a true 5:1 panoramic PNG canvas, 2560 wide by 512 tall. Do not return a 3:1 canvas. No letterboxing. No stretching. No typography.
```
