# MD 编辑器 · md-editor — 项目规则

> 轻量 Windows 桌面 Markdown 编辑器：Tauri 2 + Vditor，所见即所得 + 表格可视化编辑，单文件便携 exe（约 15MB），无联网上报。
> 本文件只写本项目独有规则；通用规则见全局 CLAUDE.md。

## 1. 项目定位

- **解决什么**：本地 MD 编辑（表格可视化/多标签/五主题/全盘文件名搜索/多格式导出），单 exe 零依赖分发。
- **当前状态**：交付并持续迭代（v0.3.23，2026-08-31 仍在提交；本地 c13db25 之后多版未推 GitHub）。
- **不做什么**：不做云同步/账号/联网协作；不做所见即所得模式下相对路径图片缩略图（保源码可移植性，导出时才嵌入——已知取舍）。

## 2. 架构与目录

| 项 | 内容 |
|---|---|
| 技术栈 | Tauri 2（Rust）· TypeScript + Vite · Vditor 3（编辑核心）· markdown-it（导出渲染）|
| 前端 | `src/main.ts`（主逻辑大文件：撤销栈/标签页/文件树/导出/全盘索引）· `i18n-zh-CN|zh-TW|en.ts` · `styles.css` · `index.html` |
| 后端 | `src-tauri/src/lib.rs` + `main.rs`（Rust 命令：文件 IO/编码识别/全盘索引/单实例转发） |
| 测试 | `tests/TEST-PLAN.md`（唯一入口：五层体系 + 模块→组映射 + 盲区对策）；脚本在 `F:/claudecode/output/md-editor-typora-scan/`（e2e_user_J_v0321.py · ahk_smoke_v1.ahk） |
| 版本 | package.json 0.1.0（未跟随）；实际版本看 git tag/README（v0.3.23）【版本唯一真值源待确认】 |

**启动链路**：`npm run dev`（Vite）→ `npm run tauri dev`；生产：见下方部署链。

### 五层测试体系（tests/TEST-PLAN.md 是唯一入口，改前必查）

| 层 | 内容 | 触发时机 | 耗时 |
|---|---|---|---|
| L0 | `cd src-tauri && cargo test`（49 用例） | 每次改 Rust | ~10s |
| L1 | 冒烟：e2e_user_J_v0321.py（18 断言）+ ahk_smoke_v1.ahk（6 断言） | 每次交付/部署 | ~3min |
| L2 | 专项回归：按「模块→组映射」跑受影响组 | 改动对应模块 | ~1min/组 |
| L3 | 全量：B/C/D/E/F/G/H/I/J + e2e_fullcheck | 发版前 | ~15min |
| L4 | AHK 真实键鼠（OS 级，走真实副作用不注入 JS） | 发版前（需桌面在线） | ~2min |

### 模块→组映射（改哪个模块跑哪组）

| 改动模块 | 必跑 |
|---|---|
| 撤销/保存/自动保存（main.ts snap*/saveDoc/autosaveDirty） | B、fullcheck(A11)、AHK |
| 标签页（renderTabs/多选/溢出） | B、J |
| 文件树/全盘搜索/定位 | E、H、I、J |
| 主题/样式（styles.css/applyTheme） | D、J |
| 导出/打印 | fullcheck(E)、C |
| lib.rs（Rust 命令） | cargo test + 相关组 |

### AHK 外测铁律（历史实测教训，逐条有效）

- 脚本编码必须 **UTF-8 带 BOM**（无 BOM 按 ANSI 读，中文断言字面量全废=假 FAIL）。
- 键入一律**纯数字**（字母序列会被拼音 IME 组合成中文）。
- 前置：RDP 输入通道在线——会话"运行中"≠通道通；键入零进入+文件纯基线=通道断，等桌面真正活跃。
- 另存对话框路径用**剪贴板粘贴**（Send 打路径被 IME/焦点层吞）。
- 失焦用 `WinActivate ahk_class Progman`；窗口位置每轮漂移，坐标断言只用相对客户区。
- 6 断言：键入+^S / ^Z 一步撤销 / ^Y 重做 / 失焦自动保存 / 双击标签新建+另存 / 干净退出。
- 页面诊断钩子（只读）：`window.__mdUndo/__mdRedo/__mdDocs/__sLog/__zTrace`。

