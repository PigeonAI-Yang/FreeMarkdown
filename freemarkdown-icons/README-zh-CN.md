# Freemarkdown 图标交付

根据本轮确认的分屏书页概念手工重绘。SVG 中的所有可见图形均为矢量几何，
不嵌入参考图片，不依赖字体，不引用外部资源。

## 文件

- freemarkdown-icon.svg
  彩色主图标；viewBox="0 0 512 512"，默认 512 × 512。
  保留渐变、流动中缝、Markdown # 与 >、阅读行。
  画布背景与书页内的留白均透明，不附带白色底板。

- freemarkdown-icon-small.svg
  小尺寸简化图标；viewBox="0 0 32 32"。
  去掉灰色阅读行与渐变，调整笔画与间距；建议用于 16–32 px 的小型界面图标。
  与主图标并非简单等比缩小关系，而是为小尺寸重新调整的同一视觉标识。

- freemarkdown-icon-mono.svg
  单色主图标；viewBox="0 0 512 512"。
  使用 currentColor；没有颜色设置时通常显示为黑色。
  将 SVG 代码内联到 HTML 时，可通过 CSS color 属性控制颜色。
  通过 <img> 引用独立 SVG 时，不会继承页面的 color；
  需要固定白色版本时，可在 SVG 根元素设置 color="#FFFFFF"。

- freemarkdown-icon-1024.png
  从主 SVG 导出的 1024 × 1024 RGBA 透明 PNG 备用图。

## 基础引用示例

```html
<img src="/freemarkdown-icon.svg" width="48" height="48" alt="Freemarkdown">
<link rel="icon" type="image/svg+xml" href="/freemarkdown-icon-small.svg">
```

以上路径为将相应资源放在网站根目录后的示例。

## 检查

三个 SVG 均经过 XML 解析与栅格化检查；检查了边缘透明度与缩小后的外观。
512 × 512 表示主文件画布尺寸，不是图像分辨率上限。
文件包没有字体文件、隐藏位图、背景棋盘格、脚本或白色底板。
预览图的棋盘格只用于展示透明区域，不属于 SVG 本身。
