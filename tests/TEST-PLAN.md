# MD 编辑器测试方案（v0.3.21 起）

> 目标：新功能进来先冒烟、后回归；真实用户行为用 AHK 模拟（OS 级键鼠），功能断言走 CDP/文件系统硬校验。
> 本文是唯一入口：改任何功能前先看「模块→组映射」，改完跑对应组 + 冒烟集。

## 一、五层体系

| 层 | 内容 | 触发时机 | 耗时 |
|---|---|---|---|
| L0 | `cd src-tauri && cargo test`（49 用例） | 每次改 Rust | ~10s |
| L1 | 冒烟集：`e2e_user_J_v0321.py` + `ahk_smoke_v1.ahk` | 每次交付/部署 | ~3min |
| L2 | 专项回归：按「模块→组映射」跑受影响组 | 改动对应模块时 | 每组 ~1min |
| L3 | 全量：B/C/D/E/F/G/H/I/J + `e2e_fullcheck_v037.py` | 发版前 | ~15min |
| L4 | AHK 真实键鼠：`ahk_smoke_v1.ahk`（6 断言） | 发版前（需桌面在线） | ~2min |

## 二、模块→组映射

| 改动模块 | 必跑 |
|---|---|
| 撤销/保存/自动保存（main.ts snap*/saveDoc/autosaveDirty） | B、fullcheck(A11)、AHK |
| 标签页（renderTabs/多选/溢出） | B、J |
| 文件树/ES 搜索/定位（makeTreeNode/runEsSearch/esLocateTree） | E、H、I、J |
| 主题/样式（styles.css/applyTheme） | D、J |
| 导出/打印 | fullcheck(E)、C |
| lib.rs（Rust 命令） | cargo test + 相关组 |

## 三、冒烟集命令

```bash
cd output/md-editor-typora-scan
python e2e_user_J_v0321.py          # 18 断言（v0.3.21 全功能）
"/c/Program Files/AutoHotkey/v2/AutoHotkey64.exe" ahk_smoke_v1.ahk   # 需桌面在线
```

## 四、AHK 脚本说明（ahk_smoke_v1.ahk）

- 6 断言：键入+^S / ^Z 一步撤销 / ^Y 重做 / 失焦自动保存 / 双击标签新建+另存对话框 / 干净退出。
- 断言走真实副作用（文件内容/另存对话框/进程存活），不注入页面 JS。2026-08-30 全 6 PASS 实测通过。
- **脚本编码必须是 UTF-8 带 BOM**（AHK v2 无 BOM 按 ANSI 读，中文断言字面量全废=假 FAIL）。
- **键入一律纯数字**（如 1357924680）：中文拼音 IME 会把字母序列逐个组合成中文（"ahktyped123"→"安徽空调也碰到23"），数字直通无组合。
- **前置条件：RDP 输入通道在线**——会话「运行中」≠通道通（实测时通时断）：键入零进入+文件全程纯基线=通道断了，等用户桌面真正活跃再跑；通道断时 SendInput/SendEvent/keybd_event 三层全失效。
- **另存对话框路径输入用剪贴板粘贴**（`A_Clipboard := path; Send "^v"`）：Send 打路径会被 IME/焦点层吞。
- 失焦用 `WinActivate ahk_class Progman`（点桌面固定坐标会弹开始菜单遮挡窗口）；窗口位置尺寸每轮会漂（产品记住上次窗口），坐标断言只用相对客户区计算。
- 诊断钩子（页面内）：`window.__zTrace`（z/y keydown 守卫状态）、`window.__sLog`（每次保存的取值+栈深）、`window.__mdDocs`（docs 只读）、`window.__mdUndo/__mdRedo`。

## 五、新功能接入铁律

1. 新功能先在最新组（当前 J）加断言，或开新组 K/L…，断言必须走硬校验（文件内容/DOM 几何/进程状态），禁止只查元素存在。
2. 改键盘交互的功能必须过 AHK（CDP 对带修饰键字母键有盲区：z 丢、s 能到；合成 KeyboardEvent 被 Vditor 元素层拦截）。
3. 测试钩子：`window.__mdUndo/__mdRedo/__mdDocs`（只读），e2e 用，不进用户文档。
4. 部署链：`npm run build` → `cd src-tauri && cargo build --release --bins --features tauri/custom-protocol` → cp 到 F:\software（md5 比对）。
5. **fullcheck 等长脚本的元素引用随版本更新**（教训：#file-title 在 v0.3.16 被撤掉，脚本没跟，D4a 假阴两版）。

## 六、七大测试盲区对策（历史教训沉淀）

| 盲区 | 对策 |
|---|---|
| CDP 带修饰键字母丢键 | 真键盘行为只在 AHK 层验证 |
| 合成事件被元素层拦截 | 产品暴露 __md* 测试钩子绕过 |
| 中文 SendText 后 isComposing 残留 | AHK 键入一律英文+SetEng() |
| 窗口标题不随 document.title 同步 | 断言用 ahk_exe/类名，不用标题 |
| mkdtemp 不自清 | 脚本开头 rmtree 清残留 |
| localStorage 持久化污染基线 | 断言前显式清 |
| e2e 假绿（skip/超时即过） | 看 tail 汇总数，逐 FAIL 归零 |
