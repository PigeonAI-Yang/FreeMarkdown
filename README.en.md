# FreeMarkdown · Windows Markdown reader and editor

[![GitHub Stars](https://img.shields.io/github/stars/PigeonAI-Yang/FreeMarkdown?style=flat-square&label=Stars)](https://github.com/PigeonAI-Yang/FreeMarkdown) [![GitHub Forks](https://img.shields.io/github/forks/PigeonAI-Yang/FreeMarkdown?style=flat-square&label=Forks)](https://github.com/PigeonAI-Yang/FreeMarkdown/forks) [![GitHub Issues](https://img.shields.io/github/issues/PigeonAI-Yang/FreeMarkdown?style=flat-square&label=Issues)](https://github.com/PigeonAI-Yang/FreeMarkdown/issues) [![Windows](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square)](#run-from-source) [![Follow on X](https://img.shields.io/badge/Follow-%40KimbomArtist-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/KimbomArtist)

[简体中文](README.md) | [English](README.en.md)

**Read multiple Markdown files side by side.**

FreeMarkdown is a Windows Markdown reader and editor for viewing multiple local documents in split panes, with Mermaid diagrams, LaTeX math, and PNG/JPEG card export. Put project notes, research, source code, and diagrams side by side. Open the editor when you need to make changes, or export an image card to share. Your documents stay in their original folders.

[Feature overview](#feature-overview) · [Frequently asked questions](#frequently-asked-questions) · [Run from source](#run-from-source) · [Report an issue](https://github.com/PigeonAI-Yang/FreeMarkdown/issues)

[![FreeMarkdown poster showing four Markdown documents side by side in one window](docs/assets/readme/split-columns-poster.png)](docs/assets/readme/split-columns.png)

## Feature overview

| Feature | Details |
| --- | --- |
| Split reading | Arrange panes side by side or in a grid. Each pane scrolls independently. FreeMarkdown restores document positions and the layout with the session. |
| Open local files | Open `.md` and `.markdown` files, or open a folder and browse its documents in the sidebar. |
| Edit and save | Switch between source, split, and preview views. Use autosave or `Ctrl+S`. FreeMarkdown prompts you when another app changes the file during editing. |
| Markdown rendering | Render code with syntax highlighting, LaTeX math, and Mermaid diagrams. |
| Image cards | Export content as PNG or JPEG, or copy a PNG to the clipboard. |
| Reading settings | Use the table of contents, light or dark themes, and adjustable font size and reading width. |

## Keep related documents together

Place a draft beside its revision, or read notes alongside reference material and code. Split panes can sit side by side or form a grid. Each pane scrolls independently and keeps its reading position. FreeMarkdown saves the open documents and layout for the next launch.

[![FreeMarkdown poster showing four documents in a light-theme grid layout](docs/assets/readme/split-grid-poster.png)](docs/assets/readme/split-grid.png)

The posters use sample documents arranged around screenshots from the app. Select a poster to view the original screenshot.

## Open documents and keep reading

Open a `.md` or `.markdown` file, or open a folder to browse its documents in the sidebar. Use the table of contents, light and dark themes, font size, and reading width to adjust the view.

If you associate Markdown files with FreeMarkdown in Windows, opening a document from File Explorer sends it to the existing FreeMarkdown window. The app keeps one instance open. Reading views update when another app changes a file. Press `F5` to refresh the active document.

## Edit text and preview it

Press `Ctrl+Shift+E` to open the editor for the current document. Choose source, split, or preview view. The editor supports autosave and `Ctrl+S`. If another app changes the file while you edit, FreeMarkdown lets you reload, overwrite, or save a copy.

![FreeMarkdown screenshot showing source editing and a split preview in the light theme](docs/assets/readme/editor.png)

## Export an image card

Press `Ctrl+E` to open the card panel. Choose a template and export format, preview the layout, then save a PNG or JPEG. You can also copy a PNG to the clipboard.

![FreeMarkdown screenshot showing card templates, export settings, and a live preview](docs/assets/readme/cards.png)

## Common shortcuts

| Action | Shortcut |
| --- | --- |
| Open a file | `Ctrl+O` |
| Open a folder | `Ctrl+Shift+O` |
| Search Markdown files in the current folder | `Ctrl+Shift+F` |
| Edit the current document | `Ctrl+Shift+E` |
| Open the card panel | `Ctrl+E` |
| Refresh the active document | `F5` |

## Frequently asked questions

### What is FreeMarkdown?

FreeMarkdown is a Windows Markdown reader and editor for comparing local project notes, research, source files, and diagrams. Use split panes to read side by side, or switch to source, split, or preview view to edit.

### Which platforms does it support?

The repository provides a Windows NSIS packaging workflow. It does not have published macOS or Linux installers.

### Do I need an account to open local documents?

No cloud account is required. FreeMarkdown opens documents from local paths. Remote images and links may need a network connection.

### Which Markdown content does it render?

The editor has source, split, and preview views. Rendering supports syntax-highlighted code, LaTeX math, and Mermaid diagrams. FreeMarkdown does not execute code blocks.

### Where can I get an installer?

The GitHub repository has no published Release installer at this time. Follow the [run from source](#run-from-source) steps to build the app on Windows.

## Run from source

The repository provides source code. Prepare a Windows development environment with Node.js, pnpm, and Rust. See [Tauri's setup guide](https://v2.tauri.app/start/prerequisites/) for Windows requirements.

```powershell
git clone https://github.com/PigeonAI-Yang/FreeMarkdown.git
cd FreeMarkdown
pnpm install
pnpm tauri dev
```

Build a Windows installer:

```powershell
pnpm tauri build
```

The installer is written to `src-tauri/target/release/bundle/nsis/`. `pnpm build` only builds the frontend; it does not create a desktop installer.

FreeMarkdown uses Tauri 2, Rust, React, and TypeScript. Markdown rendering uses comrak and supports syntax highlighting, math, and Mermaid diagrams.
