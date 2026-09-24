# 设计资料

放线框、可点击原型、图标源文件、样式规范与交互录像。文字线框位于 [UX](../docs/product/UX.md)，可交互原型源码位于 apps/desktop。视觉规范见 [设计系统](DESIGN_SYSTEM.md)，参考与取舍见 [UI 参考](../docs/research/UI_REFERENCES.md)。

原型用合成任务；导出图与源文件一同标注版本。浏览器原型只验证布局和操作理解，不能证明真实桌面窗口的 hover、置顶、多屏与焦点行为。

## 四套风格预览（2026-09-25）

打开 [STYLE_GALLERY.html](STYLE_GALLERY.html) 可切换浅深色、控制台/小窗/选择器截图并放大。截图仅含合成数据，位于 `previews/styles/`。App 内的「设置 → 界面风格」提供纸笺、霜序、暖刊、极简即时切换，选择保存在本机。

本地查看对比页可在仓库根目录运行 `python3 -m http.server 1421 --bind 127.0.0.1`，访问 `http://127.0.0.1:1421/design/STYLE_GALLERY.html`。它是设计留档，不读取任务库。
