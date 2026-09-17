# FreeMarkdown

本地 Markdown 阅读器（以读为主，不做编辑器）：高性能、秒开秒关、外观精致，支持同屏多窗格同时阅读多个文档。

平台 Windows 优先（WebView2），代码结构保持跨平台。

## 技术栈

- 后端：Tauri 2 + Rust，正文解析用 comrak（GFM 兼容），后台线程解析为 HTML
- 前端：React 19 + TypeScript + Vite
- 多窗格布局：dockview（标签页 / 网格分屏 / 拖拽 / 浮动组）
- 公式 KaTeX、图表 mermaid（WebView 侧增强）；代码高亮 highlight.js
- 样式 Tailwind CSS v4 + 设计 token，正文排版以 github-markdown-css 为底定制
- 所有依赖仅宽松许可（MIT / Apache-2.0 / BSD）

## 功能

1. 打开文件夹或单个 `.md` 文件；侧边文件树 + 标签页 + 最近打开
2. dockview 多窗格：拖拽分屏、标签分组、窗格最大化；未激活窗格冻结渲染（不挂 DOM）
3. 阅读体验：TOC 目录浮层（点击跳转、滚动联动高亮）、图片点击缩放、表格 / 任务列表 / 删除线 / 脚注
4. 外观：浅色 / 深色主题切换、正文限宽 72ch、可调字号、中文字体优先系统字体栈
5. 全文搜索：Rust 并行搜索当前文件夹全部 `.md`，秒级返回，点击结果跳转定位（sourcepos 精确定位 + 常驻高亮）
6. 会话持久化：退出时保存打开文件列表、布局树、每窗格滚动位置、主题、窗口尺寸；启动直接恢复现场
7. 单实例运行：二次启动唤起已有窗口

## 启动步骤

```bash
# 安装依赖
pnpm install

# 开发版（前端热更新 + Rust 增量编译）
pnpm tauri dev

# 生产构建
pnpm build
cd src-tauri && cargo build --release --features custom-protocol
```

## 已知问题

- Windows 上 `dragDropEnabled: true` 会导致 wry 注册窗口级 `IDropTarget`，所有不带 `CF_HDROP` 的内部 HTML5 拖拽都被显示为禁止放置，dockview 标签分屏无法使用。因此目前关闭系统文件拖放，文件打开走工具栏按钮 / `Ctrl+O` / `Ctrl+Shift+O`。后续走 DOM + `ICoreWebView2File.Path` 路线另行验证（参考 `tauri-plugin-windows-file-drop`）。