**不可轻易改动的边界（高风险交互区）**：
- **撤销/重做**：自建多步栈（100 步/文档）+ Vditor 自有栈双通道；分步 = 600ms 停顿 + 8 字双阈值，信号源**必须挂原生 input 事件**（`options.input` 被 afterRender 合并，连打整段只发一次——c13db25 根修）；Vditor `resetIcon` 会按其自身栈抢设按钮态（已猴补 no-op）；Backspace/Delete 不触发 input，需 keydown 距上次 >400ms 封口 + keyup 80ms 兜底。
- **IME 组合态**：拼音组合中 Ctrl+Z 先结束组合再回退；AHK 键入一律纯数字（字母会被拼音 IME 组合成中文）。
- **Vditor 热键抢占**：Vditor 元素层拦截合成 KeyboardEvent——带修饰键的真键盘行为只能在 AHK 层验证。
- **blur 保存时序**：失焦自动保存取值有异步竞争，改动保存链路必跑 B 组 + fullcheck(A11)。
- 大文件防护（>256KB 阻止打开）、编码识别（UTF-8/BOM/GBK，保存统一 UTF-8 无 BOM）。

## 3. 常用命令

```bash
cd F:/claudecode/projects/active/md-editor

npm run dev                     # Vite 前端开发
npm run tauri dev               # 桌面壳开发
npm run build                   # tsc && vite build（改 TS 后必跑，类型错误即失败）

# L0 Rust 测试（改 Rust 必跑，~10s）
cd src-tauri && cargo test

# L1 冒烟（交付前，~3min；脚本在 output/md-editor-typora-scan/）
python e2e_user_J_v0321.py                              # 18 断言
"/c/Program Files/AutoHotkey/v2/AutoHotkey64.exe" ahk_smoke_v1.ahk   # 6 断言，需桌面在线

# 生产部署链
npm run build && cd src-tauri && cargo build --release --bins --features tauri/custom-protocol
# → cp 到 F:\software（md5 比对确认）
```

- AHK 前置：RDP 输入通道在线（会话"运行中"≠通道通；键入零进入=通道断，等桌面真正活跃）；脚本必须 UTF-8 **带 BOM**。

## 4. 开发约束

- **改前必做**：查 `tests/TEST-PLAN.md` 「模块→组映射」表，确认改动模块对应哪些测试组。
- **新功能必须同步**：最新组（当前 J）加断言或开新组；断言必须硬校验（文件内容/DOM 几何/进程状态），禁止只查元素存在；改键盘交互必须过 AHK。
- **谨慎修改**：`main.ts` snap*/saveDoc/autosaveDirty（撤销+保存链）· Vditor 实例化 options · `lib.rs` 文件 IO 命令。
- **提交前最小检查**：`npm run build` 零类型错误 · 受影响测试组绿 · 改 Rust 则 cargo test 49 用例绿 · README 版本号与功能描述同步。
- fullcheck 等长脚本的元素引用随版本更新（教训：#file-title v0.3.16 撤掉，脚本没跟，D4a 假阴两版）。

## 5. 验收标准

| 项 | 硬指标 |
|---|---|
| Rust | cargo test 49 用例全绿 |
| 冒烟 | e2e_user_J 18 断言全过 + AHK 6 断言全过（真键鼠、真实副作用） |
| 撤销语义 | 连打一段→撤销按小段回退（非整段飞回）；IME 组合中 Ctrl+Z 不破坏文本；全替/表格批量操作一步一撤销 |
| 保存 | Ctrl+S / 失焦 / 30s 自动三种路径落盘内容一致；版本历史归档生效（50 版/30 天） |
| 导出 | PDF 文本可选中可搜索；docx 表格/脚注/图片真嵌入；相对路径图片导出时嵌入 |
| 分发 | 单 exe（~15MB）干净可用；F:\software 副本 md5 与构建产物一致 |

## 6. 安全与风险

