# 花园简笔画头图

用户确认保留简笔画风格，背景增加庄园花园内容，减少大块留白；目标版式为5:1的浅横幅。

使用内置imagegen，原简笔画作为风格及角色参考。首个产物实际为2103×748，未达到提示词要求的5:1；保留在`docs/assets/readme/agent-manor-banner-sketch-garden.png`。用户随后授权本地不拉伸裁切并保留原图；第一张裁切后会截断手势，最终采用第二张的5:1裁切版，导出记录见`header-prompt-sketch-garden-wide.md`。

```text
Use case: style-transfer.
Asset type: AgentManor README hero banner.
Input image 1 is the style and character reference.

Redraw this illustration into a TRUE ULTRAWIDE PANORAMIC BANNER, aspect ratio 5:1 (five times wider than tall), target 2400 x 480 pixels. The user likes the simple pen-line style but wants a shorter banner, a richer manor background, and MUCH LESS EMPTY SPACE. Recompose every element to fit the very shallow panoramic format naturally, with no stretching.

Preserve the friendly robot butler's round rectangular head, dot eyes, small smile, waistcoat, and cobalt blue bow tie resembling two rounded triangular wings and a small center knot. Place a smaller waist-up butler near the left, welcoming the viewer with one open hand. Give the robot generous clearance above the head so it is not clipped.

Fill the horizontal panorama with a continuous charming manor garden: the main manor house occupies the middle-right, a low garden wall and gate, layered rounded tree canopies behind the house, hedges and flower beds along a meandering path, a few simple flower stems in the foreground, and a modest garden pavilion far right. These are all outline drawings, lightly overlapping to create depth without shading. Spread garden elements across the WHOLE width, including the space behind and beside the butler, so the center and corners are not large blank patches. Use nearly the full shallow canvas height. Keep the manor and garden clearly readable when this image is displayed at 900 x 180 pixels. The landscape should feel connected, not scattered icons, with clean open breathing space around important contours, but no large empty sky or blank central gap.

Style: minimalist hand-drawn 2D line art, thin charcoal pen strokes with slight human irregularity, warm white background, unfilled shapes, no rendering, no gradients, no hatching. Cobalt blue on the bow tie is the only saturated color. More environmental detail than the reference, while keeping the same uncluttered line-drawing character. Medium-large simple shapes, not tiny busy texture. No text, no lettering, no watermark, no UI panels, no borders. No large top/bottom padding. Final image must be a shallow 5:1 panorama rather than a 3:1 illustration.
```
