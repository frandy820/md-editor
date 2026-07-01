# MD 编辑器 · MD Editor

![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square)
![tauri](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square)
![size](https://img.shields.io/badge/size-~15MB-9cf?style=flat-square)
![i18n](https://img.shields.io/badge/UI-简中%20%7C%20繁中%20%7C%20EN-4470e0?style=flat-square)

**[中文](#中文) · [English](#english)**

---

## 中文

一款轻量的 Windows 桌面 Markdown 编辑器，**默认所见即所得，支持表格可视化增删改**，内置**简体中文 / 繁体中文 / 英文**三种界面。基于 Tauri 2 + Vditor，单文件便携 exe（约 15 MB），不依赖网络。

### ✨ 功能

- **默认所见即所得**：直接编辑表格——点单元格改内容、光标进表浮出工具栏（上下插行 / 左右插列 / 删行删列 / 对齐 / 删表）、行/列数字框输入数字 + 回车**批量增删**
- **三语界面**：简体中文 / 繁體中文 / English，跟随系统语言并记住你的选择
- **多标签页**：打开多个文件互不覆盖，同路径自动跳转
- **左侧大纲**：点击定位、✕ 删除章节（联动正文）、拖动重排
- **多种打开方式**：双击 .md / 拖拽到窗口 / 命令行参数 / 单实例转发
- **编码自动识别**：UTF-8 / UTF-8(BOM) / GBK
- **隐私**：不请求麦克风（已禁用编辑器内核自带的录音模块）

### 📥 下载

去 [Releases](https://github.com/frandy820/md-editor/releases) 下载 `md-editor.exe`，双击即可运行（便携，免安装）。

**设为 .md 默认程序**：右键任意 .md → 打开方式 → 选 `md-editor.exe` → 勾选「始终使用此应用」。

### 📖 用法

| 操作 | 说明 |
|---|---|
| 编辑表格 | 光标点进表格单元格 → 浮出工具栏；或在行/列数字框输入目标数 + 回车批量增删 |
| 切换语言 | 右上角下拉：简体中文 / 繁體中文 / English |
| 切换模式 | 默认所见即所得；需要看 markdown 源码时点顶部「即时渲染」或 `Ctrl+Alt+M` |
| 大纲 | 左侧：点章节定位 / ✕ 删章节 / 拖动重排 |
| 快捷键 | `Ctrl+B` 加粗、`Ctrl+I` 斜体、`Ctrl+S` 保存、`Ctrl+Alt+M` 切模式 |
| 保存 | 统一写 UTF-8 无 BOM；拖入打开的文件保留原路径，可直接保存 |

### 🛠️ 从源码构建

```bash
git clone https://github.com/frandy820/md-editor.git
cd md-editor
npm install
# 复制 Vditor 本地化资源（CSP 要求本地加载，不走 CDN）
mkdir -p public/vditor-assets && cp -r node_modules/vditor/dist/* public/vditor-assets/dist/
npm run tauri build -- --no-bundle
# 产物：src-tauri/target/release/md-editor.exe
```

开发模式：`npm run tauri dev`

> 打包必须用 `tauri build`（不要用 `cargo build --release`，否则 exe 会连 localhost dev server）。
> 国内 Rust 依赖拉取慢，建议配 [rsproxy](https://rsproxy.cn) 镜像（`~/.cargo/config.toml`）。

### 🧱 技术栈

- [Tauri 2](https://tauri.app/) — Rust 后端 + WebView2 前端
- [Vditor](https://github.com/Vanessa219/vditor) 3.11 — Markdown 编辑器内核
- TypeScript + Vite

### 📄 协议

[MIT](./LICENSE)

---

## English

A lightweight WYSIWYG Markdown editor for Windows with **visual table editing**, offering **Simplified Chinese / Traditional Chinese / English** interfaces. Built with Tauri 2 + Vditor. Single portable `.exe` (~15 MB), no install, no network.

### ✨ Features

- **WYSIWYG by default**: edit tables directly — click a cell to edit, cursor into a table pops up a floating toolbar (insert row above/below, insert column left/right, delete row/column, align, delete table); type a number + Enter in the row/column box to **batch add/remove**
- **3-language UI**: Simplified Chinese / 繁體中文 / English — auto-detects system language and remembers your choice
- **Multi-tab**: open multiple files without overwriting; same path auto-switches
- **Left outline**: click to navigate, ✕ to delete a section (updates body too), drag to reorder
- **Multiple ways to open**: double-click .md / drag into window / command-line arg / single-instance forwarding
- **Encoding auto-detection**: UTF-8 / UTF-8(BOM) / GBK
- **Privacy**: no microphone access (the editor core's built-in recording module is disabled)

### 📥 Download

Grab `md-editor.exe` from [Releases](https://github.com/frandy820/md-editor/releases) — double-click to run (portable, no install).

**Set as default .md app**: right-click any .md → Open with → choose `md-editor.exe` → check "Always use this app".

### 📖 Usage

| Action | How |
|---|---|
| Edit table | Click into a table cell → floating toolbar appears; or type a target number + Enter in the row/column box to batch edit |
| Switch language | Top-right dropdown: 简体中文 / 繁體中文 / English |
| Switch mode | WYSIWYG by default; click top "Instant Rendering" or `Ctrl+Alt+M` to view markdown source |
| Outline | Left panel: click a heading to navigate / ✕ to delete / drag to reorder |
| Shortcuts | `Ctrl+B` bold, `Ctrl+I` italic, `Ctrl+S` save, `Ctrl+Alt+M` toggle mode |
| Save | Always writes UTF-8 without BOM; dragged-in files keep their path for direct save |

### 🛠️ Build from source

```bash
git clone https://github.com/frandy820/md-editor.git
cd md-editor
npm install
# Copy Vditor localized assets (CSP requires local loading, no CDN)
mkdir -p public/vditor-assets && cp -r node_modules/vditor/dist/* public/vditor-assets/dist/
npm run tauri build -- --no-bundle
# Output: src-tauri/target/release/md-editor.exe
```

Dev mode: `npm run tauri dev`

> You must build with `tauri build` (not `cargo build --release`, or the exe will point at the localhost dev server).
> For faster Rust dependency downloads in China, configure the [rsproxy](https://rsproxy.cn) mirror (`~/.cargo/config.toml`).

### 🧱 Tech stack

- [Tauri 2](https://tauri.app/) — Rust backend + WebView2 frontend
- [Vditor](https://github.com/Vanessa219/vditor) 3.11 — Markdown editor core
- TypeScript + Vite

### 📄 License

[MIT](./LICENSE)