- **隐私**：无联网上报；全盘索引只建文件名/路径，不进内容——新增任何索引/日志功能不得把文档内容写出 exe 目录外。
- **运行日志**（v0.3.23 起）：512KB 滚动留三代；诊断包导出只含系统信息+日志，**不得含文档内容**。
- **须人工确认（R3）**：对外发布/GitHub 推送 · 删除版本历史归档 · 改变保存编码策略（统一 UTF-8 无 BOM 是既定行为）。
- **禁止**：绕过 256KB 大文件防护 · 在 Vditor options.input 上挂撤销分步信号（已被证实失效）· AHK 脚本去 BOM。
- 本地多版未推 GitHub——**推送前须人工过一遍提交序列与敏感信息**。

## 7. 当前重点与待办

### 已知测试盲区对策（历史教训，改测试时必看）

| 盲区 | 对策 |
|---|---|
| CDP 带修饰键字母丢键（z 丢、s 能到） | 真键盘行为只在 AHK 层验证 |
| 合成事件被 Vditor 元素层拦截 | 产品暴露 __md* 只读测试钩子绕过 |
| 中文 SendText 后 isComposing 残留 | AHK 键入一律英文/纯数字 + SetEng() |
| 长脚本元素引用过期（#file-title 教训） | fullcheck 引用随版本更新，防假阴 |
| AHK 无 BOM 中文断言全废 | 脚本保存 UTF-8 带 BOM，改动后先跑一次确认非假 FAIL |

### 功能快捷键速查（改键位冲突时对照）

`Ctrl+Z/Y/Shift+Z` 撤销重做 · `Ctrl+F/H` 查找替换 · `Ctrl+S` 保存 · `Ctrl+P` 打印 · `Ctrl+Shift+O` 快速打开 · `Ctrl+Shift+F` 搜同级内容 · `F8` 专注模式 · `Ctrl+滚轮/0` 缩放复位 · `Ctrl+Click/Shift+Click` 标签多选。新增快捷键前先查 Vditor 内置热键表，冲突一律让位 Vditor 或挂钩子层。

### 修改编辑行为前后的回归验证要求

| 改动类型 | 改前 | 改后 |
|---|---|---|
| 撤销/重做/保存链 | 跑 B 组记基线 | B + fullcheck(A11) + AHK ^Z/^Y 断言 |
| 键盘交互/快捷键 | 记录现有键位 | 对应组 + AHK（CDP 对修饰键字母有盲区） |
| Vditor 实例化 options | — | 冒烟 18 断言（options 变更影响面大） |
| 导出链 | C 组基线 | C + fullcheck(E) + 人工开产物核内容 |
| 文件 IO（lib.rs） | cargo test 49 | cargo test + E/H/I/J |

- **P0**：v0.3.23 运行日志+诊断包已提交——观察真实使用中日志滚动与诊断包导出稳定性。
- **P1**：自建全盘索引（替代 es.exe）首版已上——冷启动索引耗时 1-3 分钟的用户感知优化。
- **P1**：撤销/重做六处病灶已闭环（a4d258a）——回归 B 组+fullcheck(A11) 保持全绿，防复发。
- **待确认**：GitHub 远端同步策略（多版积压未推，推送范围需用户拍板）。
- **待确认**：package.json version 0.1.0 是否改为随发版递增（当前版本真值在 README/git）。

### i18n 与文案纪律

- 三份语言文件 `i18n-zh-CN.ts` / `i18n-zh-TW.ts` / `i18n-en.ts` **同步改**——加/改任何 UI 文案必须三处齐动，漏一份即混语界面。
- 界面文案改动后跑 J 组（标签页/工具栏断言含文案匹配）。
- 中文文案行注意全角标点不得混入代码标识符（历史坑：整块 script 语法死）。

### 导出格式与验证要点

| 格式 | 关键验收点 |
|---|---|
| PDF | 矢量、文本可选中可搜索；分页不裁断表格行 |
| HTML | 带样式/纯净两档；相对路径图片已嵌入 |
| PNG 长图 | 超长文档分片多图，序号连续 |
| docx | 原生编号嵌套列表、表格、脚注、图片真嵌入（非链接） |

## 8. 回滚

- 回滚走本地 git 仓库（tag/commit）；注意当前本地领先远端（v0.3.23，c13db25 之后多版未推 GitHub）——回滚只动本地，推送范围另行拍板。
