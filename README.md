# FreeMarkdown

**多份 Markdown，同屏分屏阅读。**

FreeMarkdown 是一款以多文档分屏阅读为核心的 Windows 桌面应用。把项目说明、研究笔记、接口代码和流程图放在同一屏，随时对照，减少来回切换。需要修改或分享时，也可以打开编辑器或导出图片卡片。文档仍保存在原来的文件夹中。

[![FreeMarkdown 演示海报：四份 Markdown 文档在同一个窗口中并排阅读](docs/assets/readme/split-columns-poster.png)](docs/assets/readme/split-columns.png)

## 相关资料，放在同一屏

把原稿与修改稿并排比较，或同时参考说明、代码和笔记。分屏可以横向排列，也可以上下组合；每个窗格独立滚动，并保留自己的阅读位置。应用会保存已打开的文档和布局，供下次启动时恢复。

[![FreeMarkdown 演示海报：浅色主题下四份文档组成上下分屏的四格布局](docs/assets/readme/split-grid-poster.png)](docs/assets/readme/split-grid.png)

以上演示海报基于软件实机截图排版，使用示例文档。点击图片可查看原始截图。

## 打开文档，继续阅读

打开单个 `.md` 或 `.markdown` 文件，也可以打开文件夹，从侧边栏浏览其中的文档。目录、浅色与深色主题、字号和阅读宽度设置帮助你调整阅读方式。

在 Windows 中关联 Markdown 文件后，从资源管理器打开文档会交给已有的 FreeMarkdown 窗口处理。软件保持单实例运行。其他程序改动了文件时，阅读视图会更新；按 `F5` 可以手动刷新当前文档。

## 修改文字，边写边看

按 `Ctrl+Shift+E` 打开当前文档的编辑面板。你可以选择源码、分栏或预览视图。编辑器支持自动保存和 `Ctrl+S`；如果磁盘上的文件在编辑期间被其他程序修改，应用会提示你选择重新加载、覆盖或另存。

![FreeMarkdown 实机截图：浅色主题下的源码编辑和分栏预览](docs/assets/readme/editor.png)

## 把内容导出为图片

按 `Ctrl+E` 打开卡片面板。选择模板和导出方式，预览排版后保存为 PNG 或 JPEG，也可以将 PNG 复制到剪贴板。

![FreeMarkdown 实机截图：卡片模板、导出设置与实时预览](docs/assets/readme/cards.png)

## 常用操作

| 操作 | 快捷键 |
| --- | --- |
| 打开文件 | `Ctrl+O` |
| 打开文件夹 | `Ctrl+Shift+O` |
| 搜索当前文件夹中的 Markdown 文档 | `Ctrl+Shift+F` |
| 编辑当前文档 | `Ctrl+Shift+E` |
| 打开卡片面板 | `Ctrl+E` |
| 刷新当前文档 | `F5` |

## 从源码运行

当前仓库提供源码。请先准备 Windows 开发环境、Node.js、pnpm 和 Rust；Windows 所需组件见 [Tauri 的环境准备说明](https://v2.tauri.app/start/prerequisites/)。

```powershell
git clone https://github.com/PigeonAI-Yang/FreeMarkdown.git
cd FreeMarkdown
pnpm install
pnpm tauri dev
```

构建 Windows 安装包：

```powershell
pnpm tauri build
```

安装包输出到 `src-tauri/target/release/bundle/nsis/`。`pnpm build` 只构建前端，不会生成桌面安装包。

FreeMarkdown 使用 Tauri 2、Rust、React 和 TypeScript。Markdown 渲染基于 comrak，并支持代码高亮、公式和 Mermaid 图表。
