# MD 编辑器（md-editor）

![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square)
![tauri](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square)
![size](https://img.shields.io/badge/size-~14MB-9cf?style=flat-square)

> **English:** A lightweight WYSIWYG Markdown editor for Windows with visual table editing — insert/delete rows & columns, alignment, batch edit via number inputs. Built with Tauri 2 + Vditor. Single portable `.exe` (~14MB), no install, no network.

一款轻量的 Windows 桌面 Markdown 编辑器，**默认所见即所得，支持表格可视化增删改**。基于 Tauri 2 + Vditor，单文件便携 exe（约 14MB），不依赖网络。

## ✨ 功能

- **默认所见即所得**：直接编辑表格——点单元格改内容、光标进表浮出工具栏（上下插行 / 左右插列 / 删行删列 / 对齐 / 删表）、行/列数字框输入数字 + 回车**批量增删**
- **多标签页**：打开多个文件互不覆盖，同路径跳转
- **左侧大纲**：点击定位、✕ 删除章节（联动正文）、拖动重排
- **多种打开方式**：双击 .md / 拖拽到窗口 / 命令行参数 / 单实例转发
- **编码自动识别**：UTF-8 / UTF-8(BOM) / GBK
- 中文界面 + 工具栏 tooltip
- **隐私**：不请求麦克风（已禁用编辑器内核自带的录音模块）

## 📥 下载

去 [Releases](https://github.com/frandy820/md-editor/releases) 下载 `md-editor.exe`，双击即可运行（便携，免安装）。

**设为 .md 默认程序**：右键任意 .md → 打开方式 → 选 `md-editor.exe` → 勾选「始终使用此应用」。

## 📖 用法

| 操作 | 说明 |
|---|---|
| 编辑表格 | 光标点进表格单元格 → 浮出工具栏；或在行/列数字框输入目标数 + 回车批量增删 |
| 切换模式 | 默认所见即所得；需要看 markdown 源码时点顶部「即时渲染」或 `Ctrl+Alt+M` |
| 大纲 | 左侧：点章节定位 / ✕ 删章节 / 拖动重排 |
| 快捷键 | `Ctrl+B` 加粗、`Ctrl+I` 斜体、`Ctrl+S` 保存、`Ctrl+Alt+M` 切模式 |
| 保存 | 统一写 UTF-8 无 BOM；拖入打开的文件保留原路径，可直接保存 |

## 🛠️ 从源码构建

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

## 🧱 技术栈

- [Tauri 2](https://tauri.app/) — Rust 后端 + WebView2 前端
- [Vditor](https://github.com/Vanessa219/vditor) 3.11 — Markdown 编辑器内核
- TypeScript + Vite

## 📄 协议

[MIT](./LICENSE)
