# MD 编辑器 · MD Editor

![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square)
![tauri](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square)
![size](https://img.shields.io/badge/size-~15MB-9cf?style=flat-square)
![i18n](https://img.shields.io/badge/UI-中文%20%7C%20EN-4470e0?style=flat-square)

![MD 编辑器 · 表格可视化编辑](docs/screenshots/table-edit.png)

**[中文](#中文) · [English](#english)**

---

## 中文

一款轻量的 Windows 桌面 Markdown 编辑器，**默认所见即所得，支持表格可视化增删改**，内置**中英双语界面**（中文支持简体/繁体）。基于 Tauri 2 + Vditor，单文件便携 exe（约 15 MB），不依赖网络。

> 📑 目录：[功能](#-功能) · [下载](#-下载) · [用法](#-用法) · [竞品对比](#-竞品对比) · [构建](#-从源码构建) · [技术栈](#-技术栈)

### ✨ 功能

**编辑**
- **默认所见即所得**：直接编辑表格——点单元格改内容、光标进表浮出工具栏（上下插行 / 左右插列 / 删行删列 / 对齐 / 删表）、行/列数字框输入数字 + 回车**批量增删**、列宽拖动（存盘零样式污染）
- **查找替换**：`Ctrl+F` / `Ctrl+H`，全部匹配高亮 + 计数导航 + 逐个/全部替换（可撤销），支持**正则模式**（`$1` 分组引用）
- **内容增强**：数学公式（KaTeX 行内/块级即时渲染）、Mermaid 图表（mindmap、timeline、flowchart…）、代码块行号、emoji `:smile:` 自动补全（1500+）、英文拼写检查
- **中文排版**：渲染与导出时中英文之间自动加空格（不改源文）
- **版本历史**：每次保存前自动归档旧版（每文件 50 版 / 30 天），🕘 一键对比恢复
- **多标签页**：`Ctrl+Click` 多选、`Shift+Click` 范围多选批量关闭；右键关闭其它/左侧/右侧/全部；**标签栏空白双击新建文档**（Notepad++ 式）；标签过多时**自动多行折行**，一个不漏
- **撤销/重做**：`Ctrl+Z` 多步撤销 / `Ctrl+Y`、`Ctrl+Shift+Z` 重做——按输入停顿自动分步（每文档最多 100 步），逐字打的一段文字一次撤完，两段之间隔了一下就是两步

**文件管理（侧栏「文件」页）**
- **此电脑资源树**：盘符常驻（进入任何盘其它盘符不消失）、目录懒展开、地址栏跳转、当前文件自动定位；**非文本文件也可见**（灰显显示，点击即在文件夹中打开，不再"无匹配"）
- **右键文件管理**：新建 Markdown / TXT / 文件夹、重命名（联动打开中的标签）、删除（级联关闭相关标签）、在文件夹中显示、复制路径
- **最近文件** + 快速打开 `Ctrl+Shift+O`
- **搜同级文件内容** `Ctrl+Shift+F`：按关键词搜当前文件所在目录的全部文本文件内容，结果点击跳转
- **全盘搜文件名（可选）**：文件名过滤框融合 [Everything](https://www.voidtools.com/)——毫秒级模糊搜索全盘文件，支持 Everything 语法（`ext:md`、`path:`、空格 AND…）；结果**双击在资源树中定位并展开所在路径**（文件夹则直接展开）；文件名 / 路径两列宽度可拖动，长文件名拖宽看全

**外观与其它**
- **中英双语界面**：中文（简体 / 繁体）/ English，跟随系统语言并记住你的选择
- **主题**：浅色 / 深色 / 护眼绿 / 墨黑（纯黑 OLED）/ 暖纸（米黄纸感）五选一
- **标题分级配色**：H1–H6 六级标题各有专属颜色，扫一眼就能分清层级
- **左侧大纲**：点击定位、✕ 删除章节（联动正文）、拖动重排、关键字过滤
- **多种打开方式**：双击 .md / 拖拽到窗口 / 命令行参数 / 单实例转发
- **编码自动识别**：UTF-8 / UTF-8(BOM) / GBK（标题栏显示实际编码）
- **专注模式**：`F8` 淡化非当前段落
- **自动保存**：已有路径的文档每 30 秒及窗口失焦时自动落盘
- **显示比例**：Word 式右下角缩放滑杆（50%~200%），`Ctrl+滚轮` 缩放、`Ctrl+0` 复位——只缩正文内容区，设置重启后记住
- **导出中心**：顶部「导出 ▾」——PDF（矢量）、HTML（带样式 / 纯净两档）、PNG 长图（超画布上限自动分片，Typora 官方不支持）、Word .docx（标题/嵌套列表(Word原生编号)/表格/代码/链接/图片真嵌入/脚注）
- **打印**：`Ctrl+P` 系统打印对话框
- **粘贴截图落地**：`Ctrl+V` 粘贴图片自动保存到文档旁 `assets/`，正文以**相对路径**引用——源码整个文件夹拷走图片不丢
- **字数统计**：右下角实时显示（简中「字」/ English "words"）
- **大文件防护**：超过 256 KB 的文本弹窗提示并阻止打开（防卡死）
- **隐私**：不请求麦克风（已禁用编辑器内核自带的录音模块），无任何联网上报

> ⚠️ 已知取舍：所见即所得模式下，本地相对路径图片在编辑器内**不显示缩略图**（源码保持相对路径以确保可移植；导出 PDF/HTML/PNG/Word 时会自动嵌入图片）。

<details>
<summary>📸 界面截图</summary>

![主界面（简体中文）](docs/screenshots/main-zh.png)

![英文界面](docs/screenshots/en.png)

</details>

### 📥 下载

[![下载 md-editor.exe](https://img.shields.io/badge/⬇下载-md--editor.exe-4470e0?style=for-the-badge)](https://github.com/frandy820/md-editor/releases/latest)

去 [Releases](https://github.com/frandy820/md-editor/releases) 下载 `md-editor.exe`，双击即可运行（便携，免安装）。

**设为 .md 默认程序**：右键任意 .md → 打开方式 → 选 `md-editor.exe` → 勾选「始终使用此应用」。

### 📖 用法

| 操作 | 说明 |
|---|---|
| 编辑表格 | 光标点进表格单元格 → 浮出工具栏；或在行/列数字框输入目标数 + 回车批量增删 |
| 切换语言 | 右上角下拉：简体中文 / 繁體中文 / English |
| 切换主题 | 右上角下拉：浅色 / 深色 / 护眼 / 墨黑 / 暖纸 |
| 切换模式 | 默认所见即所得；需要看 markdown 源码时点顶部「即时渲染」或 `Ctrl+Alt+M` |
| 大纲 | 左侧：点章节定位 / ✕ 删章节 / 拖动重排 / 顶部框过滤 |
| 文件树 | 左侧「文件」页：此电脑+盘符常驻；地址栏输入路径回车跳转；右键新建/重命名/删除/资源管理器显示 |
| 全盘搜文件名 | 「文件」页过滤框输入关键词（需 Everything，见下方可选集成）；结果**双击**=在资源树定位并展开路径，文件名/路径列宽可拖 |
| 搜内容 | `Ctrl+Shift+F`：搜当前文件所在目录全部文本文件内容 |
| 快速打开 | `Ctrl+Shift+O`：按文件名过滤最近文件回车打开 |
| 新建文档 | 标签栏空白处**双击** |
| 数学公式 | 行内 `$x^2$`、块级 `$$…$$`，KaTeX 即时渲染 |
| 图表 | mermaid 代码块（mindmap / timeline / flowchart…），光标移出代码块即渲染 |
| emoji | 输入 `:` 加关键词（如 `:smi`）弹出补全 |
| 查找替换 | `Ctrl+F` 查找 / `Ctrl+H` 带替换；`Enter`/`Shift+Enter` 上下跳转，`Esc` 关闭；`.*` 开关切正则 |
| 版本历史 | 🕘 按钮：左侧列表右侧预览，点恢复（标脏不直接写盘） |
| 专注模式 | `F8` 淡化其他段落 |
| 缩放 | 右下角滑杆拖动 / `Ctrl+滚轮` / `Ctrl+0` 复位（50%~200%，只缩正文） |
| 导出 | 顶部「导出 ▾」：PDF / HTML 两档 / PNG 长图 / Word |
| 打印 | `Ctrl+P`（系统打印对话框） |
| 粘贴截图 | 直接 `Ctrl+V`，图片自动存到文档旁 `assets/`，正文引用相对路径 |
| 粘贴跟随 | 粘贴长文本后视口自动滚到光标 |
| 自动保存 | 已保存过的文档每 30s 及失焦时自动落盘（标题 ● 消失即已存） |
| 快捷键 | `Ctrl+B` 加粗、`Ctrl+I` 斜体、`Ctrl+S` 保存、`Ctrl+Z`/`Ctrl+Y` 撤销重做、`Ctrl+Alt+M` 切模式 |
| 保存 | 统一写 UTF-8 无 BOM；拖入打开的文件保留原路径，可直接保存 |

### 🆚 竞品对比

| 项目 | 免费 | 便携免安装 | 表格可视化编辑 | 文件树 | 全盘搜索 | 中英双语 | 开源 |
|---|---|---|---|---|---|---|---|
| **md-editor** | ✅ | ✅ 单文件 exe | ✅ 浮层 + 数字框批量 | ✅ 盘符常驻+右键管理 | ✅ 融合 Everything | ✅ | ✅ |
| Typora | ⚠️ 收费 | ❌ 需安装 | ⚠️ 基础 | ✅ | ❌ | ✅ | ❌ |
| MarkText | ✅ | ❌ 需安装 | ⚠️ 基础 | ⚠️ | ❌ | ⚠️ | ✅ |
| Obsidian | ✅ | ❌ 需安装 | ⚠️ 需插件 | ✅ 库内 | ⚠️ 库内 | ✅ | ❌ |

### 🔍 全盘搜索：Everything 可选集成

「文件」页的文件名过滤框同时具备**全盘搜索**能力——输入关键词即调本地 [Everything](https://www.voidtools.com/)（voidtools 出品的免费文件名搜索工具）的索引，毫秒级返回全盘命中，支持其全部搜索语法（`ext:md`、`path:src`、空格=AND、`/ad` 只看文件夹、通配符、正则等）。

开启方法（可选，不开不影响其它功能）：

1. 本机安装并运行 [Everything](https://www.voidtools.com/zh-cn/)（免费）
2. 下载官方命令行工具 [es.exe](https://www.voidtools.com/downloads/)（约 140 KB），放到 `md-editor.exe` 同目录

命中结果点击直达：文本文件打开编辑 / 目录在树中定位 / 其它类型在资源管理器中显示。

> Everything 与 es.exe 是 voidtools 的免费软件，本仓库不分发、不包含它们，仅在用户自行安装后通过本地 IPC 查询；本项目与 voidtools 无隶属关系。

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
> **v0.3.3 起静态 CRT 构建法**（tauri-cli 调 cargo 会绕过 rustflags 配置且 target 缓存混合时会静默回退动态链接）：
> `npm run build` 之后 `cd src-tauri && cargo build --release --bins --features tauri/custom-protocol`
> （`custom-protocol` 是 dist 嵌入开关，漏掉它 exe 就连 devUrl；改 rustflags 后必须 `cargo clean`）。
> 交付前用 PE 导入表验证：无 `vcruntime140/msvcp/api-ms-win-crt-*` 依赖。
> 国内 Rust 依赖拉取慢，建议配 [rsproxy](https://rsproxy.cn) 镜像（`~/.cargo/config.toml`）。

### 🧱 技术栈

- [Tauri 2](https://tauri.app/) — Rust 后端 + WebView2 前端
- [Vditor](https://github.com/Vanessa219/vditor) 3.11 — Markdown 编辑器内核
- TypeScript + Vite

### 📦 依赖与分发（v0.3.3 起）

**exe 已自含**：C/VC++ 运行库（`+crt-static` 静态链接，不依赖 vcruntime140/UCRT DLL）、
WebView2 Loader、前端全部 JS/CSS 资源。

**依赖系统（无法融入 exe 的边界）**：

| 组件 | 缺失后果 | 说明 |
|---|---|---|
| WebView2 Runtime | 启动弹中文指引（v0.3.3 预检） | Win10 1803+/Win11 自带；[离线包下载](https://developer.microsoft.com/microsoft-edge/webview2/) |
| Microsoft Edge | 仅 PDF 导出不可用（有报错提示） | Win10/11 必带 |

**分发给他人**：拷走单个 `md-editor.exe` 即可（免安装、免 VC++ 运行库）。

### 📄 协议

[MIT](./LICENSE)

---

## English

A lightweight WYSIWYG Markdown editor for Windows with **visual table editing**, offering a **bilingual interface** (English / Chinese, with both Simplified & Traditional). Built with Tauri 2 + Vditor. Single portable `.exe` (~15 MB), no install, no network.

> 📑 Contents: [Features](#-features) · [Download](#-download) · [Usage](#-usage) · [Comparison](#-comparison) · [Build](#-build-from-source) · [Tech stack](#-tech-stack)

### ✨ Features

**Editing**
- **WYSIWYG by default**: edit tables directly — click a cell to edit, cursor into a table pops up a floating toolbar (insert row above/below, insert column left/right, delete row/column, align, delete table); type a number + Enter in the row/column box to **batch add/remove**; drag column widths (zero style pollution in saved files)
- **Find & replace**: `Ctrl+F` / `Ctrl+H` — highlight all matches, count & navigate, replace one/all (undoable), with a **regex mode** (`$1` group references)
- **Rich content**: math formulas (KaTeX inline & block, live rendering), Mermaid diagrams (mindmap, timeline, flowchart…), code line numbers, emoji `:smile:` autocomplete (1500+), English spell-check
- **CJK typography**: auto-spacing between CJK & Latin text on render & export (source untouched)
- **Version history**: every save archives the previous version first (50 versions / 30 days per file); 🕘 to compare and restore
- **Multi-tab**: `Ctrl+Click` multi-select, `Shift+Click` range-select for batch close; right-click to close others/left/right/all; **double-click empty tab-bar space to create a new document** (Notepad++ style); tabs **wrap onto multiple rows** when they overflow — none hidden
- **Undo/redo**: `Ctrl+Z` multi-step undo / `Ctrl+Y`, `Ctrl+Shift+Z` redo — steps split by typing pauses (up to 100 per document); a burst of typing undoes as one step, two bursts separated by a pause undo as two

**File management ("Files" side pane)**
- **"This PC" tree**: drive letters always visible (never disappear when you enter a drive), lazy folder expansion, address bar navigation, auto-locate the current file; **non-text files are visible too** (grayed out — click to reveal in their folder, no more "no match")
- **Right-click file management**: new Markdown / TXT / folder, rename (follows open tabs), delete (cascades to close related tabs), show in folder, copy path
- **Recent files** + quick open `Ctrl+Shift+O`
- **Search sibling files' content** `Ctrl+Shift+F`: grep all text files in the current file's folder, click a hit to jump
- **Drive-wide filename search (optional)**: the filename filter box integrates with [Everything](https://www.voidtools.com/) — millisecond fuzzy search across all drives, full Everything syntax (`ext:md`, `path:`, space = AND…); **double-click a hit to locate & expand its path in the tree** (folders expand directly); the filename / path columns are drag-resizable to read long names

**Appearance & misc**
- **Bilingual UI (English / Chinese)**: Chinese supports both Simplified & Traditional — auto-detects system language and remembers your choice
- **Themes**: light / dark / eye-friendly green / OLED black / warm paper
- **Heading colors**: H1–H6 each has its own color, so levels are told apart at a glance
- **Left outline**: click to navigate, ✕ to delete a section (updates body too), drag to reorder, keyword filter
- **Multiple ways to open**: double-click .md / drag into window / command-line arg / single-instance forwarding
- **Encoding auto-detection**: UTF-8 / UTF-8(BOM) / GBK (actual encoding shown in the title bar)
- **Focus mode**: `F8` dims other paragraphs
- **Autosave**: files with a path are saved every 30s and on window blur
- **Zoom**: Word-style slider at the bottom-right (50%–200%), `Ctrl+wheel` to zoom, `Ctrl+0` to reset — zooms the content area only; the level persists across restarts
- **Export center**: top "Export ▾" — PDF (vector), HTML (styled / plain), PNG long image (auto-sliced past the canvas limit — Typora can't), Word .docx (headings/nested lists w/ native numbering/tables/code/links/embedded images/footnotes)
- **Print**: `Ctrl+P` (system print dialog)
- **Paste screenshots**: `Ctrl+V` an image and it is saved to `assets/` beside the document, referenced by a **relative path** — move the folder, keep the images
- **Word count**: live counter at the bottom-right corner ("words" / 「字」)
- **Large-file guard**: text files over 256 KB prompt and are not opened (prevents freezing)
- **Privacy**: no microphone access (the editor core's built-in recording module is disabled), no network telemetry

> ⚠️ Known trade-off: in WYSIWYG mode, local relative-path images show **no thumbnail** inside the editor (the source keeps relative paths for portability; images are embedded automatically on PDF/HTML/PNG/Word export and rich-text copy).

<details>
<summary>📸 Screenshots</summary>

![Main UI (Simplified Chinese)](docs/screenshots/main-zh.png)

![English UI](docs/screenshots/en.png)

</details>

### 📥 Download

[![Download md-editor.exe](https://img.shields.io/badge/⬇Download-md--editor.exe-4470e0?style=for-the-badge)](https://github.com/frandy820/md-editor/releases/latest)

Grab `md-editor.exe` from [Releases](https://github.com/frandy820/md-editor/releases) — double-click to run (portable, no install).

**Set as default .md app**: right-click any .md → Open with → choose `md-editor.exe` → check "Always use this app".

### 📖 Usage

| Action | How |
|---|---|
| Edit table | Click into a table cell → floating toolbar appears; or type a target number + Enter in the row/column box to batch edit |
| Switch language | Top-right dropdown: 简体中文 / 繁體中文 / English |
| Switch theme | Top-right dropdown: light / dark / eye-friendly / OLED black / warm paper |
| Switch mode | WYSIWYG by default; click top "Instant Rendering" or `Ctrl+Alt+M` to view markdown source |
| Outline | Left panel: click a heading to navigate / ✕ to delete / drag to reorder / filter box on top |
| File tree | "Files" pane: This PC + drives always visible; type a path in the address bar + Enter; right-click for new/rename/delete/reveal |
| Drive-wide search | type keywords in the "Files" pane filter box (requires Everything — see optional integration below); **double-click** a hit to locate it in the tree; columns are drag-resizable |
| Content search | `Ctrl+Shift+F`: grep all text files in the current file's folder |
| Quick open | `Ctrl+Shift+O`: filter recent files by name, Enter to open |
| New document | **double-click** empty tab-bar space |
| Math | Inline `$x^2$`, block `$$…$$` — rendered live via KaTeX |
| Diagrams | mermaid code blocks (mindmap / timeline / flowchart…) render on blur |
| Emoji | Type `:` + keyword (e.g. `:smi`) for autocomplete |
| Find & replace | `Ctrl+F` find / `Ctrl+H` with replace; `Enter`/`Shift+Enter` navigate, `Esc` close; `.*` toggles regex |
| Version history | 🕘 button: list on the left, preview on the right; restore marks the doc dirty (no direct write) |
| Focus | `F8` dim others |
| Zoom | drag the bottom-right slider / `Ctrl+wheel` / `Ctrl+0` reset (50%–200%, content only) |
| Export | top "Export ▾": PDF / HTML ×2 / PNG / Word |
| Print | `Ctrl+P` (system print dialog) |
| Paste image | just `Ctrl+V` — saved to `assets/` beside the doc, referenced relatively |
| Paste follow | view scrolls to the caret after pasting |
| Autosave | Documents with a path save every 30s & on blur (● in title disappears once saved) |
| Shortcuts | `Ctrl+B` bold, `Ctrl+I` italic, `Ctrl+S` save, `Ctrl+Z`/`Ctrl+Y` undo/redo, `Ctrl+Alt+M` toggle mode |
| Save | Always writes UTF-8 without BOM; dragged-in files keep their path for direct save |

### 🆚 Comparison

| Project | Free | Portable (no install) | Visual table editing | File tree | Drive-wide search | Bilingual (EN/中) | Open source |
|---|---|---|---|---|---|---|---|
| **md-editor** | ✅ | ✅ single .exe | ✅ toolbar + batch | ✅ always-visible drives + right-click manage | ✅ Everything integration | ✅ | ✅ |
| Typora | ⚠️ paid | ❌ install | ⚠️ basic | ✅ | ❌ | ✅ | ❌ |
| MarkText | ✅ | ❌ install | ⚠️ basic | ⚠️ | ❌ | ⚠️ | ✅ |
| Obsidian | ✅ | ❌ install | ⚠️ plugin | ✅ vault-only | ⚠️ vault-only | ✅ | ❌ |
| Easy MD | ✅ | ❌ | ⚠️ weak | ⚠️ | ❌ | ✅ | — |

### 🔍 Drive-wide search: optional Everything integration

The "Files" pane's filename filter box doubles as a **drive-wide search** — keywords are queried against the local [Everything](https://www.voidtools.com/) index (voidtools' free filename search tool) with millisecond results and full Everything syntax (`ext:md`, `path:src`, space = AND, `/ad` folders only, wildcards, regex…).

To enable (optional — everything else works without it):

1. Install and run [Everything](https://www.voidtools.com/downloads/) (free)
2. Download the official [es.exe](https://www.voidtools.com/downloads/) CLI (~140 KB) and place it next to `md-editor.exe`

Click a hit to jump straight to it: text files open in the editor / folders locate in the tree / other types reveal in Explorer.

> Everything and es.exe are free software by voidtools. This repository does not distribute or contain them; integration happens purely via local IPC after the user installs them. This project is not affiliated with voidtools.

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
