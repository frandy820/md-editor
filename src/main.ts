import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog, confirm } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
// 拖放改用 HTML5（dragDropEnabled:false），不再用 Tauri 原生 getCurrentWebview 监听
import Vditor from "vditor";
import "vditor/dist/index.css";
import vditorCssText from "vditor/dist/index.css?raw";
// 导出侧公式排版（KaTeX HTML 输出需要；与 Vditor 编辑器同源同版本，构建期内联）
import katexCssText from "vditor/dist/js/katex/katex.min.css?raw";
// 本地中文 i18n（从 vditor zh_CN.js 转成 ESM 值导入）：作为 options.i18n 注入，
// Vditor 走 else 分支直接使用，不再从 unpkg CDN 动态加载 zh_CN.js（国内 404），且符合 CSP
import zhCNI18n from "./i18n-zh-CN";
import zhTWI18n from "./i18n-zh-TW";
import enI18n from "./i18n-en";

let vditor: Vditor | null = null;
let outlineTimer: number | null = null;
let suppressInput = false; // setValue 时抑制 input 回调（避免切换/联动标签误标 dirty）
let bootFocused = false; // 启动首次挂载后焦点进编辑区（after 回调 flag，防模式切换重抢）

// v0.3.21 撤销/重做/保存键盘拦截——必须在模块顶层注册（早于 new Vditor）：
// Vditor 也在 window 捕获层挂热键且「先注册先执行」，晚注册的 handler 收不到 ⌘Z
//（AHK 真实键盘 + ztrace 实证：s 到达、z 被抢占）。函数声明提升保证此处可引用下方函数。
window.addEventListener("keydown", (e) => {
  const isZY = e.key === "z" || e.key === "Z" || e.key === "y" || e.key === "Y";
  // 组合态（IME 输入中）只放行 Ctrl+Z/Y：组合中撤销=打断组合并回退（Word/Typora 同语义），
  // 静默放行会落入 Chromium 原生 undo 与自建栈双轨互踩（AHK 实测 composing 残留拦死 ^z）
  if (e.isComposing && !(isZY && (e.ctrlKey || e.metaKey))) return;
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const inEditor = !!(e.target as Element | null)?.closest?.(".vditor");
  if ((e.key === "z" || e.key === "Z") && inEditor) {
    e.preventDefault(); e.stopPropagation();
    if (e.shiftKey) docRedo(); else docUndo();
  } else if ((e.key === "y" || e.key === "Y") && inEditor) {
    e.preventDefault(); e.stopPropagation();
    docRedo();
  } else if ((e.key === "s" || e.key === "S")) {
    // Ctrl+S：此前只有按钮/关闭确认/30s 自动保存，快捷键从未绑定（版本历史文案却宣称它）
    e.preventDefault(); e.stopPropagation();
    const d = activeDoc();
    if (d) void saveDoc(d);
  } else if ((e.key === "k" || e.key === "K") && !e.shiftKey) {
    // v0.4.0 命令面板：⚠ Vditor 的 ⌘K=插入链接且同在 window 捕获层「先注册先执行」——
    // 拦截必须与撤销键同批次（模块顶层），boot 里注册会晚于它而收不到
    e.preventDefault(); e.stopPropagation();
    toggleCmdk();
  }
}, true);
// v0.4.0 阅读专注 Ctrl+Shift+D：同顶层捕获（焦点在编辑区时元素层会截获，Ctrl+F/H 同因）
window.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
  if (e.key === "D" || e.key === "d") {
    e.preventDefault(); e.stopPropagation();
    setReadingFocus(!readingFocusOn);
  }
}, true);
let currentMode: "ir" | "wysiwyg" = "wysiwyg"; // 当前编辑模式（默认所见即所得，可直接编辑表格；可切回即时渲染）
let vditorInited = false; // Vditor 是否已完成首次初始化（模式切换重建时不重跑 openDoc/pendingFile）
let switchInFlight = false; // 模式切换重建中（destroy→after 之间），抑制重入避免并发销毁/重复实例/内容丢失

// ---- i18n 国际化（简中 / 繁中 / 英文）----
type Lang = "zh-CN" | "zh-TW" | "en";
const VDITOR_I18N: Record<Lang, typeof zhCNI18n> = { "zh-CN": zhCNI18n, "zh-TW": zhTWI18n, "en": enI18n };
const VDITOR_LANG: Record<Lang, "zh_CN" | "zh_TW" | "en_US"> = { "zh-CN": "zh_CN", "zh-TW": "zh_TW", "en": "en_US" };

const UI_TEXT: Record<Lang, Record<string, string>> = {
  "zh-CN": {
    menuFile: "文件", menuView: "视图", openMenu: "打开…", printMenu: "打印…",
    open: "打开", save: "保存", openTip: "打开 .md/.markdown/.txt 文件（可拖入窗口）", saveTip: "保存当前文档（Ctrl+S）", welcomeName: "欢迎", untitled: "未命名", noDoc: "（无）",
    emptyHint: "点击顶部「打开」按钮，或把 .md 文件拖入窗口，开始编辑",
    noHeadings: "（暂无标题：用 # 添加章节）",
    noOpenFile: "（暂无打开的文件：点顶部「打开」或把 .md 拖入窗口）",
    deleteChapter: "删除该章节（含正文）", closeTab: "关闭",
    openFail: "打开失败：", saveFail: "保存失败：", closeFail: "关闭失败：",
    saveEmptySuf: "」内容为空，已跳过保存（避免清空文件）",
    delTitle: "删除章节", delConfirmSuf: "」及其所有子内容？",
    closeSaveMsg: "有未保存的修改，是否保存？", closeSave: "保存并关闭", closeDiscard: "不保存关闭", closeCancel: "取消",
    modeWYSIWYG: "所见即所得", modeIR: "即时渲染", switchToIR: "切回即时渲染", switchToWYSIWYG: "所见即所得",
    modeWYSIWYGTip: "当前：所见即所得模式（可直接编辑表格）", modeIRTip: "当前：即时渲染模式",
    switchToIRTip: "切回即时渲染模式（Ctrl+Alt+M）", switchToWYSIWYGTip: "切到所见即所得模式以编辑表格（Ctrl+Alt+M）",
    panelTitle: "大纲 · 点击定位 · ✕删除 · 拖动重排",
    export: "导出 ▾", exportPdf: "PDF（矢量）", exportHtmlStyled: "HTML（带样式）", exportHtmlPlain: "HTML（纯净）", exportPng: "图片 PNG（长图）", exportDocx: "Word (.docx)", exportNoDoc: "（请先打开或新建文档再导出）", exportEmptyConfirm: "文档内容为空，仍要导出吗？", exportFail: "导出失败：", exporting: "正在导出 PDF，请稍候…",
    exportDone: "导出完成：",
    exportImageSlices: "文档较长，已分片导出多张 PNG：", pasteImgUntitledHint: "（提示：文档尚未保存，截图存到了应用目录，保存文档后建议用「另存为」整理）",
    exportStagePage: "正在生成页面…", exportStagePrint: "正在打印为 PDF…", exportStageSave: "正在保存文件…",
    fontSizeTip: "字号：先框选文字，再选字号",
    selectFirstTip: "请先在编辑区框选要改字号的文字，再选字号",
    wordCount: "字",
    focusMode: "打字专注", findBtn: "查找",
    focusTip: "打字专注（F8）：淡化非当前段落，适合写作",
    readingFocus: "阅读专注",
    findTip: "查找替换（Ctrl+F / Ctrl+H）",
    findPlaceholder: "查找…", replacePlaceholder: "替换为…",
    replaceOne: "替换", replaceAll: "全部替换",
    replaceManyConfirm: "匹配超过 500 处，仍要全部替换吗？",
    histBtn: "历史", histTitle: "版本历史（保存时自动归档，每文件留 50 版/30 天）", histEmpty: "暂无历史版本——本文件保存覆盖旧版后才会产生归档",
    histRestore: "恢复此版本", histRestored: "已载入所选版本（未保存），确认内容后 Ctrl+S 保存落盘", histRestoreFail: "恢复失败：", histNoDoc: "（请先打开一个已保存的文档）", histPreview: "（预览）",
    tblRowUp: "整行上移", tblRowDown: "整行下移",
    sideOutline: "大纲", sideFiles: "文件",
    printBtn: "打印", printTip: "打印正文（Ctrl+P）：弹系统打印预览，可选打印机/份数/双面",
    outlineFilterPh: "过滤大纲…", filterFilesPh: "过滤树 / 全盘搜文件名…",
    esSearching: "全盘搜索中…", esNone: "全盘无命中", esIndexing: "正在建立全盘文件索引（已扫描 {n} 项）——数十秒后即可搜到部分结果，期间逐步补全", esFail: "全盘查询失败",
  diagOk: "诊断包已导出（含运行日志+版本+系统信息），可直接发给反馈者：", diagFail: "诊断包导出失败：", esSplitTip: "拖动调整文件名列宽，双击复位",
    diagBtn: "诊断", diagTip: "导出诊断包：运行日志+版本+系统信息，单个文本文件，用于问题反馈",
    recentTitle: "最近", clearRecentTip: "清空最近文件列表", clearRecent: "清空",
    treePathPh: "路径，回车跳转", treeRefreshTip: "刷新目录",
    gsearchPh: "搜同级文件内容，回车执行（Ctrl+Shift+F）", gsearchNone: "（无匹配）",
    gsearchNoDoc: "（打开文件后可搜其所在目录）", gsearchEmpty: "（输入关键词）",
    quickOpenTitle: "快速打开", quickOpenPh: "输入文件名过滤，↑↓选择，回车打开…", quickOpenEmpty: "（暂无最近文件）",
    treeNoDoc: "（打开文件后显示其所在目录）", treeBadPath: "路径不存在或无法访问：", drivesRoot: "此电脑", fileTooBig: "文件过大（约 ",
    fmOpen: "打开", fmNewMd: "新建 Markdown 文件", fmNewTxt: "新建 TXT 文件", fmNewDir: "新建文件夹",
    fmRename: "重命名", fmDelete: "删除", fmReveal: "在文件夹中显示", fmCopyPath: "复制路径",
    fmNewIn: "在当前位置新建", fmNamePh: "输入名称…", fmRenameTitle: "重命名为：", fmNewMdTitle: "新建 Markdown 文件：", fmNewTxtTitle: "新建 TXT 文件：", fmNewDirTitle: "新建文件夹：",
    fmDelTitle: "删除确认", fmDelFileMsg: "确定删除该文件？不可恢复。", fmDelDirMsg: "确定删除该文件夹及其全部内容？不可恢复。",
    fmNoBase: "请先打开文件或在树中定位一个目录", untitledMd: "未命名.md", untitledDir: "新建文件夹", fmCopyDone: "已复制", fmOk: "确定", fileTooBigSuf: " 万字，上限 200 万字），已阻止打开以免长时间无响应，请拆分后再编辑。", bigLoad: "正在加载大文件，请稍候…",
    statusSelected: "已选 {n}", extChanged: "文件「{f}」已被其他程序修改（磁盘内容变化）。", extChangedDirty: "文件「{f}」已被其他程序修改；本标签有未保存改动，重新加载将丢弃本地改动。", extDeleted: "文件「{f}」已不存在（可能被移动或删除）。",
    extReload: "重新加载", extDismiss: "忽略",
    bigDocBar: "大文档模式：编辑约 1.5 秒后生效（延迟保存通道），保存与撤销不受影响。", bigDocBarIr: "大文档在即时渲染模式下会严重卡顿，建议用顶部按钮切到所见即所得；编辑约 1.5 秒后生效。",
    tabClose: "关闭", tabCloseOthers: "关闭其它", tabCloseRight: "关闭右侧", tabCloseLeft: "关闭左侧", tabCloseAll: "全部关闭", tabCloseSelected: "关闭选中",
    themeTip: "界面主题：浅色 / 深色 / 护眼（未选过跟随系统）",
    appName: "MD 编辑器",
    statusSaved: "已保存", statusUnsaved: "未保存", readMin: "分钟", sbSide: "侧栏",
    sbShowSide: "显示侧栏（Ctrl+Shift+B）", sbHideSide: "隐藏侧栏（Ctrl+Shift+B）",
    zoomResetTip: "显示比例：点击复位 100%（Ctrl+滚轮缩放）",
    themeLight: "浅色", themeDark: "深色", themeEye: "护眼", themePaper: "暖纸",
    copyCode: "复制", copied: "已复制", copyFail: "复制失败",
    cmdkOpen: "打开文件…", cmdkGroupCmd: "命 令", cmdkGroupRecent: "最近文件", cmdkEmpty: "（无匹配的命令或文件）", cmdkPh: "输入命令或文件名…", cmdkFoot: "↑↓ 选择 · Enter 执行 · Esc 关闭 · Ctrl+K 呼出",
  },
  "zh-TW": {
    menuFile: "檔案", menuView: "檢視", openMenu: "開啟…", printMenu: "列印…",
    open: "開啟", save: "儲存", openTip: "開啟 .md/.markdown/.txt 文件（可拖入視窗）", saveTip: "儲存當前文件（Ctrl+S）", welcomeName: "歡迎", untitled: "未命名", noDoc: "（無）",
    emptyHint: "點擊頂部「開啟」按鈕，或把 .md 檔案拖入視窗，開始編輯",
    noHeadings: "（暫無標題：用 # 新增章節）",
    noOpenFile: "（暫無開啟的檔案：點頂部「開啟」或把 .md 拖入視窗）",
    deleteChapter: "刪除該章節（含正文）", closeTab: "關閉",
    openFail: "開啟失敗：", saveFail: "儲存失敗：", closeFail: "關閉失敗：",
    saveEmptySuf: "」內容為空，已跳過儲存（避免清空檔案）",
    delTitle: "刪除章節", delConfirmSuf: "」及其所有子內容？",
    closeSaveMsg: "有未儲存的修改，是否儲存？", closeSave: "儲存並關閉", closeDiscard: "不儲存關閉", closeCancel: "取消",
    modeWYSIWYG: "所見即所得", modeIR: "即時渲染", switchToIR: "切回即時渲染", switchToWYSIWYG: "所見即所得",
    modeWYSIWYGTip: "當前：所見即所得模式（可直接編輯表格）", modeIRTip: "當前：即時渲染模式",
    switchToIRTip: "切回即時渲染模式（Ctrl+Alt+M）", switchToWYSIWYGTip: "切到所見即所得模式以編輯表格（Ctrl+Alt+M）",
    panelTitle: "大綱 · 點擊定位 · ✕刪除 · 拖曳重排",
    export: "匯出 ▾", exportPdf: "PDF（向量）", exportHtmlStyled: "HTML（帶樣式）", exportHtmlPlain: "HTML（純淨）", exportPng: "圖片 PNG（長圖）", exportDocx: "Word (.docx)", exportNoDoc: "（請先開啟或新增文件再匯出）", exportEmptyConfirm: "文件內容為空，仍要匯出嗎？", exportFail: "匯出失敗：", exporting: "正在匯出 PDF，請稍候…",
    exportDone: "匯出完成：",
    exportImageSlices: "文件較長，已分片匯出多張 PNG：", pasteImgUntitledHint: "（提示：文件尚未儲存，截圖存到了應用目錄，儲存文件後建議整理）",
    exportStagePage: "正在產生頁面…", exportStagePrint: "正在列印為 PDF…", exportStageSave: "正在儲存檔案…",
    fontSizeTip: "字號：先框選文字，再選字號",
    selectFirstTip: "請先在編輯區框選要改字號的文字，再選字號",
    wordCount: "字",
    focusMode: "打字專注", findBtn: "尋找",
    focusTip: "打字專注（F8）：淡化非當前段落，適合寫作",
    findTip: "尋找替換（Ctrl+F / Ctrl+H）",
    findPlaceholder: "尋找…", replacePlaceholder: "替換為…",
    replaceOne: "替換", replaceAll: "全部替換",
    replaceManyConfirm: "符合超過 500 處，仍要全部替換嗎？",
    histBtn: "歷史", histTitle: "版本歷史（儲存時自動歸檔，每文件留 50 版/30 天）", histEmpty: "暫無歷史版本——本文件儲存覆蓋舊版後才會產生歸檔",
    histRestore: "恢復此版本", histRestored: "已載入所選版本（未儲存），確認內容後 Ctrl+S 儲存落盤", histRestoreFail: "恢復失敗：", histNoDoc: "（請先開啟一個已儲存的文件）", histPreview: "（預覽）",
    tblRowUp: "整行上移", tblRowDown: "整行下移",
    sideOutline: "大綱", sideFiles: "檔案",
    printBtn: "列印", printTip: "列印正文（Ctrl+P）：彈系統列印預覽，可選印表機/份數/雙面",
    outlineFilterPh: "過濾大綱…", filterFilesPh: "過濾樹 / 全碟搜檔名…",
    esSearching: "全碟搜尋中…", esNone: "全碟無命中", esIndexing: "正在建立全碟文件索引（已掃描 {n} 項）——數十秒後即可搜到部分結果，期間逐步補全", esFail: "全碟查詢失敗",
  diagOk: "診斷包已導出（含運行日誌+版本+系統信息），可直接發給反饋者：", diagFail: "診斷包導出失敗：", esSplitTip: "拖動調整文件名列寬，雙擊復位",
    diagBtn: "診斷", diagTip: "導出診斷包：運行日誌+版本+系統信息，單個文本文件，用於問題反饋",
    recentTitle: "最近", clearRecentTip: "清空最近檔案列表", clearRecent: "清空",
    treePathPh: "路徑，Enter 跳轉", treeRefreshTip: "重新整理目錄",
    gsearchPh: "搜同層檔案內容，Enter 執行（Ctrl+Shift+F）", gsearchNone: "（無符合）",
    gsearchNoDoc: "（開啟檔案後可搜其所在目錄）", gsearchEmpty: "（輸入關鍵詞）",
    quickOpenTitle: "快速開啟", quickOpenPh: "輸入檔名過濾，↑↓選擇，Enter 開啟…", quickOpenEmpty: "（暫無最近檔案）",
    treeNoDoc: "（開啟檔案後顯示其所在目錄）", treeBadPath: "路徑不存在或無法存取：", drivesRoot: "本機", fileTooBig: "檔案過大（約 ",
    fmOpen: "開啟", fmNewMd: "新增 Markdown 檔案", fmNewTxt: "新增 TXT 檔案", fmNewDir: "新增資料夾",
    fmRename: "重新命名", fmDelete: "刪除", fmReveal: "在資料夾中顯示", fmCopyPath: "複製路徑",
    fmNewIn: "在目前位置新增", fmNamePh: "輸入名稱…", fmRenameTitle: "重新命名為：", fmNewMdTitle: "新增 Markdown 檔案：", fmNewTxtTitle: "新增 TXT 檔案：", fmNewDirTitle: "新增資料夾：",
    fmDelTitle: "刪除確認", fmDelFileMsg: "確定刪除該檔案？無法復原。", fmDelDirMsg: "確定刪除該資料夾及其全部內容？無法復原。",
    fmNoBase: "請先開啟檔案或在樹中定位一個目錄", untitledMd: "未命名.md", untitledDir: "新增資料夾", fmCopyDone: "已複製", fmOk: "確定", fileTooBigSuf: " 萬字，上限 200 萬字），已阻止開啟以免長時間無回應，請拆分後再編輯。", bigLoad: "正在載入大檔案，請稍候…",
    statusSelected: "已選 {n}", extChanged: "檔案「{f}」已被其他程式修改（磁碟內容變化）。", extChangedDirty: "檔案「{f}」已被其他程式修改；本分頁有未儲存變更，重新載入將捨棄本機改動。", extDeleted: "檔案「{f}」已不存在（可能被移動或刪除）。",
    extReload: "重新載入", extDismiss: "忽略",
    bigDocBar: "大文件模式：編輯約 1.5 秒後生效（延遲儲存通道），儲存與復原不受影響。", bigDocBarIr: "大文件在即時渲染模式下會嚴重卡頓，建議用頂部按鈕切到所見即所得；編輯約 1.5 秒後生效。",
    tabClose: "關閉", tabCloseOthers: "關閉其它", tabCloseRight: "關閉右側", tabCloseLeft: "關閉左側", tabCloseAll: "全部關閉", tabCloseSelected: "關閉選中",
    themeTip: "介面主題：淺色 / 深色 / 護眼（未選過跟隨系統）",
    appName: "MD 編輯器",
    statusSaved: "已儲存", statusUnsaved: "未儲存", readMin: "分鐘", sbSide: "側欄",
    sbShowSide: "顯示側欄（Ctrl+Shift+B）", sbHideSide: "隱藏側欄（Ctrl+Shift+B）",
    zoomResetTip: "顯示比例：點擊復位 100%（Ctrl+滾輪縮放）",
    themeLight: "淺色", themeDark: "深色", themeEye: "護眼", themePaper: "暖紙",
    copyCode: "複製", copied: "已複製", copyFail: "複製失敗",
    readingFocus: "閱讀專注", cmdkOpen: "開啟檔案…", cmdkGroupCmd: "命 令", cmdkGroupRecent: "最近檔案", cmdkEmpty: "（無匹配的命令或檔案）", cmdkPh: "輸入命令或檔名…", cmdkFoot: "↑↓ 選擇 · Enter 執行 · Esc 關閉 · Ctrl+K 呼出",
  },
  "en": {
    menuFile: "File", menuView: "View", openMenu: "Open…", printMenu: "Print…",
    open: "Open", save: "Save", openTip: "Open a .md/.markdown/.txt file (or drag one into the window)", saveTip: "Save the current document (Ctrl+S)", welcomeName: "Welcome", untitled: "Untitled", noDoc: "(none)",
    emptyHint: 'Click "Open" above, or drag a .md file into the window to start editing',
    noHeadings: "(No headings yet: use # to add a section)",
    noOpenFile: '(No file open: click "Open" above or drag a .md file here)',
    deleteChapter: "Delete this section (with content)", closeTab: "Close",
    openFail: "Open failed: ", saveFail: "Save failed: ", closeFail: "Close failed: ",
    saveEmptySuf: '" is empty, save skipped (to avoid clearing the file)',
    delTitle: "Delete section", delConfirmSuf: '" and all its content?',
    closeSaveMsg: "Unsaved changes. Save?", closeSave: "Save and close", closeDiscard: "Close without saving", closeCancel: "Cancel",
    modeWYSIWYG: "WYSIWYG", modeIR: "Instant Rendering", switchToIR: "Markdown (IR)", switchToWYSIWYG: "WYSIWYG",
    modeWYSIWYGTip: "Current: WYSIWYG mode (visual table editing)", modeIRTip: "Current: Markdown (IR) mode",
    switchToIRTip: "Switch to Markdown (IR) (Ctrl+Alt+M)", switchToWYSIWYGTip: "Switch to WYSIWYG to edit tables (Ctrl+Alt+M)",
    panelTitle: "Outline · click to navigate · ✕ delete · drag to reorder",
    export: "Export ▾", exportPdf: "PDF (vector)", exportHtmlStyled: "HTML (styled)", exportHtmlPlain: "HTML (plain)", exportPng: "PNG image (full length)", exportDocx: "Word (.docx)", exportNoDoc: "(Open or create a document first)", exportEmptyConfirm: "The document is empty. Export anyway?", exportFail: "Export failed: ", exporting: "Exporting PDF, please wait…",
    exportDone: "Exported: ",
    exportImageSlices: "Long document, exported as multiple PNG slices: ", pasteImgUntitledHint: "(Tip: document not saved yet; screenshot stored in app folder)",
    exportStagePage: "Generating pages…", exportStagePrint: "Printing to PDF…", exportStageSave: "Saving file…",
    fontSizeTip: "Font size: select text first, then pick a size",
    selectFirstTip: "Select the text in the editor first, then pick a size",
    wordCount: "words",
    focusMode: "Typing focus", findBtn: "Find",
    focusTip: "Typing focus (F8): dim other paragraphs",
    findTip: "Find & replace (Ctrl+F / Ctrl+H)",
    findPlaceholder: "Find…", replacePlaceholder: "Replace with…",
    replaceOne: "Replace", replaceAll: "Replace all",
    replaceManyConfirm: "More than 500 matches. Replace all anyway?",
    histBtn: "History", histTitle: "Version history (auto-archived on save, 50 versions / 30 days per file)", histEmpty: "No versions yet — archives appear after this file is saved over an older version",
    histRestore: "Restore this version", histRestored: "Version loaded (unsaved). Review and press Ctrl+S to write to disk", histRestoreFail: "Restore failed: ", histNoDoc: "(Open a saved document first)", histPreview: "(preview)",
    tblRowUp: "Move row up", tblRowDown: "Move row down",
    sideOutline: "Outline", sideFiles: "Files",
    printBtn: "Print", printTip: "Print the document (Ctrl+P): system print preview — printer, copies, duplex",
    outlineFilterPh: "Filter outline…", filterFilesPh: "Filter tree / search all drives…",
    esSearching: "Searching all drives…", esNone: "No matches on this computer", esIndexing: "Building drive-wide file index ({n} items scanned) — partial results become searchable within a minute", esFail: "Query failed",
  diagOk: "Diagnostics exported (logs + version + system info). Send this file for bug reports:", diagFail: "Failed to export diagnostics:", esSplitTip: "Drag to resize the name column, double-click to reset",
    diagBtn: "Diagnostics", diagTip: "Export diagnostics: logs + version + system info in one text file, for bug reports",
    recentTitle: "Recent", clearRecentTip: "Clear recent files", clearRecent: "Clear",
    treePathPh: "Path, Enter to go", treeRefreshTip: "Refresh folder",
    gsearchPh: "Search sibling files here, Enter (Ctrl+Shift+F)", gsearchNone: "(no match)",
    gsearchNoDoc: "(open a file to search its folder)", gsearchEmpty: "(type a keyword)",
    quickOpenTitle: "Quick open", quickOpenPh: "Type to filter, ↑↓ select, Enter open…", quickOpenEmpty: "(no recent files)",
    treeNoDoc: "(open a file to show its folder)", treeBadPath: "Path not accessible: ", drivesRoot: "This PC", fileTooBig: "File too large (about ",
    fmOpen: "Open", fmNewMd: "New Markdown file", fmNewTxt: "New TXT file", fmNewDir: "New folder",
    fmRename: "Rename", fmDelete: "Delete", fmReveal: "Show in folder", fmCopyPath: "Copy path",
    fmNewIn: "New item here", fmNamePh: "Enter a name…", fmRenameTitle: "Rename to:", fmNewMdTitle: "New Markdown file:", fmNewTxtTitle: "New TXT file:", fmNewDirTitle: "New folder:",
    fmDelTitle: "Delete", fmDelFileMsg: "Delete this file? This cannot be undone.", fmDelDirMsg: "Delete this folder and ALL its contents? This cannot be undone.",
    fmNoBase: "Open a file or locate a folder in the tree first", untitledMd: "Untitled.md", untitledDir: "New folder", fmCopyDone: "Copied", fmOk: "OK", fileTooBigSuf: "K chars, limit 2000K chars). Opening blocked to avoid unresponsiveness; please split the file first.", bigLoad: "Loading a large file…",
    statusSelected: "{n} selected", extChanged: "File \"{f}\" was modified by another program (disk content changed).", extChangedDirty: "File \"{f}\" was modified by another program; this tab has unsaved changes — reloading will discard them.", extDeleted: "File \"{f}\" no longer exists (moved or deleted).",
    extReload: "Reload", extDismiss: "Ignore",
    bigDocBar: "Large-document mode: edits take effect after ~1.5s (deferred-save channel); saving and undo are unaffected.", bigDocBarIr: "Instant-render mode is extremely slow for large documents; switch to WYSIWYG via the top button. Edits take effect after ~1.5s.",
    tabClose: "Close", tabCloseOthers: "Close others", tabCloseRight: "Close to the right", tabCloseLeft: "Close to the left", tabCloseAll: "Close all", tabCloseSelected: "Close selected",
    themeTip: "Theme: light / dark / eye-care (follows system until chosen)",
    appName: "MD Editor",
    statusSaved: "Saved", statusUnsaved: "Unsaved", readMin: "min", sbSide: "Sidebar",
    sbShowSide: "Show sidebar (Ctrl+Shift+B)", sbHideSide: "Hide sidebar (Ctrl+Shift+B)",
    zoomResetTip: "Zoom: click to reset 100% (Ctrl+wheel)",
    themeLight: "Light", themeDark: "Dark", themeEye: "Eye care", themePaper: "Warm Paper",
    copyCode: "Copy", copied: "Copied", copyFail: "Copy failed",
    readingFocus: "Reading focus", cmdkOpen: "Open file…", cmdkGroupCmd: "COMMANDS", cmdkGroupRecent: "Recent files", cmdkEmpty: "(no matching command or file)", cmdkPh: "Type a command or file name…", cmdkFoot: "↑↓ Select · Enter Run · Esc Close · Ctrl+K Toggle",
  },
};

const WELCOME_TEXT: Record<Lang, string> = {
  "zh-CN": `# 欢迎使用 MD 编辑器

- 双击 .md 文件或拖拽 .md 到窗口打开
- 支持**多个标签页**，互不覆盖
- 左侧大纲：点击定位、✕ 删除章节、拖动重排章节
- 顶部「打开 / 保存」操作文件
- 默认**所见即所得**模式，可直接编辑表格（点单元格、浮层增删行列/对齐、数字框回车批量增删）；需要源码即时渲染时点顶部「即时渲染」切回（Ctrl+Alt+M）
`,
  "zh-TW": `# 歡迎使用 MD 編輯器

- 雙擊 .md 檔案或拖曳 .md 到視窗開啟
- 支援**多個分頁**，互不覆蓋
- 左側大綱：點擊定位、✕ 刪除章節、拖曳重排章節
- 頂部「開啟 / 儲存」操作檔案
- 預設**所見即所得**模式，可直接編輯表格（點儲存格、浮動工具列增刪列/欄/對齊、數字框 Enter 批次增刪）；需要原始碼即時渲染時點頂部「即時渲染」切回（Ctrl+Alt+M）
`,
  "en": `# Welcome to MD Editor

- Double-click a .md file or drag it into the window to open
- Open multiple files in **tabs** (they won't overwrite each other)
- Left outline: click to navigate, ✕ to delete a section, drag to reorder
- Top toolbar: Open / Save
- Default **WYSIWYG** mode — edit tables visually (click a cell, use the floating toolbar to add/remove rows & columns, or type a number + Enter to batch-edit). Switch to **Markdown (IR)** via the top button (Ctrl+Alt+M)
`,
};

function detectLang(): Lang {
  // try/catch：隐私模式/存储被禁用时 getItem 抛错——detectLang 在模块顶层(先于 boot)同步执行，
  // 不兜底会整页白屏。navigator 同理防御。
  let saved: string | null = null;
  try { saved = localStorage.getItem("md-editor-lang"); } catch { /* 存储禁用/损坏 → 回退 navigator */ }
  if (saved === "zh-CN" || saved === "zh-TW" || saved === "en") return saved;
  let nl = "zh-cn";
  try { nl = (navigator.language || "zh-CN").toLowerCase(); } catch { /* navigator 不可用 → 默认简中 */ }
  if (nl.startsWith("zh-tw") || nl.startsWith("zh-hk") || nl.startsWith("zh-hant")) return "zh-TW";
  if (nl.startsWith("en")) return "en";
  return "zh-CN"; // 简体中文默认（含 zh-cn / zh / 其他）
}
let currentLang: Lang = detectLang();
function t(key: string): string { return UI_TEXT[currentLang][key] ?? UI_TEXT["en"][key] ?? key; }
/** 大文件尺寸文案：中文按「万字」直觉展示，英文按 k chars（v0.3.25） */
function bigSizeLabel(charCount: number): string {
  if (currentLang === "en") return Math.round(charCount / 1000) + "K";
  return (charCount / 10000).toFixed(1);
}
function welcomeMd(): string { return WELCOME_TEXT[currentLang]; }

// ---- 编辑区字号（基于选区，独立于 PDF：PRINT_CSS 的 14px 固定不动）----
// Markdown 无原生字号语法 → 用内联 HTML：把选区文字包进 <span style="font-size:Npx">。
// WYSIWYG/即时渲染(contenteditable)直接渲染该 span；lute 回写 md 时保留它（.md 里会出现 <span>，正常）。
// 源码(SV)模式是 textarea 原始文本 → 把 span 标签原样插入文本。
const FONT_SIZE_KEY = "md-editor-fontsize";
const DEFAULT_FONT_SIZE = 16; // 下拉默认值（仅记忆上次用过，不应用于全文）
// 点下拉会抢走 contenteditable 焦点、使 Selection 折叠：在 mousedown(capture) 时快照选区，change 时再应用。
let savedRange: Range | null = null;            // 富文本选区快照（克隆，不受后续 Selection 变化影响）
let savedTa: HTMLTextAreaElement | null = null; // 源码模式 textarea
let savedStart = 0, savedEnd = 0;               // textarea 选区起止
let fontInputInteracting = false;               // 用户正与字号框交互(mousedown→blur)：期间冻结光标字号同步，避免回写覆盖输入
let exporting = false;                          // PDF 导出重入锁：msedge 打印 1-3s 期间 Ctrl+P/重复点击不二次进入，避免遮罩叠加与并发 invoke
let fontSelHlEls: HTMLElement[] = [];           // 需求3 自定义选区高亮层：input 获焦致 contenteditable 失焦(Chromium 高亮透明)，用 div 模拟框选全程可见
function loadFontSize(): number {
  // 仿 detectLang：隐私模式/存储禁用时 getItem 抛错，try/catch 否则整页白屏
  try {
    const v = parseInt(localStorage.getItem(FONT_SIZE_KEY) || "", 10);
    if (v >= 8 && v <= 72) return v;
  } catch { /* 存储禁用/损坏 → 用默认 */ }
  return DEFAULT_FONT_SIZE;
}
// 当前激活的 contenteditable 编辑区（所见即所得 / 即时渲染）；源码模式返回 null
function activeEditableArea(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#editor .vditor-wysiwyg, #editor .vditor-ir");
}
// 当前激活的源码 textarea（仅 SV 模式存在）
function activeSourceTextarea(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>("#editor .vditor-sv__textarea");
}
// 在下拉抢走焦点前快照选区：源码模式存 selectionStart/End，富文本模式存克隆 Range
function captureFontSizeSelection() {
  const ta = activeSourceTextarea();
  if (ta) { savedTa = ta; savedStart = ta.selectionStart; savedEnd = ta.selectionEnd; return; }
  savedTa = null;
  const editable = activeEditableArea();
  const sel = window.getSelection();
  // 仅当选区落在编辑区内才快照（避免把工具栏/别处的选区误当编辑区选区）
  if (sel && sel.rangeCount > 0 && editable) {
    const r = sel.getRangeAt(0);
    if (editable.contains(r.commonAncestorContainer)) savedRange = r.cloneRange();
    else savedRange = null;
  } else {
    savedRange = null;
  }
}
// 需求3：number input 获焦后 contenteditable 失焦，Chromium 选区高亮默认透明（不似 textarea 变灰可见）。
// 用 savedRange 的视口矩形在选区位置覆盖半透明蓝层模拟高亮，使框选在「点字号框→输入→应用」全程可见。
function paintFontSelHl() {
  clearFontSelHl();
  if (!savedRange || savedRange.collapsed) return;       // 仅富文本选区：源码模式 textarea 失焦自变灰，无需模拟
  const editable = activeEditableArea();
  if (!editable) return;
  const rects = savedRange.getClientRects();             // 多行选区返回多个矩形，逐个覆盖
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const div = document.createElement("div");
    div.className = "fontsel-hl";
    div.style.left = r.left + "px";
    div.style.top = r.top + "px";
    div.style.width = r.width + "px";
    div.style.height = r.height + "px";
    document.body.appendChild(div);
    fontSelHlEls.push(div);
  }
}
function clearFontSelHl() {
  for (const el of fontSelHlEls) el.remove();            // 幂等：重复调用安全（change 与 blur 都会调）
  fontSelHlEls = [];
}
// 把字号应用到选区：源码 → setRangeText 包 span 标签；富文本 → surroundContents 包 span 元素
function applyFontSizeToSelection(px: number) {
  // 源码模式：textarea 原始文本，直接插入 <span> 标签
  if (savedTa) {
    if (savedStart === savedEnd) { showToast(t("selectFirstTip"), "info"); return; }
    const selTxt = savedTa.value.substring(savedStart, savedEnd);
    const wrapped = `<span style="font-size:${px}px">${selTxt}</span>`;
    savedTa.focus();
    savedTa.setRangeText(wrapped, savedStart, savedEnd, "end"); // 光标移到插入后末尾
    savedTa.dispatchEvent(new Event("input", { bubbles: true })); // 让 Vditor 同步 doc.content/dirty/大纲
    return;
  }
  // 富文本模式：contenteditable 选区
  if (!savedRange || savedRange.collapsed) { showToast(t("selectFirstTip"), "info"); return; }
  const editable = activeEditableArea();
  if (!editable) { showToast(t("selectFirstTip"), "info"); return; }
  editable.focus();
  const span = document.createElement("span");
  span.style.fontSize = px + "px";
  try {
    savedRange.surroundContents(span); // 选区未跨元素边界时直接包裹
  } catch {
    // 选区跨越元素边界（部分选中某节点）时 surroundContents 抛错 → 抽出文档片段再包裹
    const frag = savedRange.extractContents();
    span.appendChild(frag);
    savedRange.insertNode(span);
  }
  // 重选包裹内容，便于连续对多段文字应用不同字号
  const nr = document.createRange();
  nr.selectNodeContents(span);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(nr);
  savedRange = nr.cloneRange();
  // Range API 改 DOM 不触发 input：手动派发，让 Vditor 同步 doc.content/dirty/大纲
  editable.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---- 多标签页：每个打开的文档一个 Doc ----
interface Doc {
  id: string;
  path: string | null;
  name: string;
  content: string;
  dirty: boolean;
  encoding: string;
  undoStack: string[]; // v0.3.21 自建撤销快照栈（per-doc；Vditor 内部栈粒度坏：一次 undo 撤光全部输入）
  redoStack: string[];
  base: string; // 磁盘版内容（撤销后判定 dirty 用）
  large: boolean; // v0.3.25 大文档（>262144 字符）：走延迟取值通道（getValue 57万字=465ms，
  // 逐键同步取值=每键~1s 阻塞，实测 headless 基准；400ms 空闲统一 flush，撤销粒度相应变粗为按输入串）
  lazy: boolean; // v0.3.26 会话惰性恢复占位：未读盘（content=""），激活时才 open_file（#9 惰性恢复标签）
  loading: boolean; // 惰性加载进行中（防连点重入）
  restoreScroll: number | null; // v0.3.26 会话恢复：applyContent 后要回滚到的 scrollTop（一次性消费）
  scrollTop: number; // 离开该文档时的阅读位置（switchDoc 开头存，会话保存用）
  metaMtime: number; // v0.3.26 外部修改检测基准：打开/保存时的磁盘 mtime(ms)
  metaSize: number; // 同上，字节数（双指标比对，单 mtime 在同尺寸改写时可能粒度不够）
  bytes: number; // UTF-8 字节数缓存（状态栏文件大小；openDoc/flush/save 低频更新）
}

// v0.3.25 大文件上限（实测重设）：headless 基准 2.86M 字符渲染 10.9s 收敛、键入 466ms——
// 超线性恶化从这里开始。2M 字符内可开（57万字=1.67MB 正常打开渲染 2.5s）。
const MAX_OPEN_CHARS = 2_000_000;
// 大文档延迟取值阈值：与旧拒开线一致（≤此值的文档走原逐键路径，行为字节级不变保回归）
const LARGE_DOC_CHARS = 262144;
let docs: Doc[] = [];
let activeId: string | null = null;
let docCounter = 0;
function newDocId() {
  return "doc-" + ++docCounter;
}
function activeDoc(): Doc | null {
  return docs.find((d) => d.id === activeId) || null;
}

interface Section {
  id: string;
  level: number;
  title: string;
  start: number;
  end: number;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---- v0.4.0 toast：替代原生 alert（阻塞式、观感突兀）。底部中央浮现 2.6s 自动消退；
// 三态 info/danger/success（左轨道条色区分）；同文本去重不堆叠；同屏最多 3 条 ----
let toastRoot: HTMLElement | null = null;
function showToast(msg: string, kind: "info" | "danger" | "success" = "info"): void {
  if (!toastRoot) {
    toastRoot = document.createElement("div");
    toastRoot.id = "toast-root";
    document.body.appendChild(toastRoot);
  }
  for (const el of Array.from(toastRoot.children)) {
    if ((el as HTMLElement).dataset.msg === msg) { scheduleToastHide(el as HTMLElement); return; }
  }
  const t0 = document.createElement("div");
  t0.className = "toast" + (kind === "info" ? "" : " " + kind);
  t0.textContent = msg;
  t0.title = msg; // 超长路径 ellipsis 后 hover 看全文
  t0.dataset.msg = msg;
  toastRoot.appendChild(t0);
  requestAnimationFrame(() => t0.classList.add("show"));
  while (toastRoot.children.length > 3) toastRoot.firstElementChild!.remove();
  scheduleToastHide(t0);
}
function scheduleToastHide(el: HTMLElement): void {
  window.clearTimeout(Number(el.dataset.timer || 0));
  const tid = window.setTimeout(() => {
    el.classList.remove("show");
    window.setTimeout(() => el.remove(), 260); // 等退场过渡完再摘除
  }, 2600);
  el.dataset.timer = String(tid);
}

// prefers-reduced-motion：平滑滚动降级为瞬时（CSS 过渡已由全局媒体查询接管，这里管 JS 驱动的滚动）
function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ---- 章节解析：基于 md 源码行，跳过代码围栏里的 # ----
function parseSections(md: string): Section[] {
  const lines = md.split("\n");
  type H = { level: number; line: number; title: string };
  const heads: H[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*(`{3,}|~{3,})/.test(ln)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // 仅识别 ATX 标题(#)；Setext(===/--- 下划线式)不计入大纲(罕见且 --- 与分隔线歧义)
    const m = ln.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) heads.push({ level: m[1].length, line: i, title: m[2] });
  }
  const secs: Section[] = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    let end = lines.length - 1;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) {
        end = heads[j].line - 1;
        break;
      }
    }
    secs.push({ id: "sec-" + i, level: h.level, title: h.title, start: h.line, end });
  }
  return secs;
}

function rebuildOutline() {
  if (!vditor) return;
  const doc = activeDoc();
  const secs = parseSections(doc ? doc.content : mdValue());
  const ul = document.getElementById("outline")!;
  ul.innerHTML = "";
  // v0.4.0：映射重建放在 empty 早退之前——切到无标题文档时也要清掉旧文档的元素引用，
  // 否则 outlineHeads 残留前一篇的 detached 节点（gBCR 恒 0），scrollspy 判定全乱
  rebuildHeadMap();
  if (secs.length === 0) {
    ul.innerHTML = '<li class="empty">' + esc(t("noHeadings")) + "</li>";
    return;
  }
  secs.forEach((s, idx) => {
    const li = document.createElement("li");
    li.className = "outline-item";
    li.style.paddingLeft = s.level * 12 + 8 + "px";
    li.dataset.id = s.id;
    li.innerHTML =
      `<span class="ot" title="${esc(s.title)}">${esc(s.title)}</span>` +
      `<span class="odel" title="${esc(t("deleteChapter"))}">✕</span>`;
    li.addEventListener("click", () => scrollToHeading(idx));
    li.querySelector(".odel")!.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSection(s.id);
    });
    // 章节拖动重排：用 pointer 事件而非 HTML5 DnD——dragDropEnabled=true 时(Tauri 文件拖放需要)，
    // Windows 前端 HTML5 drag-and-drop 被禁用(Tauri schema 明确)，原 draggable/dragstart 会失效。
    li.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // 仅左键
      const dragSecId = s.id;
      const startY = e.clientY;
      let moved = false;
      let overLi: HTMLElement | null = null;
      const onMove = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientY - startY) < 5) return; // 移动阈值，避免点击误触
        if (!moved) { moved = true; li.classList.add("dragging"); }
        const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const t = el ? (el.closest(".outline-item") as HTMLElement | null) : null;
        document.querySelectorAll(".outline-item.over").forEach((x) => x.classList.remove("over"));
        if (t && t !== li && ul.contains(t)) { t.classList.add("over"); overLi = t; } else overLi = null;
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        li.classList.remove("dragging");
        document.querySelectorAll(".outline-item.over").forEach((x) => x.classList.remove("over"));
        if (moved && overLi && overLi.dataset.id && overLi.dataset.id !== dragSecId) {
          const rect = overLi.getBoundingClientRect();
          const pos: "before" | "after" = ev.clientY - rect.top < rect.height / 2 ? "before" : "after";
          moveSection(dragSecId, overLi.dataset.id, pos);
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    ul.appendChild(li);
  });
  applyOutlineFilter(); // 重建后重放过滤态（大纲随编辑实时重建，不清过滤框）
  updateReadingTrace(); // 内容变化后当前章节/进度立即重算（不等下一次滚动）——.cur 丢失在此自愈
}

function scheduleOutline() {
  if (outlineTimer !== null) window.clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(() => {
    outlineTimer = null;
    rebuildOutline();
  }, 400);
}

// v0.4.0 阅读轨迹：大纲章节 ↔ 正文标题 的元素级映射（scrollspy 与点击定位共用）。
// 匹配算法沿用旧 scrollToHeading 的文本+同名序号（跳过 Setext 等未进大纲标题的干扰），
// 但结果缓存为元素引用——点击定位不再每次全文档重扫，同名标题错位同步根治（映射一次建立）。
let outlineHeads: (HTMLElement | null)[] = [];
function rebuildHeadMap(): void {
  const doc = activeDoc();
  const secs = parseSections(doc ? doc.content : vditor ? mdValue() : "");
  const domHeads = Array.from(
    document.querySelectorAll<HTMLElement>(
      "#editor h1, #editor h2, #editor h3, #editor h4, #editor h5, #editor h6"
    )
  );
  const used = new Set<HTMLElement>();
  outlineHeads = secs.map((target, idx) => {
    const sameBefore = secs.slice(0, idx).filter((s) => s.title === target.title).length;
    let seen = 0;
    for (const h of domHeads) {
      if (used.has(h)) continue;
      if ((h.textContent || "").trim() === target.title) {
        if (seen === sameBefore) { used.add(h); return h; }
        seen++;
      }
    }
    return null; // 渲染中间态/特殊形态匹配不到：scrollspy 跳过该槽位
  });
}

function scrollToHeading(idx: number) {
  const h = outlineHeads[idx];
  if (!h) return;
  h.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  setOutlineCurrent(idx); // 点击即时反馈（不等滚动事件链路）
}

// ---- v0.4.0 阅读轨迹（brief 记忆点）：大纲当前章节 + 顶部进度线 + 状态栏百分比，三处同源联动 ----
let spyCur = -1;
let spyRaf = false;
function setOutlineCurrent(idx: number): void {
  spyCur = idx;
  const items = document.querySelectorAll("#outline .outline-item");
  items.forEach((li) => li.classList.remove("cur"));
  if (idx < 0 || idx >= items.length) return;
  const li = items[idx];
  li.classList.add("cur");
  // 大纲滚动跟随：目标不可见才平移（block:nearest 不抢滚动位置），与正文滚动解耦不回环
  li.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
}
function outlineCurIdx(): number {
  const items = document.querySelectorAll("#outline .outline-item");
  for (let i = 0; i < items.length; i++) if (items[i].classList.contains("cur")) return i;
  return -1;
}
function updateReadingTrace(): void {
  const bar = document.getElementById("read-progress");
  const sbPos = document.getElementById("sb-pos");
  const sc = editorScrollEl();
  if (!sc) {
    if (bar) bar.style.transform = "scaleX(0)";
    if (sbPos) sbPos.textContent = "";
    return;
  }
  // 进度线 + 状态栏百分比（同一数据源）
  const max = sc.scrollHeight - sc.clientHeight;
  const ratio = max > 0 ? Math.min(1, Math.max(0, sc.scrollTop / max)) : 0;
  if (bar) bar.style.transform = `scaleX(${ratio})`;
  if (sbPos) sbPos.textContent = Math.round(ratio * 100) + "%";
  // scrollspy：感应线=编辑区视口顶 +90px（让标题进入即认领，迟于视觉顶行一拍更稳）
  const line = sc.getBoundingClientRect().top + 90;
  let cur = -1;
  for (let i = 0; i < outlineHeads.length; i++) {
    const h = outlineHeads[i];
    if (h && h.getBoundingClientRect().top <= line) cur = i;
  }
  // 值变化或 DOM 丢失 .cur（rebuildOutline 的 innerHTML 重建丢类，spyCur 还是旧值会骗过值判据）都重绘
  if (cur !== spyCur || outlineCurIdx() !== cur) setOutlineCurrent(cur);
  repositionCodeBtn(); // 代码块复制按钮 overlay 跟随滚动重定位
}
function onEditorScroll(): void {
  if (spyRaf) return;
  spyRaf = true;
  requestAnimationFrame(() => { spyRaf = false; updateReadingTrace(); });
}
function initReadingTrace(): void {
  // 只跟编辑区滚动（capture 全局 scroll 会收到大纲面板自身滚动——跟随平移会回环）
  document.addEventListener("scroll", (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest("#editor")) onEditorScroll();
  }, true);
  window.addEventListener("resize", onEditorScroll);
}

// ---- v0.4.0 代码块增强：语言徽标 + 复制按钮。
// 语言徽标 = pre[data-lang] 属性 + CSS ::after 渲染（Lute DOM→md 序列化忽略属性，源码零污染——
// v0.3.12 表格列宽 th.style.width 同族先例）；复制按钮 = overlay 层绝对定位（不进 contenteditable，
// wysiwyg 的 DOM 即源码，往 pre 里塞 button 会污染序列化）。----
async function copyText(s: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(s); return true; }
  catch {
    // 兜底：非安全上下文/剪贴板 API 被拒时走 execCommand 老路径
    try {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.style.cssText = "position:fixed;left:-99999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }
}
let codeLangTimer = 0;
function refreshCodeLangs(): void {
  // 幂等：只给还没打标的 pre 写 data-lang（渲染重放时已打标的跳过）
  document.querySelectorAll<HTMLElement>("#editor pre > code[class*='language-']").forEach((c) => {
    const pre = c.parentElement as HTMLElement | null;
    if (!pre || pre.dataset.lang !== undefined) return;
    const m = /language-([\w+#-]+)/.exec(c.className);
    if (m) pre.dataset.lang = m[1];
  });
}
let codeBtnFor: HTMLElement | null = null; // 当前按钮指向的 pre
function positionCodeBtn(pre: HTMLElement | null): void {
  const layer = document.getElementById("code-btn-layer");
  const btn = layer?.querySelector<HTMLButtonElement>(".code-copy-btn");
  if (!layer || !btn) return;
  if (!pre) {
    btn.classList.remove("visible");
    codeBtnFor = null;
    return;
  }
  codeBtnFor = pre;
  const host = document.getElementById("editor-wrap")!.getBoundingClientRect();
  const r = pre.getBoundingClientRect();
  btn.style.top = r.top - host.top + 4 + "px";
  btn.style.right = Math.max(0, host.right - r.right) + 8 + "px";
  btn.classList.add("visible");
}
function repositionCodeBtn(): void {
  if (codeBtnFor && codeBtnFor.isConnected) positionCodeBtn(codeBtnFor);
}
function initCodeBlocks(): void {
  const layer = document.getElementById("code-btn-layer");
  if (!layer) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "code-copy-btn";
  btn.textContent = t("copyCode");
  btn.addEventListener("pointerdown", (e) => e.stopPropagation()); // 不抢编辑区选区/焦点
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const pre = codeBtnFor;
    if (!pre) return;
    const code = pre.querySelector("code") || pre;
    const ok = await copyText(code.textContent || "");
    const prev = btn.textContent;
    btn.textContent = ok ? "✓ " + t("copied") : t("copyFail");
    window.setTimeout(() => { btn.textContent = prev; }, 900);
  });
  layer.appendChild(btn);
  // 悬停哪个代码块，按钮就定位到哪个（事件委托：Vditor 重渲染不丢绑定）
  const ed = document.getElementById("editor")!;
  ed.addEventListener("pointerover", (e) => {
    const pre = (e.target as Element).closest<HTMLElement>("pre");
    if (pre && pre.querySelector("code")) positionCodeBtn(pre);
  });
  ed.addEventListener("pointerout", (e) => {
    const to = e.relatedTarget as Element | null;
    if (!to || !to.closest?.("pre")) positionCodeBtn(null);
  });
  // 语言徽标：编辑器子树变化（输入/重渲染/模式切换）→ 防抖打标
  const obs = new MutationObserver(() => {
    window.clearTimeout(codeLangTimer);
    codeLangTimer = window.setTimeout(refreshCodeLangs, 300);
  });
  obs.observe(ed, { childList: true, subtree: true });
  refreshCodeLangs();
}

async function deleteSection(id: string) {
  if (!vditor) return;
  const doc = activeDoc();
  if (!doc) return;
  const secs = parseSections(doc.content);
  const s = secs.find((x) => x.id === id);
  if (!s) return;
  let ok = false;
  // 英文正文不前置 delTitle（否则生成 'Delete section"标题" and all its content?' 病句：
  // 引号孤立 + 与标题框 'Delete section' 重复）。中文用「删除章节「标题」…」结构（「」配对正确）。
  // delTitle 仍作为 confirm 弹窗的标题框。
  const delQ = currentLang === "en" ? '"' : "「";
  const delMsg = (currentLang === "en" ? "" : t("delTitle")) + delQ + s.title + t("delConfirmSuf");
  try {
    ok = await confirm(delMsg, { title: t("delTitle"), kind: "warning" });
  } catch {
    ok = window.confirm(delMsg);
  }
  if (!ok) return;
  const lines = doc.content.split("\n");
  doc.content = lines.slice(0, s.start).concat(lines.slice(s.end + 1)).join("\n");
  doc.dirty = true;
  suppressInput = true;
  vditor.setValue(doc.content);
  suppressInput = false;
  rebuildOutline();
  renderTabs();
  updateTitle();
}

function moveSection(dragId: string, targetId: string, pos: "before" | "after") {
  if (!vditor) return;
  const doc = activeDoc();
  if (!doc) return;
  const secs = parseSections(doc.content);
  const drag = secs.find((x) => x.id === dragId);
  const target = secs.find((x) => x.id === targetId);
  if (!drag || !target || drag === target) return;
  if (target.start >= drag.start && target.end <= drag.end) return;
  const lines = doc.content.split("\n");
  const block = lines.slice(drag.start, drag.end + 1);
  const work = lines.slice();
  work.splice(drag.start, drag.end - drag.start + 1);
  const shift = drag.start < target.start ? drag.end - drag.start + 1 : 0;
  const insertAt = pos === "before" ? target.start - shift : target.end - shift + 1;
  work.splice(insertAt, 0, ...block);
  doc.content = work.join("\n");
  doc.dirty = true;
  suppressInput = true;
  vditor.setValue(doc.content);
  suppressInput = false;
  rebuildOutline();
  renderTabs();
  updateTitle();
}

// 工具栏 tooltip 文字走 Vditor 注入的 i18n（自动多语言）；此处只把方向改成向下，
// 避开 #editor-wrap overflow:hidden 向上裁剪（[TAURI-01] 第4坑）
function fixToolbarTooltipDirection() {
  document.querySelectorAll<HTMLElement>("#editor .vditor-toolbar [data-type]").forEach((btn) => {
    btn.className = btn.className.replace(/vditor-tooltipped__n[we]?/, "vditor-tooltipped__s");
  });
}

// ---- 标签页 ----
// v0.3.15 标签多选（Notepad++ 范式）：Ctrl+Click 加减选中，选中集可被右键"关闭选中"批量关
const tabSel = new Set<string>();
function renderTabs() {
  const bar = document.getElementById("tabs")!;
  bar.innerHTML = "";
  // v0.3.18 标签栏空白处双击=新建空白文档（Notepad++ 同款；renderTabs 每次重建 bar，随建随绑）
  bar.ondblclick = (e) => {
    if ((e.target as HTMLElement).closest(".tab")) return; // 点在标签上：交给标签自身
    openDoc(null, "", t("untitled"));
  };
  docs.forEach((doc) => {
    const tab = document.createElement("div");
    tab.className = "tab" + (doc.id === activeId ? " active" : "") + (tabSel.has(doc.id) ? " sel" : "") + (doc.lazy ? " lazy" : ""); // v0.3.26 lazy=会话惰性占位（斜体灰显）
    tab.dataset.docId = doc.id;
    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = (doc.dirty ? "● " : "") + doc.name;
    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "✕";
    close.title = t("closeTab");
    tab.appendChild(name);
    tab.appendChild(close);
    tab.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+Click：多选加减（不切换文档，Notepad++ 式选中集）
        if (tabSel.has(doc.id)) { tabSel.delete(doc.id); tab.classList.remove("sel"); }
        else { tabSel.add(doc.id); tab.classList.add("sel"); }
        return;
      }
      if (e.shiftKey) {
        // Shift+Click：从当前激活标签到点击标签的连续区间全选（v0.3.21 用户诉求）
        const curIdx = docs.findIndex((d) => d.id === activeId);
        const thisIdx = docs.findIndex((d) => d.id === doc.id);
        if (curIdx >= 0 && thisIdx >= 0) {
          const [a, b] = curIdx < thisIdx ? [curIdx, thisIdx] : [thisIdx, curIdx];
          for (let i = a; i <= b; i++) tabSel.add(docs[i].id);
          renderTabs();
          return;
        }
      }
      tabSel.clear();
      bar.querySelectorAll(".tab.sel").forEach((x) => x.classList.remove("sel"));
      switchDoc(doc.id);
    });
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeDoc(doc.id);
    });
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openTabMenu(doc.id, e.clientX, e.clientY);
    });
    bar.appendChild(tab);
  });
  updateSaveState(); // v0.4.0 状态栏保存态：dirty 变化必经 renderTabs（tab ● 同源）
}

// 标签右键菜单（Notepad++：关闭/关闭其它/关闭右侧/全部关闭；Ctrl+Click 多选时加"关闭选中"）
let tabMenuTarget: string | null = null;
function openTabMenu(docId: string, x: number, y: number): void {
  const menu = document.getElementById("tab-menu")!;
  tabMenuTarget = docId;
  const selBtn = menu.querySelector<HTMLButtonElement>('[data-act="close-selected"]')!;
  // 选中集>1 即显示（右键谁都可以批量关选中集，不要求右键目标本身在选中集内）
  const multi = tabSel.size > 1;
  selBtn.hidden = !multi;
  selBtn.textContent = t("tabCloseSelected"); // v0.3.16 按用户要求去掉计数后缀
  // 目标是最右标签时"关闭右侧"没东西可关——换成"关闭左侧"（资源管理器/Notepad++ 同语义自适应）
  // 按钮的 data-act 会被动态改写（close-right ↔ close-left），两种都查才找得到
  const rightBtn = menu.querySelector<HTMLButtonElement>('[data-act="close-right"], [data-act="close-left"]')!;
  const tabs = Array.from(document.querySelectorAll("#tabs .tab")) as HTMLElement[];
  const isLast = tabs.length > 0 && tabs[tabs.length - 1].dataset.docId === docId;
  rightBtn.dataset.act = isLast ? "close-left" : "close-right";
  rightBtn.textContent = isLast ? t("tabCloseLeft") : t("tabCloseRight");
  menu.hidden = false;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - mw - 4) + "px";
  menu.style.top = Math.min(y, window.innerHeight - mh - 4) + "px";
}
function hideTabMenu(): void {
  const m = document.getElementById("tab-menu");
  if (m) m.hidden = true;
  tabMenuTarget = null;
}
function initTabMenu(): void {
  const menu = document.getElementById("tab-menu")!;
  menu.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-act]") as HTMLButtonElement | null;
    if (!btn || !tabMenuTarget) return;
    const act = btn.dataset.act!;
    const target = tabMenuTarget; // 先取再 hide（hideTabMenu 会置 null，先 hide 后取=关空气）
    hideTabMenu();
    // 批量关闭按标签栏顺序逐个走 closeDoc（dirty 的逐个弹确认，Notepad++ 同行为）
    const idsInOrder = Array.from(document.querySelectorAll("#tabs .tab")).map(
      (el) => (el as HTMLElement).dataset.docId!
    );
    let toClose: string[];
    if (act === "close") toClose = [target];
    else if (act === "close-others") toClose = idsInOrder.filter((id) => id !== target);
    else if (act === "close-right") toClose = idsInOrder.slice(idsInOrder.indexOf(target) + 1);
    else if (act === "close-left") toClose = idsInOrder.slice(0, idsInOrder.indexOf(target));
    else if (act === "close-all") toClose = idsInOrder;
    else if (act === "close-selected") toClose = idsInOrder.filter((id) => tabSel.has(id));
    else return;
    for (const id of toClose) await closeDoc(id);
    tabSel.clear();
    renderTabs();
  });
  // 点菜单外任意处收起（含滚动/右键别处）
  window.addEventListener("mousedown", (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) hideTabMenu();
  });
}

// ===== v0.3.21 自建撤销/重做快照栈（per-doc） =====
// Vditor 内部 undo 栈实测粒度坏：连续多段输入合并成一个 undo 单元（一次 Ctrl+Z 撤光全部），
// 且首个 Ctrl+Z 常被吞。自建栈按「输入停顿(600ms) + 单步字符增量(8字)」双阈值分步记快照
// （Word 式逐步撤销：连打长段/IME 长上屏也会切步），Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 分发。
let snapBase = ""; // 当前步开始前的内容值
let snapStepOpen = false; // 是否处于未封口的输入步中
let snapTimer = 0;
function snapReset(doc: Doc | null): void {
  window.clearTimeout(snapTimer);
  snapBase = doc ? doc.content.replace(/\r\n/g, "\n") : ""; // 归一：磁盘CRLF vs getValue LF
  snapStepOpen = false;
  syncUndoBtns(); // 切换文档后按钮禁用态跟随新文档的栈
}
const SNAP_STEP_MS = 1500; // Word 式编辑会话空闲窗：连按退格删一个标题全程可超 900ms，
// 600ms 窗会在连删中途到期复位、后半段又开新步（实测 7 连删被切成 2 步，"撤一次只回半个标题"根因）。
// Word 的真实语义=连续同类编辑（不插其他操作）合为一步，窗口必须覆盖整段连击。
const SNAP_STEP_CHARS = 8; // 单步字符增量阈值：连打长段/IME 长上屏按 ~8 字切步，
// 否则"一直打字不停顿"整篇并成一步，Ctrl+Z 一下回到很久以前（用户 2026-08-31 反馈）
let restoreFreezeUntil = 0; // 撤销/重做恢复后的冻结窗：setValue 触发的 afterRender 定时器
// 会晚于同步 suppressInput 复位再调 options.input/原生 input——漏网信号会把刚弹出的值
// 重新入栈并清空 redoStack（"重做按钮恒灰"+栈自我修复的假动作根因）
function snapOnInput(doc: Doc, cur: string): void {
  if (Date.now() < restoreFreezeUntil) return;
  if (cur === snapBase && !snapStepOpen) return;
  // 字数切步只对"变长"（打字）生效：删除收窄靠时间窗+导航切步——实测连删标题 7 字
  // 恰撞 8 字线被腰斩成两步（栈里出现 25 字中间态），"撤一次只回半个标题"根因
  // （__snapLog t=9548 curLen=25 baseLen=33 实锤）
  if (snapStepOpen && cur.length - snapBase.length >= SNAP_STEP_CHARS) {
    snapBase = cur; snapStepOpen = false; // 增量达阈值即封口，本事件继续走下方"开新步"
  }
  if (!snapStepOpen) {
    // 新一步开启：步前值入栈（undo 将恢复到它）；任何新输入使 redo 分支作废。
    // 入栈时去重（不在 docUndo 出栈时弹）：setValue 后 Vditor 取值有规范化差异，
    // 出栈端弹"空步"会把相邻两步一次弹光（实测一次 Ctrl+Z 跳回初始+按钮置灰根因）
    snapStepOpen = true;
    if (doc.undoStack[doc.undoStack.length - 1] !== snapBase) {
      doc.undoStack.push(snapBase);
      if (doc.undoStack.length > 100) doc.undoStack.shift(); // 栈深上限
    }
    doc.redoStack.length = 0;
    syncUndoBtns();
  }
  window.clearTimeout(snapTimer);
  lastEditSignalAt = Date.now(); // 续编辑会话：紧随其后的导航键不切步
  snapTimer = window.setTimeout(() => { snapBase = cur; snapStepOpen = false; }, SNAP_STEP_MS);
}

// ===== v0.3.25 大文档延迟取值（Notepad++「单一数据源」思路的 DOM 系近似） =====
// getValue() 对 57 万字符文档 = 465ms/次（Lute DOM→md 全量序列化，无缓存）。原 input 链每键
// 调 1-2 次 = 每键近 1s 阻塞。大文档改为：逐键只置 dirty + 重置 400ms 空闲定时器，空闲时一次
// 取值统一回填（doc.content / 撤销记步 / 大纲）。保存/导出/查找等消费方本就按需自取真值，不受影响。
const LARGE_FLUSH_MS = 1500; // 须盖过 Vditor 内部 afterRender 防抖(~1s)：过早取值拿到的是编辑前的
// 旧缓存值（WebView2 实测键入后 400ms 取 getValue 仍无新字符，1.5s 后才有）——与 SNAP_STEP_MS 同窗
let valueSyncTimer = 0;
let valueSyncPending = false;
function scheduleValueSync(doc: Doc): void {
  window.clearTimeout(valueSyncTimer);
  valueSyncPending = true;
  valueSyncTimer = window.setTimeout(() => flushValueSync(doc), LARGE_FLUSH_MS);
}
function flushValueSync(doc: Doc): void {
  if (!valueSyncPending) return; // 无待同步（30s 自动保存的主动对账分支用：空闲阅读零成本）
  window.clearTimeout(valueSyncTimer);
  valueSyncPending = false;
  if (switchApplyPending) return; // 切换装载期不取值（见 switchApplyPending 注释）
  if (!vditor || activeDoc()?.id !== doc.id) return; // 守卫：切换/关闭标签后 mdValue() 取到的已是
  // 别的文档内容，回填会串文档（switchDoc 自己已同步存离场文档的值）
  if (doc.lazy || doc.loading) return; // v0.3.26 惰性装载窗口：定时器晚触发，丢弃
  const v = mdValue();
  if (v !== "" || doc.content === "") doc.content = v; // 空值守卫（同 options.input）
  doc.large = v.length > LARGE_DOC_CHARS; // 小文档长过阈值后也切换到延迟通道
  doc.bytes = utf8Bytes(v); // v0.3.26 状态栏大小随 flush 更新
  snapOnInput(doc, v);
  scheduleOutline();
}
// 光标重定位=切步（Word 语义）：删完标题后 Ctrl+End/点击跳到别处再删=新的删除意图，应单独成步。
// 不能用 selectionchange——行首 Backspace 删段落分隔时光标必然大跳（删除的结果而非用户意图），
// 会被误封口并把 snapBase 刷成删后值，导致该删除永不进栈（实测丢步根因）。
// 只认导航键 keydown 与编辑区 mousedown，且距上次编辑信号 >400ms（防输入法选词/删除连击误切）。
let lastEditSignalAt = 0;
const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
function navSealStep(): void {
  if (activeDoc()?.large) return; // v0.3.25 大文档：封口须全量 mdValue(465ms)，浏览跳转每下都
  // 卡不可接受——撤销分步退化为纯时间窗（1500ms 定时器自行封口），粒度变粗记入取舍
  if (snapStepOpen) {
    window.clearTimeout(snapTimer);
    snapBase = mdValue(); snapStepOpen = false; // 封口：跳转前的内容单独成步
  }
}
document.addEventListener("keydown", (e) => {
  if (!NAV_KEYS.has(e.key)) return;
  if (Date.now() - lastEditSignalAt < 400) return;
  navSealStep();
}, true);
document.addEventListener("mousedown", (e) => {
  const t = e.target as Element | null;
  if (!t?.closest?.(".vditor-reset")) return;
  if (Date.now() - lastEditSignalAt < 400) return;
  navSealStep();
}, true);
// 测试钩子：CDP 合成 keydown 会被 Vditor 元素层拦截（真实键盘不受影响，AHK 冒烟已实证），
// e2e 直接调函数测栈逻辑；键盘链路覆盖交给 AHK 真实输入层。
(window as any).__mdUndo = () => docUndo();
// 测试钩子：只读暴露 docs 内部态（dirty/base/栈深），供 e2e 诊断保存时序类问题
Object.defineProperty(window, "__mdDocs", { get: () => docs });
(window as any).__mdRedo = () => docRedo();
// v0.3.21 删除动作分步+记步兜底（用户实测"删三行，一次 Ctrl+Z 恢复两行"根因）：
// Vditor 对 Backspace/Delete 走自有 DOM 删除路径，不触发原生 input 事件——逐字符阈值收不到
// 信号，且该路径连 options.input 兜底都常常不发，删除内容完全不进撤销栈（Ctrl+Z 跳步）。
// ①按下时：距上次删除键 >1500ms（同 600ms 会话窗教训：400ms 连 7 键退格会被拦腰切两段）
//    且有开步 → 封口前段（间隔久的删除=新删除意图）
// ②抬起后 80ms：值变了但没有任何信号开过步 → 主动 snapOnInput 记步（兜住纯 DOM 删除）
let lastDelKeyAt = 0;
document.addEventListener("keydown", (e) => {
  if (e.key !== "Backspace" && e.key !== "Delete") return;
  if (e.isComposing) return; // 组合中的退格=删拼音串，交给输入法
  const now = Date.now();
  if (now - lastDelKeyAt > 1500 && snapStepOpen && !activeDoc()?.large) { // v0.3.25 大文档跳过（同 navSealStep：不为封口付 465ms）
    window.clearTimeout(snapTimer);
    snapBase = mdValue(); snapStepOpen = false; // 封口：删除动作之前的内容单独成步
  }
  lastDelKeyAt = now;
  lastEditSignalAt = now; // 连删期间导航键不切步（Ctrl+End 定位后紧接的删除仍是同会话）
}, true);
document.addEventListener("keyup", (e) => {
  if (e.key !== "Backspace" && e.key !== "Delete") return;
  window.setTimeout(() => {
    if (suppressInput || !vditor) return;
    const doc = activeDoc();
    if (!doc || snapStepOpen) return; // 已有 input 信号开步则不重复
    if (doc.large) { scheduleValueSync(doc); return; } // v0.3.25 大文档：删除兜底改走延迟通道
    const v = mdValue();
    if (v !== snapBase) snapOnInput(doc, v); // 基准用 snapBase：doc.content 会被 30s 自动保存刷新，用它判会漏记（用户实测删标题后按钮仍灰）
  }, 80);
}, true);
// v0.3.21 Word 式分步信号源：原生 input 逐字符可达。Vditor 的 options.input 挂在其内部
// afterRender 定时器上且 composingLock 过滤，连打整段常合并成一次触发——字符阈值分步
// 在那里收不到逐字符信号（实测 10 字连打 delay40ms：原生 input×10 vs 栈深 1 不切步）。
// 组合态（IME 打字中）跳过：组合中间态序列化有毒（拼音字母混进 mdValue）；
// 上屏终值由 options.input（composingLock 解除后触发）兜底记步。
document.addEventListener("input", (e) => {
  if (suppressInput) return;
  if (switchApplyPending) return; // v0.3.25 大文档切换装载期：旧 DOM 的信号丢弃（防串文档）
  if ((e as InputEvent).isComposing) return;
  const t = e.target as Element | null;
  if (!t?.closest?.(".vditor")) return;
  const doc = activeDoc();
  if (doc && (doc.lazy || doc.loading)) return; // v0.3.26 惰性装载窗口：旧文档信号丢弃（防串）
  if (doc && vditor) {
    // v0.3.25 大文档：逐键 mdValue(465ms@57万字) 不可承受——逐键只重置 400ms 空闲定时器（廉价
    // 信号保住"有编辑发生"的感知），空闲时 flushValueSync 一次取值回填（粒度=输入串）。
    // dirty 立即置位：options.input 挂 Vditor afterRender 防抖（大文档更慢），快速关标签不能依赖它
    if (doc.large) { doc.dirty = true; scheduleValueSync(doc); return; }
    snapOnInput(doc, mdValue());
  }
}, true);
// v0.3.21 撤销/重做按钮（Word 式双通道）：劫持 Vditor 自带按钮点击走自建栈。
// 捕获层挂 .vditor-toolbar（父层 capture 先于按钮自身 listener，Vditor 内部 undo 不再执行）。
function setupUndoToolbar(): void {
  const bar = document.querySelector(".vditor-toolbar");
  if (!bar) return;
  if (!(bar as unknown as { __mdUndoBound?: boolean }).__mdUndoBound) {
    (bar as unknown as { __mdUndoBound?: boolean }).__mdUndoBound = true;
    bar.addEventListener("click", (e) => {
      const ty = (e.target as Element | null)?.closest?.("[data-type]")?.getAttribute("data-type");
      if (ty === "undo") { e.preventDefault(); e.stopPropagation(); docUndo(); }
      else if (ty === "redo") { e.preventDefault(); e.stopPropagation(); docRedo(); }
    }, true);
    // 注：曾试 MutationObserver 纠偏按钮态——setAttribute 同值也排队 mutation record，
    // syncUndoBtns↔observer 微任务风暴直接挂死页面（实锤），删除。
  }
  syncUndoBtns();
}
function syncUndoBtns(): void { // 栈空灰显（Word 式）
  const d = activeDoc();
  // 双通道置灰（2026-08-31 用户实锤"重做按钮恒灰但 CDP 读 disabled=false"）：
  // Vditor 的 disableToolbar/enableToolbar 走 CSS class vditor-menu--disabled（视觉灰），
  // 不设 disabled 属性；此前只设属性=「JS 读数亮、用户看到灰」读写分裂。
  // 属性拦点击（DOM 语义），class 管视觉——两套必须同进退，且摘掉 Vditor 历史加的 class。
  // querySelectorAll 遍历所有 toolbar 实例（模式/语言切换 Vditor 重建后旧节点可能残留，
  // 只同步第一个会出现"活按钮恒灰、点不动"——用户 2026-08-31 反馈重做按钮不可点）
  document.querySelectorAll<HTMLButtonElement>('.vditor-toolbar [data-type="undo"]').forEach((u) => {
    u.disabled = !d || d.undoStack.length === 0;
    u.classList.toggle("vditor-menu--disabled", u.disabled);
  });
  document.querySelectorAll<HTMLButtonElement>('.vditor-toolbar [data-type="redo"]').forEach((r) => {
    r.disabled = !d || d.redoStack.length === 0;
    r.classList.toggle("vditor-menu--disabled", r.disabled);
  });
}
function syncUndoBtnsSoon(): void { // 异步竞争兜底：撤销/重做后 300ms 复刷一次（Vditor 内部
  // 异步尾巴若再碰按钮态，这里拉回真值；one-shot 非常驻）
  window.setTimeout(syncUndoBtns, 300);
}
// 重入去重（v0.3.21 根修"一次 Ctrl+Z 撤两步"）：Vditor 的 processKeydown 也会响应 ⌘Z/⌘Y 并
// 转发为按钮点击（toolbar 捕获层劫持→docUndo 第二次调用，__undoCnt=2/一次 keydown 实锤）。
// 250ms 内的重复调用只执行第一次——80ms 实测不够（转发链路经 Vditor 内部定时器可超 80ms）。
let lastUndoMs = 0, lastRedoMs = 0;
function docUndo(): void {
  const doc = activeDoc();
  if (!doc || !vditor) return;
  const nowMs = Date.now();
  if (nowMs - lastUndoMs < 700) return; // 同一按键的转发重复，丢弃（Vditor 转发链经 afterRender 定时器，实测可晚 577ms）
  lastUndoMs = nowMs;
  const cur = mdValue();
  if (snapStepOpen) { window.clearTimeout(snapTimer); snapBase = cur; snapStepOpen = false; } // 封口当前步
  // 注：不在出栈端弹"空步"——setValue 后 Vditor 取值规范化会让 cur 恒等栈顶，
  // while 连弹把多步一次撤光（实测一次 Ctrl+Z 直达初始+按钮置灰）。入栈去重见 snapOnInput。
  if (doc.undoStack.length === 0) { syncUndoBtns(); return; }
  doc.redoStack.push(cur);
  restoreDocValue(doc, doc.undoStack.pop()!);
  syncUndoBtnsSoon();
}
function docRedo(): void {
  const doc = activeDoc();
  if (!doc || !vditor || doc.redoStack.length === 0) return;
  const nowMs = Date.now();
  if (nowMs - lastRedoMs < 700) return; // Vditor 转发按钮点击的重复调用，丢弃
  lastRedoMs = nowMs;
  const cur = mdValue(); // 与 docUndo 对称：当前值回 undo 栈（snapBase 在未封步时≠当前值）
  if (snapStepOpen) { window.clearTimeout(snapTimer); snapStepOpen = false; }
  doc.undoStack.push(cur);
  restoreDocValue(doc, doc.redoStack.pop()!);
  syncUndoBtnsSoon();
}
function restoreDocValue(doc: Doc, v: string): void {
  doc.content = v;
  suppressInput = true;
  restoreFreezeUntil = Date.now() + 800; // 冻结窗盖过 Vditor afterRender 定时器的异步尾巴
  vditor!.setValue(v, true);
  suppressInput = false;
  snapBase = v;
  doc.dirty = v !== doc.base; // base=磁盘版内容，撤销到与磁盘一致即干净态
  updateTitle();
  renderTabs();
  scheduleOutline();
  syncUndoBtns();
}

// v0.3.25 大文档延迟加载：双 rAF 让帧期间编辑器还是旧文档 DOM，此刻的键入若进 input 链，
// 会把「旧 DOM 序列化值」写进新 activeDoc（串文档）——切换期一律丢弃编辑信号
let switchApplyPending: string | null = null;
let switchSeq = 0; // 快速连切标签：旧 rAF 回调不得覆盖后来者
function switchDoc(id: string) {
  hideEmptyState(); // 切到有内容的文档，隐藏空状态
  tabSel.clear(); // 新激活产生=多选态作废（树上/最近/快开/ES 打开文件都应取消选中集，v0.3.21）
  document.getElementById("big-load")?.setAttribute("hidden", ""); // 新切换先清旧延迟加载留下的提示
  document.getElementById("big-doc-bar")?.setAttribute("hidden", ""); // v0.3.26 大文档提示条随切换隐藏
  document.getElementById("ext-mod-bar")?.setAttribute("hidden", ""); // 外改提示条绑定文档，切走即收
  extBarDoc = "";
  // 保存当前文档内容到其 Doc（getValue 守卫：空值不覆盖）
  if (vditor) {
    const cur = activeDoc();
    if (cur) {
      const v = mdValue();
      if (v !== "" || cur.content === "") cur.content = v;
      if (!cur.lazy) cur.scrollTop = editorScrollEl()?.scrollTop ?? cur.scrollTop; // v0.3.26 阅读位置随离开存档
    }
  }
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  // v0.3.26 惰性标签：先读盘再走正常装载（loading 防连点；大文档加载期 activeId 已指向它，
  // renderTabs 高亮正确，读盘完成后此处再进 switchDoc 走 applyContent）
  if (doc.lazy) {
    activeId = id;
    renderTabs();
    updateTitle();
    void loadLazyDoc(doc);
    return;
  }
  activeId = id;
  scheduleSessionSave(); // v0.3.26 会话：活动标签变化
  void checkExternalMod(doc); // v0.3.26 外改检测：切到即核（mtime+size 双指标）
  const seq = ++switchSeq;
  const applyContent = (): void => {
    switchApplyPending = null;
    if (seq !== switchSeq || activeId !== id || !vditor) return; // 已被更快的切换接管
    // 切换文档时清空 undo/redo 栈并以新文档为唯一基线：Vditor 栈是 per-instance(非 per-doc)，
    // 不清栈会让新旧文档全文 diff 污染栈，导致一次 undo 回退整篇内容（"撤销一次撤多步"根因）。
    suppressInput = true;
    vditor.setValue(doc.content, true);
    suppressInput = false;
    snapReset(doc); // 撤销基线跟随新文档（per-doc 栈隔离）
    rebuildOutline();
    // v0.3.26 阅读位置：setValue 会把滚动归零，装载后回滚（会话恢复用 restoreScroll，
    // 普通切换用离开时存的 scrollTop——否则切回标签总在顶部，且会把已存位置覆盖成 0）
    const target = doc.restoreScroll != null ? doc.restoreScroll : doc.scrollTop;
    doc.restoreScroll = null;
    if (target > 0) {
      window.setTimeout(() => { const el = editorScrollEl(); if (el) el.scrollTop = target; }, 0);
    }
    updateStatus(); // v0.3.26 状态栏随文档切换刷新（大小/选中归零）
  };
  if (doc.large) {
    // v0.3.25 大文档：同步 setValue 阻塞 1-6s（57万字 1.2s），先亮加载提示并双 rAF 让出
    // （保证提示先绘制）再装载，阻塞期用户有反馈；applyContent 兜底清提示（含被接管时）
    switchApplyPending = id;
    const hint = document.getElementById("big-load");
    if (hint) { hint.textContent = t("bigLoad"); hint.removeAttribute("hidden"); }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      applyContent();
      document.getElementById("big-load")?.setAttribute("hidden", "");
    }));
  } else {
    applyContent();
  }
  renderTabs();
  updateTitle();
  markTreeCurrent(); // 文件树当前文件高亮随标签切换（树不重载，保住展开态）
}

// 全部标签关闭后的空状态（允许关闭欢迎页）：遮住编辑区，提示打开文件
function showEmptyState() {
  document.getElementById("big-load")?.setAttribute("hidden", ""); // 清可能残留的大文件加载提示
  document.getElementById("empty-state")!.hidden = false;
  if (vditor) { suppressInput = true; vditor.setValue("", true); suppressInput = false; }
  const ul = document.getElementById("outline");
  if (ul) ul.innerHTML = '<li class="empty">' + esc(t("noOpenFile")) + "</li>";
  updateTitle(); // 兜底：确保空状态下标题显示「（无）」而非残留旧文档名
}
function hideEmptyState() {
  document.getElementById("empty-state")!.hidden = true;
}

async function closeDoc(id: string) {
  const idx = docs.findIndex((d) => d.id === id);
  if (idx < 0) return;
  const doc = docs[idx];
  if (doc.dirty) {
    const action = await showCloseConfirm(); // 三选项：保存并关闭 / 不保存关闭 / 取消
    if (action === "cancel") return;
    if (action === "save") {
      const ok = await saveDoc(doc);
      if (!ok) return; // 保存失败或取消另存，不关闭
    }
  }
  docs.splice(idx, 1);
  if (activeId === id) {
    activeId = null;
    const next = docs[idx] || docs[idx - 1] || null;
    if (next) switchDoc(next.id);
    else showEmptyState(); // 全部标签关闭：显示空状态（允许关闭欢迎页，不再强制重开）
  }
  renderTabs();
  scheduleSessionSave(); // v0.3.26 会话：标签结构变化
}

function openDoc(path: string | null, content: string, name?: string, encoding?: string) {
  hideEmptyState(); // 打开文档时隐藏空状态
  closeFind(); // 文档切换后旧匹配节点失效，收起查找条
  // 大文件防线（v0.3.25 实测重设）：v0.3.16 的 256KB 拒开线源自当年 500KB 渲染冻结；
  // 2026-09-07 headless 基准复测当前引擎不复现（57万字渲染 2.5s 收敛、2.86M 字符 10.9s，
  // 伸缩近线性），真根因是每键 getValue 全量序列化（465ms）——已由大文档延迟取值通道解决。
  // 新拒开线 2M 字符：超过后键入延迟超 400ms、渲染超 8s，体验不成立。所有打开路径
  // （树/最近/快开/dnd/命令行）统一在此拦截。
  if (content.length > MAX_OPEN_CHARS) {
    showToast(t("fileTooBig") + bigSizeLabel(content.length) + t("fileTooBigSuf"), "danger");
    return;
  }
  // 同路径已打开 → 直接切换过去，不重复开
  if (path) {
    const existing = docs.find((d) => d.path === path);
    if (existing) {
      switchDoc(existing.id);
      // 已打开的文件也要树联动：点"最近"里已开过的文件（如其它目录），树根得跟着切
      const dir = docDirOf(path);
      if (dir && dir.toLowerCase() !== (ftreeRoot || "").toLowerCase()) void locateTreeAt(dir);
      else markTreeCurrent();
      return;
    }
  }
  const doc: Doc = {
    id: newDocId(),
    path,
    name: name || (path ? path.split(/[\\/]/).pop()! : t("untitled")),
    content,
    dirty: false,
    encoding: encoding || "",
    undoStack: [],
    redoStack: [],
    base: content.replace(/\r\n/g, "\n"), // 同 snapReset 归一：磁盘 CRLF vs getValue LF，不归一则撤到底 dirty 不清
    large: content.length > LARGE_DOC_CHARS, // v0.3.25 大文档延迟取值通道
    lazy: false,
    loading: false,
    restoreScroll: null,
    scrollTop: 0,
    metaMtime: 0,
    metaSize: 0,
    bytes: utf8Bytes(content),
  };
  docs.push(doc);
  switchDoc(doc.id);
  refreshMeta(doc); // v0.3.26 外改检测基准（异步，不阻塞打开）
  if (doc.large) showBigDocBar(); // v0.3.26 大文档提示条（ir 模式另有卡顿警告）
  scheduleSessionSave(); // v0.3.26 会话：标签结构变化
  if (path) {
    pushRecent(path);
    // 树根联动：换目录才整树重建（含点"最近"里其它目录的文件），同目录只挪高亮
    const dir = docDirOf(path);
    if (dir && dir.toLowerCase() !== (ftreeRoot || "").toLowerCase()) void locateTreeAt(dir);
    else markTreeCurrent();
  }
}

// ===== v0.3.26 会话持久化（Notepad++ session.xml 同构）+ 外部修改检测 + 状态栏 =====
// 会话存 ui-state.json 的 session 键：{ v:1, tabs:[{p,n,s,m,z}], a }——
// p=路径 n=文件名 s=scrollTop m=mtime z=size，a=活动标签路径。只收有路径的文档
//（未命名/欢迎页不恢复）；恢复时活动标签真读盘、其余 lazy 占位（激活才读盘，#9 惰性恢复）。
interface SessionTab { p: string; n: string; s: number; m: number; z: number }
let sessionSaveTimer = 0;
function utf8Bytes(s: string): number {
  // 状态栏文件大小用（估 UTF-8 落盘字节数；仅低频路径调用——open/flush/save）
  return new TextEncoder().encode(s).length;
}
function saveSession(): void {
  // 无路径文档（未命名/欢迎页）不进会话；lazy 占位也存（有 path，激活时才读）
  const active = activeDoc();
  if (active && !active.lazy) active.scrollTop = editorScrollEl()?.scrollTop ?? active.scrollTop;
  const tabs: SessionTab[] = docs
    .filter((d) => !!d.path)
    .map((d) => ({ p: d.path!, n: d.name, s: Math.round(d.scrollTop), m: d.metaMtime, z: d.metaSize }));
  if (tabs.length === 0) { // 空会话也写（清掉旧会话：用户全关后下次不该再恢复）
    if (uiStateAll.session) saveUiStateKey("session", null);
    return;
  }
  saveUiStateKey("session", { v: 1, tabs, a: active?.path || tabs[0].p });
}
function scheduleSessionSave(): void {
  window.clearTimeout(sessionSaveTimer);
  sessionSaveTimer = window.setTimeout(saveSession, 800); // 防抖：连续开/关标签只写一次
}

// 惰性占位 doc 激活时读盘（switchDoc 检测 lazy 转入此处；完成后走正常 switchDoc 路径）
async function loadLazyDoc(doc: Doc, silent = false): Promise<void> {
  if (doc.loading || !doc.lazy) return;
  doc.loading = true;
  try {
    const [content, enc] = await invoke<[string, string]>("open_file", { path: doc.path });
    if (content.length > MAX_OPEN_CHARS) { // 会话期间文件被撑大：同样过拒开线
      showToast(t("fileTooBig") + bigSizeLabel(content.length) + t("fileTooBigSuf"), "danger");
      doc.loading = false;
      closeDoc(doc.id);
      return;
    }
    doc.content = content;
    doc.encoding = enc || "";
    doc.base = content.replace(/\r\n/g, "\n");
    doc.large = content.length > LARGE_DOC_CHARS;
    doc.bytes = utf8Bytes(content);
    doc.dirty = false;
    doc.lazy = false;
    refreshMeta(doc);
    if (doc.large) showBigDocBar();
  } catch (e) {
    // 文件已被删除/移走：去掉占位标签。silent（启动会话恢复）不打扰——测试/清理留下的
    // 死标签一批弹 N 个 alert 不可接受（2026-09-08 实况）；用户主动点开仍提示
    doc.loading = false;
    closeDoc(doc.id);
    if (!silent) showToast(t("openFail") + e, "danger");
    return;
  }
  doc.loading = false;
  switchDoc(doc.id); // lazy=false 走正常装载（restoreScroll 在 applyContent 尾部消费）
}

// 启动会话恢复：成功=true（boot 据此跳过欢迎页）。带启动文件时不恢复（双击 .md=明确意图）
async function restoreSession(): Promise<boolean> {
  const s = uiStateAll.session as { v?: number; tabs?: SessionTab[]; a?: string } | null | undefined;
  if (!s || !Array.isArray(s.tabs) || s.tabs.length === 0) return false;
  const tabs = s.tabs.filter((x) => x && typeof x.p === "string").slice(0, 20);
  if (tabs.length === 0) return false;
  const activePath = typeof s.a === "string" ? s.a : tabs[0].p;
  let activeId = "";
  for (const tab of tabs) {
    const doc: Doc = {
      id: newDocId(),
      path: tab.p,
      name: tab.n || tab.p.split(/[\\/]/).pop() || t("untitled"),
      content: "",
      dirty: false,
      encoding: "",
      undoStack: [],
      redoStack: [],
      base: "",
      large: false,
      lazy: true, // 全部以惰性形态构造：活动标签紧接着 loadLazyDoc 真读盘（lazy 置 false）。
      // 不能直接给活动标签 lazy:false——loadLazyDoc 开头 !doc.lazy 即 return，标签永远空内容
      loading: false,
      restoreScroll: tab.s > 0 ? tab.s : null,
      scrollTop: tab.s || 0,
      metaMtime: tab.m || 0,
      metaSize: tab.z || 0,
      bytes: 0,
    };
    docs.push(doc);
    if (tab.p === activePath) activeId = doc.id;
  }
  hideEmptyState();
  if (activeId) {
    const d = docs.find((x) => x.id === activeId)!;
    await loadLazyDoc(d, true); // 活动标签同步加载（含大文档路径/防线）；silent=死文件静默清
    if (!docs.some((x) => x.id === activeId)) {
      // 活动标签死了：剩标签→激活第一个（lazy，switchDoc 内会读盘）；全灭→当无会话开欢迎页
      if (docs.length === 0) return false;
      const next = docs[0];
      activeId = next.id;
      renderTabs();
      updateTitle();
      void loadLazyDoc(next, true);
    }
  }
  return true;
}

// ----- 外部修改检测：mtime+size 双指标比对（N++ originalFileLastModifTimestamp 同构）-----
async function refreshMeta(doc: Doc): Promise<void> {
  if (!doc.path) return;
  try {
    const m = await invoke<{ mtimeMs: number; size: number }>("file_meta", { path: doc.path });
    doc.metaMtime = m.mtimeMs;
    doc.metaSize = m.size;
  } catch { /* 文件暂不可读：基准不更新（下次比对仍会提示） */ }
}
let extBarDoc = ""; // 提示条当前指向的 docId（切换文档自动失效）
async function checkExternalMod(doc: Doc): Promise<void> {
  if (!doc.path || doc.lazy || !vditor) return;
  try {
    const m = await invoke<{ mtimeMs: number; size: number }>("file_meta", { path: doc.path });
    if (activeDoc()?.id !== doc.id) return; // 异步回来时已切走：不弹
    const changed = doc.metaMtime !== 0 && (m.mtimeMs !== doc.metaMtime || m.size !== doc.metaSize);
    if (changed) showExtBar(doc, false);
  } catch {
    if (activeDoc()?.id === doc.id) showExtBar(doc, true); // 文件没了（被删/移走）
  }
}
function showExtBar(doc: Doc, deleted: boolean): void {
  const bar = document.getElementById("ext-mod-bar");
  if (!bar) return;
  extBarDoc = doc.id;
  bar.hidden = false;
  const msg = document.getElementById("ext-mod-msg")!;
  msg.textContent = deleted
    ? t("extDeleted").replace("{f}", doc.name)
    : (doc.dirty ? t("extChangedDirty") : t("extChanged")).replace("{f}", doc.name);
  const reloadBtn = document.getElementById("ext-reload") as HTMLButtonElement | null;
  if (reloadBtn) reloadBtn.hidden = deleted; // 文件没了没有"重新加载"，只剩忽略/关闭
  const disBtn = document.getElementById("ext-dismiss") as HTMLButtonElement | null;
  if (reloadBtn) reloadBtn.textContent = t("extReload");
  if (disBtn) disBtn.textContent = t("extDismiss");
}
async function reloadFromDisk(doc: Doc): Promise<void> {
  try {
    const [content, enc] = await invoke<[string, string]>("open_file", { path: doc.path });
    if (content.length > MAX_OPEN_CHARS) { showToast(t("fileTooBig") + bigSizeLabel(content.length) + t("fileTooBigSuf"), "danger"); return; }
    doc.content = content;
    doc.base = content.replace(/\r\n/g, "\n");
    doc.large = content.length > LARGE_DOC_CHARS;
    doc.bytes = utf8Bytes(content);
    doc.dirty = false;
    doc.encoding = enc || "";
    doc.undoStack = [];
    doc.redoStack = [];
    if (activeDoc()?.id === doc.id) {
      suppressInput = true;
      vditor!.setValue(content, true);
      suppressInput = false;
      snapReset(doc);
      rebuildOutline();
      doc.scrollTop = 0;
    }
    refreshMeta(doc);
  } catch (e) {
    showToast(t("openFail") + e, "danger");
  }
}

// ----- 状态栏（v0.3.26 起；v0.4.0 移到底部精密状态栏）：已选字符数 + 总字数 + 预计阅读时长 -----
let counterLen = 0; // Vditor counter after(len) 的缓存（selectionchange 时重拼文案用）
let statusSelLen = 0;
function updateStatus(): void {
  // v0.4.0 编辑器左下 counter 胶囊退役（CSS 隐藏，Vditor counter 仍作数据源），文案写进底部状态栏
  const parts: string[] = [];
  if (statusSelLen > 0) parts.push(t("statusSelected").replace("{n}", String(statusSelLen)));
  parts.push(`${counterLen} ${t("wordCount")}`);
  const sbCount = document.getElementById("sb-count");
  if (sbCount) sbCount.textContent = parts.join(" · ");
  const sbRead = document.getElementById("sb-read");
  if (sbRead) {
    // 预计阅读时长：中文 300-500 字/分取 400；空文档/极短不显示（克制）
    sbRead.textContent = counterLen >= 200 ? "≈ " + Math.max(1, Math.round(counterLen / 400)) + " " + t("readMin") : "";
  }
}
// v0.4.0 保存态（状态栏左段）：dirty=强调色"未保存"，干净=灰"已保存"；无文档隐藏
function updateSaveState(): void {
  const el = document.getElementById("sb-save");
  if (!el) return;
  const d = activeDoc();
  if (!d) { el.hidden = true; return; }
  el.hidden = false;
  if (d.dirty) { el.textContent = "● " + t("statusUnsaved"); el.className = "sb-seg dirty"; }
  else { el.textContent = t("statusSaved"); el.className = "sb-seg saved"; }
}
function trackSelectionStatus(): void {
  const sel = getSelection();
  const editable = document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset");
  if (!sel || sel.rangeCount === 0 || !editable || !sel.anchorNode || !editable.contains(sel.anchorNode)) {
    if (statusSelLen !== 0) { statusSelLen = 0; updateStatus(); }
    return;
  }
  const n = sel.toString().length;
  if (n !== statusSelLen) { statusSelLen = n; updateStatus(); }
}

// ----- 大文档提示条（v0.3.26 降级模式）：编辑延迟说明 + ir 模式卡顿警告 -----
function showBigDocBar(): void {
  const bar = document.getElementById("big-doc-bar");
  if (!bar) return;
  const msg = document.getElementById("big-doc-msg")!;
  msg.textContent = currentMode === "ir" ? t("bigDocBarIr") : t("bigDocBar");
  bar.hidden = false;
}

// ----- 查找/替换历史（v0.3.26，N++ 10 条同构）：ui-state.json 持久化 + datalist 下拉 -----
const FIND_HISTORY_MAX = 10;
function findHistoryList(key: "findHist" | "repHist"): string[] {
  const v = uiStateAll[key];
  return Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}
function pushFindHistory(key: "findHist" | "repHist", q: string): void {
  q = q.trim();
  if (!q) return;
  const list = findHistoryList(key).filter((x) => x !== q);
  list.unshift(q);
  saveUiStateKey(key, list.slice(0, FIND_HISTORY_MAX));
  renderFindHistory();
}
function renderFindHistory(): void {
  // datalist 原生下拉（零自绘 UI 成本；WebView2 支持良好，空历史挂着 list 属性无副作用）
  const mk = (dlId: string, items: string[]) => {
    const dl = document.getElementById(dlId);
    if (!dl) return;
    dl.innerHTML = "";
    for (const it of items) {
      const o = document.createElement("option");
      o.value = it;
      dl.appendChild(o);
    }
  };
  mk("find-hist-dl", findHistoryList("findHist"));
  mk("rep-hist-dl", findHistoryList("repHist"));
}

// ----- 提示条按钮绑定（外改检测 / 大文档），boot 一次性挂 -----
function initNoticeBars(): void {
  const reloadBtn = document.getElementById("ext-reload");
  if (reloadBtn) reloadBtn.addEventListener("click", () => {
    const bar = document.getElementById("ext-mod-bar");
    const doc = docs.find((d) => d.id === extBarDoc) || null;
    if (bar) bar.hidden = true;
    extBarDoc = "";
    if (doc) void reloadFromDisk(doc);
  });
  const dismissBtn = document.getElementById("ext-dismiss");
  if (dismissBtn) dismissBtn.addEventListener("click", () => {
    const bar = document.getElementById("ext-mod-bar");
    const doc = docs.find((d) => d.id === extBarDoc) || null;
    if (bar) bar.hidden = true;
    extBarDoc = "";
    if (doc) refreshMeta(doc); // 选"忽略"=以磁盘新状态为新基准，不再反复弹
  });
  const bigClose = document.getElementById("big-doc-close");
  if (bigClose) bigClose.addEventListener("click", () => {
    document.getElementById("big-doc-bar")?.setAttribute("hidden", "");
  });
}

// ===== v0.3.14 侧栏文件页（文件树/最近/跨文件搜索）+ 快速打开 + 暗色主题 =====

// ui-state.json 全量合并读写：zoom/theme/recent 共住一文件。此前 persistZoom 只写 {zoom}
// 单键覆盖，加 theme/recent 后必须合并写，否则互相清空对方的键。
let uiStateAll: Record<string, unknown> = {};
let uiStateSaveTimer = 0;
let uiStateLoaded = false; // load_ui_state 返回前不写盘（避免 boot 期 applyZoom 用 {zoom:1} 覆盖掉磁盘 theme/recent）
function saveUiStateKey(key: string, val: unknown): void {
  uiStateAll[key] = val;
  if (!uiStateLoaded) return;
  window.clearTimeout(uiStateSaveTimer);
  uiStateSaveTimer = window.setTimeout(() => {
    invoke("save_ui_state", { v: { ...uiStateAll } }).catch(() => { /* 保存失败不阻塞 UI */ });
  }, 150);
}

// ----- 最近文件（打开即记，去重置顶，留 10 条；侧栏显示前 8） -----
function recentList(): string[] {
  const r = uiStateAll.recent;
  return Array.isArray(r) ? (r as unknown[]).filter((x): x is string => typeof x === "string") : [];
}
function pushRecent(path: string): void {
  const list = recentList().filter((p) => p !== path);
  list.unshift(path);
  saveUiStateKey("recent", list.slice(0, 10));
  renderRecent();
}
function renderRecent(): void {
  const ul = document.getElementById("recent-list");
  if (!ul) return;
  ul.innerHTML = "";
  const list = recentList().slice(0, 8);
  if (list.length === 0) {
    ul.innerHTML = `<li class="empty">${esc(t("quickOpenEmpty"))}</li>`;
    return;
  }
  for (const p of list) {
    const li = document.createElement("li");
    const name = p.split(/[\\/]/).pop() || p;
    li.innerHTML = `<span class="rn">${esc(name)}</span><span class="rp">${esc(p)}</span>`;
    li.title = p;
    li.addEventListener("click", () => loadFile(p));
    ul.appendChild(li);
  }
}

// ----- 文件树（v0.3.17 常驻树=资源管理器左侧范式）："此电脑"+盘符列表恒在树顶，
// 点盘符/目录=原位懒展开（不再整树替换——用户反馈"进入某盘后其它盘符看不到、退不回去"）；
// 地址栏/↑/打开联动 = 定位展开（沿路径逐层展开到目标目录）。 -----
type TreeEntry = { name: string; path: string; is_dir: boolean };
function docDirOf(p: string | null): string | null {
  if (!p) return null;
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : null;
}
let ftreeToken = 0; // 并发防护：慢目录返回时若已发起新刷新则丢弃
let ftreeRoot: string | null = null; // 当前树根；换目录（导航/打开文件联动）时整树重建
function makeTreeNode(e: TreeEntry, depth: number): HTMLElement {
  const node = document.createElement("div");
  const editable = /\.(md|markdown|mdown|txt)$/i.test(e.path);
  node.className = "node " + (e.is_dir ? "dir" : "file") + (!e.is_dir && !editable ? " fx" : "");
  node.dataset.path = e.path;
  node.dataset.depth = String(depth);
  node.style.paddingLeft = 6 + depth * 14 + "px";
  node.innerHTML =
    `<span class="caret"></span>` + // v0.3.16 箭头改 CSS 三角（字形渲染环境差异）
    `<span class="nname" title="${esc(e.path)}">${esc(e.name)}</span>`;
  node.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!e.is_dir) {
      // v0.3.21：树列全部文件——不可编辑扩展名点击=在文件夹中显示（与全盘结果三分流一致）
      if (editable) loadFile(e.path);
      else invoke("reveal_path", { path: e.path }).catch(() => { /* 打开失败静默 */ });
      return;
    }
    if (node.classList.contains("open")) collapseNode(node);
    else void expandNode(node);
  });
  node.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openFtreeMenu(e.path, e.is_dir, ev.clientX, ev.clientY);
  });
  return node;
}
/** 收起目录节点 */
function collapseNode(node: HTMLElement): void {
  node.classList.remove("open");
  const kids = node.nextElementSibling as HTMLElement | null;
  if (kids && kids.classList.contains("kids")) kids.hidden = true;
}
/** 展开目录节点（懒加载子层；force=已加载也重读——新建/删除/改名后刷新用） */
async function expandNode(node: HTMLElement, force = false): Promise<void> {
  node.classList.add("open");
  let kids = node.nextElementSibling as HTMLElement | null;
  if (!kids || !kids.classList.contains("kids")) {
    kids = document.createElement("div");
    kids.className = "kids";
    node.after(kids);
  }
  kids.hidden = false;
  if (!kids.dataset.loaded || force) {
    kids.dataset.loaded = "1";
    await ftreeKids(kids, node.dataset.path!, parseInt(node.dataset.depth || "1", 10) + 1);
  }
}
async function ftreeKids(container: HTMLElement, dirPath: string, depth: number): Promise<void> {
  const tok = ftreeToken;
  let entries: TreeEntry[] = [];
  try {
    entries = await invoke<TreeEntry[]>("list_md_dir", { path: dirPath });
  } catch { /* 无权限/已删除：留空 */ }
  if (tok !== ftreeToken) return;
  container.innerHTML = "";
  if (entries.length === 0) {
    container.innerHTML = `<div class="empty">${esc(t("gsearchNone"))}</div>`;
    return;
  }
  for (const e of entries) container.appendChild(makeTreeNode(e, depth));
  applyTreeFilter();
  markTreeCurrent();
}
/** 大小写不敏感找树里的目录/文件节点 */
function findTreeNode(path: string): HTMLElement | null {
  const low = path.toLowerCase();
  let hit: HTMLElement | null = null;
  document.querySelectorAll("#ftree .node").forEach((n) => {
    if (!hit && (n as HTMLElement).dataset.path && (n as HTMLElement).dataset.path!.toLowerCase() === low) hit = n as HTMLElement;
  });
  return hit;
}
/** 文件名过滤（树重载后重放，不清过滤框——同大纲过滤行为） */
function applyTreeFilter(): void {
  const fi = document.getElementById("ftree-filter") as HTMLInputElement | null;
  if (!fi) return;
  const q = fi.value.trim().toLowerCase();
  document.querySelectorAll("#ftree .node").forEach((n) => {
    const txt = (n.textContent || "").toLowerCase();
    (n as HTMLElement).style.display = !q || txt.includes(q) ? "" : "none";
  });
}
/** 树顶常驻结构（只建一次；盘符节点=普通 dir 节点，可原位懒展开） */
function buildPcTree(): void {
  const box = document.getElementById("ftree");
  if (!box) return;
  ftreeToken++;
  ftreeRoot = null;
  const pathInp = document.getElementById("ftree-path") as HTMLInputElement | null;
  if (pathInp) pathInp.value = "";
  const head = document.createElement("div");
  head.className = "node dir open";
  head.innerHTML = `<span class="caret open"></span><span class="nname">${esc(t("drivesRoot"))}</span>`;
  const kids = document.createElement("div");
  kids.className = "kids";
  box.innerHTML = "";
  box.appendChild(head);
  box.appendChild(kids);
  const tok = ftreeToken;
  invoke<TreeEntry[]>("list_drives").then((drives) => {
    if (tok !== ftreeToken) return;
    for (const d of drives) {
      const node = makeTreeNode({ name: d.name, path: d.path, is_dir: true }, 1);
      kids.appendChild(node);
    }
    markTreeCurrent();
  }).catch(() => { /* 枚举失败留空 */ });
}
let locateSeq = 0; // 定位并发守卫：后发起的定位作废先前的展开链
/** 定位展开（导航入口：↑ 上级 / 地址栏回车 / 打开文件联动 / 刷新）：
 *  沿路径从盘符层逐层展开到目标目录，地址栏回填，目标目录高亮滚入视口。 */
async function locateTreeAt(dir: string): Promise<void> {
  const seq = ++locateSeq;
  ftreeRoot = dir;
  const pathInp = document.getElementById("ftree-path") as HTMLInputElement | null;
  if (pathInp) pathInp.value = dir;
  // 树未建（理论上 boot 已建，兜底）先建等盘符节点
  if (!document.querySelector("#ftree .node.dir[data-path]")) buildPcTree();
  for (let i = 0; i < 40; i++) {
    if (locateSeq !== seq) return;
    if (document.querySelector("#ftree .node.dir[data-path]")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const norm = dir.replace(/\//g, "\\").replace(/\\+$/, "");
  const segs = norm.split("\\");
  let cur = segs[0] + "\\"; // 盘符根
  let node = findTreeNode(cur);
  if (!node) return; // 盘符不存在（已拔出等）
  await expandNode(node);
  for (let i = 1; i < segs.length; i++) {
    if (locateSeq !== seq) return;
    cur += segs[i];
    const next = findTreeNode(cur);
    if (!next) break; // 中途某层缺失（无权限/已删）：停在能到达的层
    await expandNode(next);
    node = next;
    cur += "\\";
  }
  if (locateSeq !== seq) return;
  document.querySelectorAll("#ftree .node.cur-dir").forEach((n) => n.classList.remove("cur-dir"));
  node.classList.add("cur-dir");
  node.scrollIntoView({ block: "nearest" });
}
/** 目录内容重载（新建/删除/改名后）：节点在=强制重读其 kids；不在=定位展开（顺带展开父链） */
async function reloadDir(dir: string): Promise<void> {
  const node = findTreeNode(dir);
  if (node && node.classList.contains("dir")) await expandNode(node, true);
  else await locateTreeAt(dir);
}
function refreshFileTree(): void {
  const dir = docDirOf(activeDoc()?.path || null);
  buildPcTree(); // 常驻树重建（丢弃旧展开态，盘符层起步）
  if (dir) void locateTreeAt(dir); // 有文档=定位到其目录
}
// 当前文件高亮：切换标签只挪高亮 class，不重载树（保住展开态）
function markTreeCurrent(): void {
  const cur = activeDoc()?.path || "";
  document.querySelectorAll("#ftree .node.file").forEach((n) => {
    n.classList.toggle("cur", (n as HTMLElement).dataset.path === cur);
  });
}

// ===== v0.3.18 Everything 全盘文件名搜索（es.exe IPC，与树过滤共用过滤框） =====
type EsHit = { path: string; is_dir: boolean };
let esToken = 0;
let esDebounce = 0;
/** 过滤框输入防抖 300ms 后发起全盘搜索（连续输入只发最后一次） */
function scheduleEsSearch(): void {
  const inp = document.getElementById("ftree-filter") as HTMLInputElement | null;
  const ul = document.getElementById("es-results");
  if (!inp || !ul) return;
  window.clearTimeout(esDebounce);
  const q = inp.value.trim();
  if (!q) { ul.hidden = true; ul.innerHTML = ""; return; }
  esDebounce = window.setTimeout(() => void runEsSearch(q), 300);
}
async function runEsSearch(q: string): Promise<void> {
  const ul = document.getElementById("es-results");
  if (!ul) return;
  const tok = ++esToken;
  ul.hidden = false;
  ul.innerHTML = `<li class="empty">${esc(t("esSearching"))}</li>`;
  let hits: EsHit[];
  try {
    hits = await invoke<EsHit[]>("es_search", { query: q, limit: 50 });
  } catch (e) {
    if (tok !== esToken) return;
    const msg = String(e);
    // v0.3.22 自建索引：未就绪时 Rust 返回 INDEX_BUILDING:<已扫描数>（首次建索引 1-3 分钟）
    const m = msg.match(/^INDEX_BUILDING:(\d+)$/);
    ul.innerHTML = `<li class="empty">${esc(
      m ? t("esIndexing").replace("{n}", Number(m[1]).toLocaleString())
        : t("esFail"))}</li>`;
    return;
  }
  if (tok !== esToken) return; // 已发起更新的搜索，本次结果作废
  if (hits.length === 0) {
    ul.innerHTML = `<li class="empty">${esc(t("esNone"))}</li>`;
    return;
  }
  ul.innerHTML = "";
  for (const h of hits) {
    const li = document.createElement("li");
    li.dataset.path = h.path;
    li.title = h.path;
    const i = Math.max(h.path.lastIndexOf("\\"), h.path.lastIndexOf("/"));
    const name = i >= 0 ? h.path.slice(i + 1) : h.path;
    const parent = i > 0 ? h.path.slice(0, i) : "";
    li.innerHTML = `<span class="ef">${h.is_dir ? "📁 " : ""}${esc(name)}</span><span class="es-split" title="${esc(t("esSplitTip"))}"></span><span class="ep">${esc(parent)}</span>`;
    li.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest(".es-split")) return; void esHitOpen(h); });
    li.addEventListener("dblclick", (e) => { if ((e.target as HTMLElement).closest(".es-split")) return; void esLocateTree(h); });
    ul.appendChild(li);
  }
}
/** 全盘命中双击=树定位展开（v0.3.21 用户诉求）：文件=沿路径展开到所在目录并高亮该文件节点；文件夹=定位并展开其内容 */
async function esLocateTree(h: EsHit): Promise<void> {
  switchSidePane("files"); // 定位动作必须落在文件页才看得见
  if (h.is_dir) {
    await locateTreeAt(h.path);
    const n = findTreeNode(h.path);
    if (n && n.classList.contains("dir")) await expandNode(n);
  } else {
    const dir = docDirOf(h.path);
    if (dir) await locateTreeAt(dir);
    const n = findTreeNode(h.path);
    if (n) {
      n.scrollIntoView({ block: "nearest" });
      n.classList.add("cur"); // 手动高亮目标文件（markTreeCurrent 只认活动文档）
      window.setTimeout(() => n.classList.remove("cur"), 4000); // 临时高亮 4s 后淡出
    }
  }
}
/** 列宽拖动（v0.3.20）：拖任一行分隔条=全列表文件名列同步变宽/窄（列宽存 ul 变量），持久化+双击复位 */
function setupEsSplitter(): void {
  const ul = document.getElementById("es-results");
  if (!ul || (ul as any).__splitterReady) return;
  (ul as any).__splitterReady = true;
  const saved = localStorage.getItem("mdes-name-w");
  if (saved) ul.style.setProperty("--es-name-w", saved);
  let dragging = false;
  ul.addEventListener("mousedown", (e) => {
    const sp = (e.target as HTMLElement).closest(".es-split");
    if (!sp) return;
    e.preventDefault();
    dragging = true;
    const x0 = e.clientX;
    const w0 = (ul.querySelector(".ef") as HTMLElement | null)?.offsetWidth ?? Math.round(ul.clientWidth * 0.45);
    const maxW = ul.clientWidth - 60; // 路径列至少留 60px（盘符级尾巴）；要更宽可先拖宽侧栏（side-gutter）
    const mv = (ev: MouseEvent) => {
      const w = Math.min(Math.max(w0 + ev.clientX - x0, 60), Math.max(maxW, 60));
      ul.style.setProperty("--es-name-w", `${w}px`);
    };
    const up = () => {
      dragging = false;
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      localStorage.setItem("mdes-name-w", ul.style.getPropertyValue("--es-name-w"));
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  });
  // 双击分隔条=复位默认 45%
  ul.addEventListener("dblclick", (e) => {
    if (!(e.target as HTMLElement).closest(".es-split")) return;
    ul.style.removeProperty("--es-name-w");
    localStorage.removeItem("mdes-name-w");
  });
  // 拖动后抑制行 click（防止拖完误开文件）
  ul.addEventListener("click", (e) => {
    if (dragging) { e.stopImmediatePropagation(); dragging = false; }
  }, true);
}
/** 全盘命中点击分流：文本类=打开编辑；目录=树定位；其它=资源管理器显示 */
async function esHitOpen(h: EsHit): Promise<void> {
  if (h.is_dir) {
    switchSidePane("files");
    void locateTreeAt(h.path);
    return;
  }
  if (/\.(md|markdown|mdown|txt)$/i.test(h.path)) {
    loadFile(h.path);
    return;
  }
  invoke("reveal_path", { path: h.path }).catch(() => { /* 资源管理器失败静默 */ });
}

// ===== v0.3.17 文件树右键操作：新建 MD/TXT/文件夹、重命名、删除、资源管理器、复制路径 =====
let ftreeMenuPath: string | null = null; // 右键目标；null=树空白区（新建基准=当前定位目录 ftreeRoot）
let ftreeMenuIsDir = false;
function hideFtreeMenu(): void {
  const m = document.getElementById("ftree-menu");
  if (m) m.hidden = true;
  ftreeMenuPath = null;
}
function openFtreeMenu(path: string | null, isDir: boolean, x: number, y: number): void {
  const menu = document.getElementById("ftree-menu")!;
  ftreeMenuPath = path;
  ftreeMenuIsDir = isDir;
  const show = (act: string, on: boolean) => {
    const b = menu.querySelector<HTMLButtonElement>(`[data-act="${act}"]`);
    if (b) b.hidden = !on;
  };
  const isDriveRoot = !!path && /^[A-Za-z]:\\?$/.test(path);
  show("open", !!path && !isDir); // 仅文件
  show("new-md", !path || isDir); // 目录/空白：在其内新建（盘符根=在盘根新建，合法）
  show("new-txt", !path || isDir);
  show("new-dir", !path || isDir);
  show("rename", !!path && !isDriveRoot); // 盘符根不可改名/删除
  show("delete", !!path && !isDriveRoot);
  show("reveal", !!path);
  show("copy-path", !!path);
  menu.hidden = false;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - mw - 4) + "px";
  menu.style.top = Math.min(y, window.innerHeight - mh - 4) + "px";
}
/** #ftree-modal 两用：输入名（input=true，Enter 确定/Esc 取消）或确认（input=false）。resolve null=取消 */
function ftreeAsk(opts: { title: string; msg?: string; input?: boolean; initial?: string; okText?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const mask = document.getElementById("ftree-modal")!;
    const input = document.getElementById("ftree-modal-input") as HTMLInputElement;
    const msg = document.getElementById("ftree-modal-msg")!;
    const okBtn = document.getElementById("ftree-modal-ok") as HTMLButtonElement;
    const cancelBtn = document.getElementById("ftree-modal-cancel") as HTMLButtonElement;
    document.getElementById("ftree-modal-title")!.textContent = opts.title;
    okBtn.textContent = opts.okText || t("fmOk");
    msg.hidden = !opts.msg;
    if (opts.msg) msg.textContent = opts.msg;
    input.hidden = !opts.input;
    if (opts.input) {
      input.value = opts.initial || "";
      input.placeholder = t("fmNamePh");
    }
    mask.hidden = false;
    if (opts.input) { input.focus(); input.select(); }
    const done = (v: string | null) => {
      mask.hidden = true;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      input.onkeydown = null;
      resolve(v);
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(opts.input ? input.value.trim() : ""); }
      else if (e.key === "Escape") { e.preventDefault(); done(null); }
    };
    okBtn.onclick = () => done(opts.input ? input.value.trim() : "");
    cancelBtn.onclick = () => done(null);
  });
}
/** 强制关闭（不弹保存确认）：文件已被删除，内容无从保存 */
function forceCloseDoc(id: string): void {
  const idx = docs.findIndex((d) => d.id === id);
  if (idx < 0) return;
  docs.splice(idx, 1);
  if (activeId === id) {
    activeId = null;
    const next = docs[idx] || docs[idx - 1] || null;
    if (next) switchDoc(next.id);
    else showEmptyState();
  }
  renderTabs();
}
/** 关闭路径==目标 或位于目标目录之下 的全部文档（删除目录时级联） */
function forceCloseDocsUnder(path: string): void {
  const low = path.toLowerCase();
  const dead = docs.filter((d) => {
    if (!d.path) return false;
    const p = d.path.toLowerCase();
    return p === low || p.startsWith(low + "\\");
  });
  for (const d of dead) forceCloseDoc(d.id);
  markTreeCurrent();
}
/** 重命名联动打开中的文档：路径/名更新（目录改名=前缀替换，子文件跟随），dirty 保留（内容没变，存盘走新路径） */
function handleRenamed(oldPath: string, newPath: string): void {
  const low = oldPath.toLowerCase();
  for (const d of docs) {
    if (!d.path) continue;
    const p = d.path.toLowerCase();
    if (p === low) {
      d.path = newPath;
      d.name = newPath.split(/[\\/]/).pop()!;
    } else if (p.startsWith(low + "\\")) {
      d.path = newPath + d.path.slice(oldPath.length);
    }
  }
  // 定位目录本身或其祖先被改名：地址栏跟随
  const fr = (ftreeRoot || "").toLowerCase();
  if (fr === low) ftreeRoot = newPath;
  else if (fr.startsWith(low + "\\")) ftreeRoot = newPath + (ftreeRoot || "").slice(oldPath.length);
  const pathInp = document.getElementById("ftree-path") as HTMLInputElement | null;
  if (pathInp && ftreeRoot) pathInp.value = ftreeRoot;
  renderTabs();
  updateTitle();
  const dir = docDirOf(newPath);
  if (dir) void reloadDir(dir);
  markTreeCurrent();
}
function copyTextToClipboard(text: string): void {
  const done = () => showToast(t("fmCopyDone") + " " + text, "success");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text: string, done: () => void): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch { /* 静默 */ }
  ta.remove();
}
function initFtreeMenu(): void {
  const menu = document.getElementById("ftree-menu")!;
  // 树空白区右键：新建（基准=当前定位目录）
  const box = document.getElementById("ftree");
  if (box) box.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest(".node")) return; // 节点自身已处理
    e.preventDefault();
    openFtreeMenu(null, false, e.clientX, e.clientY);
  });
  menu.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-act]") as HTMLButtonElement | null;
    if (!btn || btn.hidden) return;
    const path = ftreeMenuPath; // 先取再 hide
    const isDir = ftreeMenuIsDir;
    hideFtreeMenu();
    const act = btn.dataset.act!;
    // 各动作的目录基准：目录右键=其内部；文件右键=所在目录；空白=定位目录
    const baseDir = path ? (isDir ? path : docDirOf(path)) : ftreeRoot;
    const parentDir = path ? docDirOf(path) : null;
    try {
      if (act === "open" && path) { loadFile(path); return; }
      if (act === "new-md" || act === "new-txt") {
        if (!baseDir) { showToast(t("fmNoBase"), "info"); return; }
        const kind = act === "new-txt" ? "txt" : "md";
        const title = kind === "txt" ? t("fmNewTxtTitle") : t("fmNewMdTitle");
        const name = await ftreeAsk({ title, input: true, initial: kind === "txt" ? "未命名.txt" : t("untitledMd") });
        if (!name) return;
        const full = await invoke<string>("create_text_file", { dir: baseDir, name, kind });
        await reloadDir(baseDir);
        loadFile(full); // 新建的文件直接打开编辑
        return;
      }
      if (act === "new-dir") {
        if (!baseDir) { showToast(t("fmNoBase"), "info"); return; }
        const name = await ftreeAsk({ title: t("fmNewDirTitle"), input: true, initial: t("untitledDir") });
        if (!name) return;
        await invoke<string>("create_dir", { dir: baseDir, name });
        await reloadDir(baseDir);
        return;
      }
      if (act === "rename" && path) {
        const cur = path.split(/[\\/]/).pop()!;
        const newName = await ftreeAsk({ title: t("fmRenameTitle"), input: true, initial: cur });
        if (!newName || newName === cur) return;
        const newPath = await invoke<string>("rename_entry", { old: path, newName });
        handleRenamed(path, newPath);
        return;
      }
      if (act === "delete" && path) {
        const okGo = await ftreeAsk({ title: t("fmDelTitle"), msg: isDir ? t("fmDelDirMsg") : t("fmDelFileMsg"), okText: t("fmDelete") });
        if (okGo === null) return; // null=取消；""=确认（无输入模式确定返回空串）
        await invoke("delete_entry", { path });
        forceCloseDocsUnder(path);
        if (parentDir) await reloadDir(parentDir);
        return;
      }
      if (act === "reveal" && path) { invoke("reveal_path", { path }); return; }
      if (act === "copy-path" && path) { copyTextToClipboard(path); return; }
    } catch (err) {
      showToast(String(err), "danger"); // Rust 侧 Err（重名/非法名/权限等）直接展示
    }
  });
  // 点菜单外任意处收起
  window.addEventListener("mousedown", (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) hideFtreeMenu();
  });
}

// ----- 跨文件搜索：Ctrl+Shift+F 聚焦输入，回车搜当前文档目录全部文本文件 -----
type SearchHit = { file: string; line_no: number; line_text: string };
let gsearchToken = 0;
function runGlobalSearch(): void {
  const inp = document.getElementById("gsearch-input") as HTMLInputElement | null;
  const ul = document.getElementById("gsearch-results");
  if (!inp || !ul) return;
  const q = inp.value.trim();
  // v0.3.17 按用户语义："同级文件"=当前打开文件所在目录优先；无文档回落树定位目录
  const dir = docDirOf(activeDoc()?.path || null) || ftreeRoot;
  ul.innerHTML = "";
  ul.hidden = !q; // 无关键词时整块收起（不占树上方空间）
  if (!q) return;
  if (!dir) { ul.hidden = false; ul.innerHTML = `<li class="empty">${esc(t("gsearchNoDoc"))}</li>`; return; }
  ul.hidden = false;
  ul.innerHTML = `<li class="empty">…</li>`;
  const tok = ++gsearchToken;
  invoke<SearchHit[]>("search_md_files", { root: dir, query: q }).then((hits) => {
    if (tok !== gsearchToken) return;
    ul.hidden = false;
    ul.innerHTML = "";
    if (hits.length === 0) {
      ul.innerHTML = `<li class="empty">${esc(t("gsearchNone"))}</li>`;
      return;
    }
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    for (const h of hits) {
      const li = document.createElement("li");
      const name = h.file.split(/[\\/]/).pop() || h.file;
      const marked = esc(h.line_text).replace(rx, (m) => `<mark>${m}</mark>`);
      li.innerHTML = `<span class="gf">${esc(name)}</span><span class="gl">${h.line_no}</span><span class="gt">${marked}</span>`;
      li.title = h.file + ":" + h.line_no;
      li.addEventListener("click", () => {
        // 打开目标文件后复用查找条定位首个匹配（高亮/跳转/替换链路全复用）
        const go = () => {
          openFind(false);
          const fi = document.getElementById("find-input") as HTMLInputElement;
          fi.value = q;
          refreshFind(true);
          gotoMatch(0);
          fi.focus();
          fi.select();
        };
        if (activeDoc()?.path === h.file) go();
        else loadFile(h.file).then(go);
      });
      ul.appendChild(li);
    }
  }).catch((e) => {
    if (tok !== gsearchToken) return;
    ul.innerHTML = `<li class="empty">${esc(String(e)).slice(0, 80)}</li>`;
  });
}

// ----- 快速打开（Ctrl+Shift+O）：最近文件模糊过滤，↑↓ 选择回车打开 -----
let qoSel = 0;
let qoFiltered: string[] = [];
function renderQoList(): void {
  const ul = document.getElementById("qo-list");
  if (!ul) return;
  ul.innerHTML = "";
  if (qoFiltered.length === 0) {
    ul.innerHTML = `<li class="empty">${esc(t("quickOpenEmpty"))}</li>`;
    return;
  }
  qoSel = Math.min(Math.max(qoSel, 0), qoFiltered.length - 1);
  qoFiltered.forEach((p, i) => {
    const li = document.createElement("li");
    if (i === qoSel) li.classList.add("sel");
    const name = p.split(/[\\/]/).pop() || p;
    li.innerHTML = `<span class="rn">${esc(name)}</span><span class="rp">${esc(p)}</span>`;
    li.title = p;
    li.addEventListener("click", () => { closeQuickOpen(); loadFile(p); });
    ul.appendChild(li);
  });
  ul.querySelector("li.sel")?.scrollIntoView({ block: "nearest" });
}
function openQuickOpen(): void {
  (document.getElementById("quickopen-modal") as HTMLElement).hidden = false;
  const inp = document.getElementById("qo-input") as HTMLInputElement;
  qoFiltered = recentList().filter((p) => p.toLowerCase().includes(inp.value.trim().toLowerCase()));
  qoSel = 0;
  renderQoList();
  inp.focus();
  inp.select();
}
function closeQuickOpen(): void {
  (document.getElementById("quickopen-modal") as HTMLElement).hidden = true;
}

// ===== v0.4.0 命令面板（Ctrl+K）：命令 + 最近文件 三段式 =====
// 设计原则：命令执行一律复用既有绑定（按钮 click / 既有函数），面板只做"发现与直达"，
// 不复制业务逻辑——导出走 #export-menu 已绑定按钮，与工具栏菜单永远同路径。
interface CmdkItem { kind: "cmd" | "file"; label: string; sub?: string; kbd?: string; run: () => void; }
let cmdkItems: CmdkItem[] = [];
let cmdkSel = 0;
function buildCmdkItems(): CmdkItem[] {
  const btn = (id: string) => document.getElementById(id) as HTMLElement | null;
  const click = (id: string) => () => { btn(id)?.click(); };
  const items: CmdkItem[] = [];
  // —— 文件 ——
  items.push({ kind: "cmd", label: t("cmdkOpen"), kbd: "Ctrl+Shift+O", run: click("btn-open") });
  items.push({ kind: "cmd", label: t("save"), kbd: "Ctrl+S", run: () => { const d = activeDoc(); if (d) void saveDoc(d); } });
  // —— 导出（复用已绑定 handler 的菜单按钮，含空文档确认等完整链路） ——
  const exp: Array<[string, string]> = [
    ["pdf", "exportPdf"], ["html", "exportHtmlStyled"], ["html-plain", "exportHtmlPlain"],
    ["image", "exportPng"], ["docx", "exportDocx"],
  ];
  for (const [k, key] of exp) {
    items.push({
      kind: "cmd", label: t(key),
      run: () => { (document.querySelector(`#export-menu button[data-export="${k}"]`) as HTMLElement | null)?.click(); },
    });
  }
  items.push({ kind: "cmd", label: t("printBtn"), kbd: "Ctrl+P", run: click("btn-print") });
  // —— 视图 ——
  items.push({ kind: "cmd", label: currentMode === "wysiwyg" ? t("switchToIR") : t("switchToWYSIWYG"), kbd: "Ctrl+Alt+M", run: click("btn-mode") });
  items.push({ kind: "cmd", label: sideCollapsed ? t("sbShowSide") : t("sbHideSide"), kbd: "Ctrl+Shift+B", run: () => setSideCollapsed(!sideCollapsed) });
  items.push({ kind: "cmd", label: t("focusMode"), kbd: "F8", run: () => setFocusMode(!focusModeOn) });
  items.push({ kind: "cmd", label: t("readingFocus"), kbd: "Ctrl+Shift+D", run: () => setReadingFocus(!readingFocusOn) });
  for (const nm of ["light", "dark", "eye", "paper"] as ThemeName[]) {
    items.push({ kind: "cmd", label: t(themeNameKey(nm)), run: () => applyTheme(nm) });
  }
  // —— 工具 ——
  items.push({ kind: "cmd", label: t("findBtn"), kbd: "Ctrl+F", run: click("btn-find") });
  items.push({ kind: "cmd", label: t("histBtn"), run: click("btn-history") });
  items.push({ kind: "cmd", label: t("diagBtn"), run: click("btn-diag") });
  return items;
}
function renderCmdkList(): void {
  const input = document.getElementById("cmdk-input") as HTMLInputElement;
  const list = document.getElementById("cmdk-list")!;
  const q = input.value.trim().toLowerCase();
  const cmds = buildCmdkItems().filter((c) => !q || c.label.toLowerCase().includes(q));
  const files = recentList()
    .filter((p) => !q || (p.split(/[\\/]/).pop() || "").toLowerCase().includes(q) || p.toLowerCase().includes(q))
    .slice(0, 5)
    .map<CmdkItem>((p) => ({
      kind: "file",
      label: p.split(/[\\/]/).pop() || p,
      sub: p.replace(/[\\/][^\\/]*$/, ""),
      run: () => { void loadFile(p); },
    }));
  cmdkItems = [...cmds, ...files];
  cmdkSel = Math.min(cmdkSel, Math.max(0, cmdkItems.length - 1));
  list.innerHTML = "";
  if (cmdkItems.length === 0) {
    list.innerHTML = `<div class="cmdk-empty">${esc(t("cmdkEmpty"))}</div>`;
    return;
  }
  let lastKind = "";
  cmdkItems.forEach((it, i) => {
    if (it.kind !== lastKind) {
      lastKind = it.kind;
      const g = document.createElement("div");
      g.className = "cmdk-group";
      g.textContent = it.kind === "file" ? t("cmdkGroupRecent") : t("cmdkGroupCmd");
      list.appendChild(g);
    }
    const el = document.createElement("div");
    el.className = "cmdk-item" + (i === cmdkSel ? " sel" : "");
    el.innerHTML = `<span class="l">${esc(it.label)}</span>`
      + (it.sub ? `<span class="p">${esc(it.sub)}</span>` : "")
      + (it.kbd ? `<span class="k">${esc(it.kbd)}</span>` : "");
    el.addEventListener("mouseenter", () => { if (cmdkSel !== i) { cmdkSel = i; refreshCmdkSel(); } });
    el.addEventListener("click", () => { execCmdk(i); });
    list.appendChild(el);
  });
}
function refreshCmdkSel(): void {
  document.querySelectorAll("#cmdk-list .cmdk-item").forEach((el, i) => el.classList.toggle("sel", i === cmdkSel));
  const cur = document.querySelectorAll("#cmdk-list .cmdk-item")[cmdkSel];
  (cur as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
}
function execCmdk(i: number): void {
  const it = cmdkItems[i];
  closeCmdk();
  if (it) it.run();
}
function openCmdk(): void {
  (document.getElementById("cmdk-modal") as HTMLElement).hidden = false;
  const input = document.getElementById("cmdk-input") as HTMLInputElement;
  input.value = "";
  cmdkSel = 0;
  renderCmdkList();
  input.focus();
}
function closeCmdk(): void {
  (document.getElementById("cmdk-modal") as HTMLElement).hidden = true;
}
function toggleCmdk(): void {
  const m = document.getElementById("cmdk-modal");
  if (!m) return;
  if (m.hidden) openCmdk(); else closeCmdk();
}
function initCmdk(): void {
  const input = document.getElementById("cmdk-input") as HTMLInputElement;
  input.addEventListener("input", () => { cmdkSel = 0; renderCmdkList(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (cmdkItems.length === 0) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      cmdkSel = (cmdkSel + d + cmdkItems.length) % cmdkItems.length;
      refreshCmdkSel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      execCmdk(cmdkSel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeCmdk();
    }
  });
  // 点遮罩关闭（点面板自身不关）
  document.getElementById("cmdk-modal")?.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).id === "cmdk-modal") closeCmdk();
  });
}

// ---- v0.4.0 阅读专注（Ctrl+Shift+D / 命令面板）：收侧栏 + 工具栏/标签栏降存在感（保持占位）。 ----
// 与 F8 打字专注（段落淡化）分层：一个管"写作沉浸"，一个管"阅读沉浸"。状态栏保留（位置感知不撤）。
let readingFocusOn = false;
function setReadingFocus(on: boolean): void {
  readingFocusOn = on;
  document.body.classList.toggle("reading-focus", on);
  const f = document.getElementById("sb-focus");
  if (f) f.textContent = t("readingFocus");
  if (on) setSideCollapsed(true, true); // 收导航（持久化：专注态收起是用户意图，重启保持）
}

// ----- 主题三态（v0.3.15：浅色/深色/护眼豆沙绿）。外壳走 CSS 变量（html[data-theme]），
// Vditor 编辑区内容主题走 content-theme/<name>.css（light/dark/eye，eye 为自建）。
// ⚠ setTheme 真实签名=(theme, contentTheme, codeTheme, contentThemePath)：v0.3.14 曾把
// cdn 误传到第二参——界面主题切了但内容主题仍 light（暗色下表格发白的根因）。
type ThemeName = "light" | "dark" | "eye" | "paper"; // v0.4.0 墨黑(oled)并入深色
let themeName: ThemeName = "light";
function applyTheme(name: ThemeName, persist = true): void {
  themeName = name;
  document.documentElement.dataset.theme = name;
  // v0.4.0 主题入口移到状态栏（工具栏减负）：按钮文案 + 弹出菜单勾选态
  const sbt = document.getElementById("sb-theme");
  if (sbt) { sbt.textContent = t(themeNameKey(name)); sbt.title = t("themeTip"); }
  document.querySelectorAll("#theme-menu button").forEach((b) => {
    b.classList.toggle("cur", (b as HTMLElement).dataset.theme === name);
  });
  if (vditor) {
    const vd = name === "dark" ? "dark" : "classic"; // Vditor 侧只分深浅两档
    // contentTheme 必须映射到真实存在的 css（目录仅 light/dark/eye）：paper→light
    const ct = name === "paper" ? "light" : name;
    try { vditor.setTheme(vd, ct, undefined, "/vditor-assets/dist/css/content-theme"); } catch { /* 未就绪：重建时随 options 生效 */ }
  }
  if (persist) saveUiStateKey("theme", name);
}
/** content-theme 实名（boot options 与 applyTheme 共用）：paper→light，其余原样 */
function contentThemeOf(name: ThemeName): string {
  return name === "paper" ? "light" : name;
}
function initTheme(): void {
  // 未选过（磁盘无合法 theme 值）→ 跟随系统，且不写盘（选过才固定）
  const v = uiStateAll.theme;
  // v0.4.0 oled 并入 dark：旧 ui-state 存 oled 的映射到 dark，不丢深色体验
  const v0 = v === "oled" ? "dark" : v;
  const saved = (typeof v0 === "string" && ["light", "dark", "eye", "paper"].includes(v0)) ? (v0 as ThemeName) : null;
  const name: ThemeName = saved ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(name, saved !== null);
}
/** 主题名 → i18n 键（状态栏按钮 + 弹出菜单共用） */
function themeNameKey(name: ThemeName): string {
  return name === "light" ? "themeLight" : name === "dark" ? "themeDark"
    : name === "eye" ? "themeEye" : "themePaper";
}

// ---- v0.4.0 侧栏折叠（阅读专注的前提之一；瞬时切换——拖宽交互要求 width 即时跟手）----
let sideCollapsed = false;
function setSideCollapsed(on: boolean, persist = true): void {
  sideCollapsed = on;
  document.getElementById("outline-panel")?.classList.toggle("collapsed", on);
  const btn = document.getElementById("sb-side");
  if (btn) {
    btn.textContent = t("sbSide");
    btn.title = on ? t("sbShowSide") : t("sbHideSide");
    btn.classList.toggle("folded", on); // 折叠态降一档灰，提示"已收起"
  }
  if (persist) saveUiStateKey("sideCollapsed", on);
}

// ----- 大纲过滤：输入即时隐藏不匹配项；rebuildOutline 重建后需重放（否则过滤态丢失） -----
function applyOutlineFilter(): void {
  const of = document.getElementById("outline-filter") as HTMLInputElement | null;
  if (!of) return;
  const q = of.value.trim().toLowerCase();
  document.querySelectorAll("#outline .outline-item").forEach((li) => {
    const txt = (li.textContent || "").toLowerCase();
    (li as HTMLElement).style.display = !q || txt.includes(q) ? "" : "none";
  });
}

// ----- 侧栏页签切换（大纲 | 文件） -----
function switchSidePane(which: "outline" | "files"): void {
  const isOutline = which === "outline";
  document.getElementById("side-tab-outline")!.classList.toggle("active", isOutline);
  document.getElementById("side-tab-files")!.classList.toggle("active", !isOutline);
  (document.getElementById("side-pane-outline") as HTMLElement).hidden = !isOutline;
  (document.getElementById("side-pane-files") as HTMLElement).hidden = isOutline;
  // 首次进文件页才建树（省启动开销）；drives 态 ftreeRoot=null，以树内无节点判"未建"
  if (!isOutline && !ftreeRoot && !document.querySelector("#ftree .node")) refreshFileTree();
}

function initSidePanels(): void {
  document.getElementById("side-tab-outline")!.addEventListener("click", () => switchSidePane("outline"));
  document.getElementById("side-tab-files")!.addEventListener("click", () => switchSidePane("files"));
  // 文件树导航：地址栏回车跳转 / ⟳ 刷新（v0.3.18 ↑ 上级已删——树常驻盘符，导航走树/地址栏）
  const pathInp = document.getElementById("ftree-path") as HTMLInputElement;
  pathInp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = pathInp.value.trim();
    if (!v) return;
    invoke<TreeEntry[]>("list_md_dir", { path: v }).then(() => void locateTreeAt(v)).catch(() => {
      pathInp.value = ftreeRoot || "";
      showToast(t("treeBadPath") + v, "danger");
    });
  });
  document.getElementById("ftree-refresh")!.addEventListener("click", () => { refreshFileTree(); });
  // 文件名过滤 = 树内过滤 + Everything 全盘搜索双轨 + 最近文件清空（用户诉求：最近要能手动清理）
  (document.getElementById("ftree-filter") as HTMLInputElement).addEventListener("input", () => {
    applyTreeFilter();
    scheduleEsSearch();
  });
  setupEsSplitter(); // 全盘结果文件名列宽拖动（v0.3.20）
  document.getElementById("recent-clear")!.addEventListener("click", () => {
    saveUiStateKey("recent", []);
    renderRecent();
  });
  refreshFileTree();
  (document.getElementById("outline-filter") as HTMLInputElement).addEventListener("input", applyOutlineFilter);
  // 跨文件搜索：回车执行（跨文件 invoke 有 IO 成本，不逐键搜）
  (document.getElementById("gsearch-input") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runGlobalSearch(); }
  });
  // 快速打开 modal
  const qoMask = document.getElementById("quickopen-modal")!;
  const qoInp = document.getElementById("qo-input") as HTMLInputElement;
  qoMask.addEventListener("mousedown", (e) => { if (e.target === qoMask) closeQuickOpen(); });
  qoInp.addEventListener("input", () => {
    qoFiltered = recentList().filter((p) => p.toLowerCase().includes(qoInp.value.trim().toLowerCase()));
    qoSel = 0;
    renderQoList();
  });
  qoInp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); qoSel++; renderQoList(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); qoSel--; renderQoList(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const p = qoFiltered[qoSel];
      if (p) { closeQuickOpen(); loadFile(p); }
    } else if (e.key === "Escape") { e.preventDefault(); closeQuickOpen(); }
  });
  // 主题下拉（三态选择）
  // v0.4.0 主题菜单（状态栏 sb-theme 弹出，替代工具栏 theme-select 下拉）
  const themeMenu = document.getElementById("theme-menu")!;
  themeMenu.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      applyTheme((b as HTMLElement).dataset.theme as ThemeName);
      themeMenu.hidden = true;
    });
  });
  document.getElementById("sb-theme")!.addEventListener("click", (e) => {
    e.stopPropagation();
    if (themeMenu.hidden) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      themeMenu.style.right = Math.max(8, window.innerWidth - r.right) + "px";
    }
    themeMenu.hidden = !themeMenu.hidden;
  });
  document.addEventListener("pointerdown", (e) => {
    if (!themeMenu.hidden && !(e.target as Element | null)?.closest?.("#theme-menu, #sb-theme")) {
      themeMenu.hidden = true;
    }
  });
  // v0.4.0 侧栏折叠：Ctrl+Shift+B / 状态栏按钮（捕获层抢在 Vditor 元素层之前）
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
    if (e.key.toLowerCase() === "b") { e.preventDefault(); e.stopPropagation(); setSideCollapsed(!sideCollapsed); }
  }, true);
  document.getElementById("sb-side")!.addEventListener("click", () => setSideCollapsed(!sideCollapsed));
  // 全局快捷键：Ctrl+Shift+O 快开 / Ctrl+Shift+F 跨文件搜索（Ctrl+F 单文件查找不受影响）。
  // ⚠ 必须 capture：焦点在编辑区时 Vditor 的 keydown 在元素层 stopPropagation，
  // 冒泡阶段的 window 监听收不到——真机"按了没反应"（e2e 焦点不在编辑区测不出）的根因
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === "o") { e.preventDefault(); e.stopPropagation(); openQuickOpen(); }
    else if (k === "f") {
      e.preventDefault(); e.stopPropagation();
      closeFind();
      switchSidePane("files");
      (document.getElementById("gsearch-input") as HTMLInputElement).focus();
    }
  }, true);
}

function updateTitle() {
  // v0.3.16 按用户要求撤掉工具栏文件名显示（标签页已承载）；编码徽标保留
  document.getElementById("encoding-badge")!.textContent = activeDoc()?.encoding ? ` ${activeDoc()!.encoding}` : "";
}

async function loadFile(path: string) {
  try {
    const [content, enc] = await invoke<[string, string]>("open_file", { path });
    // v0.3.26 大文档 × ir 模式拦截：bench 实证 ir 大文档编辑 60s 不收敛（2026-09-07 三模式基准），
    // 先切 wysiwyg 再开。复用 pendingFile 既有时序：switchMode 重建完成（after 恢复旧文档后）
    // 才 openDoc 新文档，避免双 setValue 乱序。
    if (content.length > LARGE_DOC_CHARS && currentMode === "ir") {
      pendingLargeOpen = { path, content, enc: enc || "" };
      switchMode("wysiwyg");
      return;
    }
    openDoc(path, content, undefined, enc);
  } catch (e) {
    showToast(t("openFail") + e, "danger");
  }
}
let pendingLargeOpen: { path: string; content: string; enc: string } | null = null;

// 打开 PDF：智能分流。不走 open_file（白名单只读文本类，PDF 会被拒）。
// find_pdf_source 查同名 .md/.html 源：有源 → 打开源编辑（改完可重导出覆盖 PDF）；
// 无源 → open_pdf_external 调 PDF4QT，探测不到（PDF4QT_NOT_FOUND）回落系统默认 PDF 程序。
async function handleOpenPdf(pdfPath: string) {
  let src: string | null = null;
  try {
    src = await invoke<string | null>("find_pdf_source", { pdfPath });
  } catch (e) {
    showToast(t("openFail") + e, "danger");
    return;
  }
  if (src) {
    const srcName = src.split(/[\\/]/).pop()!;
    const msg = currentLang === "en"
      ? `Found source "${srcName}". Open it to edit? (Re-export to overwrite this PDF after changes.)`
      : `发现同名源文件「${srcName}」，是否打开源文件编辑？（改完可重新导出覆盖此 PDF）`;
    const ok = await confirm(msg, {
      title: currentLang === "en" ? "Open Source" : "打开源文件",
      kind: "info",
    }).catch(() => false);
    if (ok) loadFile(src);
    return;
  }
  // 无源：调 PDF4QT 编辑
  const msg2 = currentLang === "en"
    ? "No source file found. Open this PDF in PDF4QT to edit?"
    : "未找到同名源文件，是否用 PDF4QT 打开编辑？";
  const ok2 = await confirm(msg2, {
    title: currentLang === "en" ? "Open in PDF4QT" : "用 PDF4QT 编辑",
    kind: "info",
  }).catch(() => false);
  if (!ok2) return;
  try {
    await invoke("open_pdf_external", { path: pdfPath });
  } catch (e) {
    if (String(e).includes("PDF4QT_NOT_FOUND")) {
      // 回落：系统默认 PDF 程序（用户把 .pdf 默认程序设为 PDF4QT 即等同）
      try {
        await openPath(pdfPath);
      } catch (e2) {
        showToast(t("openFail") + e2, "danger");
      }
    } else {
      showToast(t("openFail") + e, "danger");
    }
  }
}

let pendingFile: string | null = null;

// 表格浮条"整行上移/下移"的光标兜底：最近一次点击的单元格。document 级 capture 挂一次
// （编辑区 pre.vditor-reset 会被 Vditor 销毁重建，挂元素上会随重建丢失）。
let lastTblCell: HTMLTableCellElement | null = null;
document.addEventListener("mousedown", (e) => {
  const c = (e.target as Element | null)?.closest?.(".vditor-reset td, .vditor-reset th");
  if (c) lastTblCell = c as HTMLTableCellElement;
}, true);

// 构造 Vditor options：toolbar/input/after 统一在此，mode 由参数决定（销毁重建切换模式时复用）
type VditorOptions = NonNullable<ConstructorParameters<typeof Vditor>[1]>;
function vditorOptions(mode: "ir" | "wysiwyg"): VditorOptions {
  return {
    mode,
    lang: VDITOR_LANG[currentLang],
    i18n: VDITOR_I18N[currentLang], // 注入本地 i18n（当前语言），工具栏 tooltip 自动走 i18n
    cdn: "/vditor-assets", // lute(markdown 引擎)/icons/method 等本地加载，符合 CSP，不依赖 unpkg
    // v0.3.14+ 主题：重建（模式/语言切换）时随当前主题；运行中切换走 vditor.setTheme
    theme: themeName === "dark" ? ("dark" as const) : ("classic" as const),
    height: "100%",
    cache: { enable: false },
    // 字数统计（type text = 按渲染后文本统计，符合中文字数直觉；after 补三语单位）。
    // v0.3.15 按用户反馈撤掉中英分统+阅读时长（"复杂了，用户得想字和词的区别"）恢复单一总数
    counter: {
      enable: true, type: "text",
      after: (len: number) => {
        // v0.3.26 状态栏并入 counter 位：已选 N · 共 N 字 · 大小（selectionchange 走 updateStatus 重拼）
        counterLen = len;
        updateStatus();
      },
    },
    // :emoji: 补全的表情图片走本地资源（默认 unpkg CDN，CSP 禁外联且离线不可用）
    hint: { emojiPath: "/vditor-assets/dist/images/emoji" },
    // 大纲用自建左侧面板，Vditor 内置 outline 不启用；position 必须给 "right"——
    // Vditor 工具栏 padding-left 计算式只看 position=="left" 就加上 outline 宽(188px)，
    // enable=false 也照加，表现为格式工具条左侧一大段空白（用户报"顶格才好看"的根因）
    outline: { enable: false, position: "right" },
    // Vditor 3.11.2 的 popover 高亮链会无守卫调用 options.customWysiwygToolbar(...)：
    // 光标进入表格/引用/列表/脚注时必触发，未配置即抛 TypeError（PAGEERROR 杂音来源）。
    // v0.3.10 给空实现消噪；v0.3.12 扩展为表格浮条补齐：原生已有对齐（居左/中/右）+插入/删
    // 除行列，但没有"整行上移/下移"（原生上/下按钮移动的是整个表格块，实测前段与表格换位），
    // 在此补两键（tbody 内 tr 换位，行序即内容，经 Lute 序列化进源码）。
    // 防重只能查按钮本身：Vditor 保存后会清空重建 popover 子内容（按钮丢失），但复用
    // panel 元素——dataset 标记会残留导致重注入被跳过（e2e T3 实测踩坑）。
    customWysiwygToolbar: (type: string, popover?: HTMLElement) => {
      if (type !== "table" || !popover || popover.querySelector(".mded-tbl-btn")) return;
      // 光标兜底链：选区 anchorNode → 最近一次真实点击过的单元格（点按钮的 mousedown
      // preventDefault 保选区，但 caret 形态/重渲染都可能让 anchorNode 失效，缓存最稳）
      const lastCell = (): HTMLTableCellElement | null => lastTblCell;
      const curCell = (): HTMLTableCellElement | null => {
        const n = document.getSelection()?.anchorNode;
        const el = n && (n.nodeType === 1 ? (n as Element) : n.parentElement);
        return (el?.closest(".vditor-reset td, .vditor-reset th") as HTMLTableCellElement)
          || lastCell();
      };
      const syncDoc = (): void => { // 与 input 回调同构：直接 DOM 操作也要更新内容缓存+脏标
        const doc = activeDoc();
        if (doc && vditor) {
          const v = mdValue();
          if (v !== "" || doc.content === "") {
            // v0.3.21 自建撤销栈补记：DOM 直接操作（整行上/下移等）不触发 input 事件，
            // 不记步则不可撤销（B19 重做链实锤）。离散按钮操作一步一记（无 900ms 合并）。
            if (doc.content !== "" && v !== doc.content) {
              doc.undoStack.push(doc.content);
              if (doc.undoStack.length > 100) doc.undoStack.shift();
              doc.redoStack.length = 0;
            }
            doc.content = v;
          }
          doc.dirty = true;
        }
        updateTitle(); renderTabs(); scheduleOutline(); syncUndoBtns();
      };
      const moveRow = (dir: -1 | 1): void => {
        const cell = curCell();
        const tr = cell?.closest("tr");
        const body = tr?.parentElement;
        if (!cell || !tr || !body || body.tagName !== "TBODY") return; // 表头行不参与移动
        const sib = dir < 0 ? tr.previousElementSibling : tr.nextElementSibling;
        if (!sib) return;
        body.insertBefore(tr, dir < 0 ? sib : sib.nextElementSibling);
        const back = tr.cells[Math.min(cell.cellIndex, tr.cells.length - 1)];
        if (back) {
          const range = document.createRange();
          range.selectNodeContents(back);
          const sel = document.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        syncDoc();
      };
      const sep = document.createElement("span");
      sep.style.cssText = "width:1px;height:16px;background:currentColor;opacity:.25;margin:0 3px;align-self:center";
      popover.appendChild(sep);
      ([["up", "tblRowUp", () => moveRow(-1)],
        ["down", "tblRowDown", () => moveRow(1)]] as [string, string, () => void][]).forEach(([icon, key, fn]) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "vditor-icon vditor-tooltipped vditor-tooltipped__n mded-tbl-btn";
        btn.setAttribute("aria-label", t(key));
        btn.innerHTML = `<svg><use xlink:href="#vditor-icon-${icon}"></use></svg>`;
        btn.addEventListener("mousedown", (e) => e.preventDefault()); // 防点击夺走选区（curCell 依赖）
        btn.addEventListener("click", fn);
        popover.appendChild(btn);
      });
    },
    preview: {
      // 内容主题随主题切换（light/dark/eye 三态；eye=自建护眼豆沙绿）
      theme: { current: contentThemeOf(themeName), path: "/vditor-assets/dist/css/content-theme" },
      hljs: { lineNumber: true, style: "github" },
      // 数学公式 KaTeX（引擎资源已本地化；inlineDigit 允许行内 $ 后跟数字，兼容中文排版场景）
      math: { engine: "KaTeX", inlineDigit: true },
      // 中英文之间自动加空格（仅渲染层，不写回源码）
      markdown: { autoSpace: true },
      // 本地相对路径图片在编辑器内预览：源码保持相对路径（可移植），渲染时换算为
      // asset:// URL（webview 无法按 app origin 解析相对文件路径，会裂图）
      transform: (html: string): string => resolvePreviewImages(html),
    },
    // 粘贴/拖入图片自动落地（Typora 式）：已保存文档 → 同目录 assets/截图_时间戳.png +
    // 相对路径引用；未命名文档 → %APPDATA% pasted/ 绝对路径引用。返回 null 阻止默认上传 UI。
    upload: {
      handler: (files: File[]): Promise<null> => handlePasteImages(files),
    },
    toolbar: [
      "headings", "bold", "italic", "strike", "|",
      "line", "quote", "list", "ordered-list", "check", "outdent", "indent", "|",
      "code", "inline-code", "link", "table", "|",
      "undo", "redo", "|", // v0.3.21 按钮可见（点击走自建栈）：Vditor 见 toolbar.elements.undo 存在才自禁键盘 ⌘Z 分支，
      // 让 Ctrl+Z 传到自建栈 handler；删配置=Vditor 抢占（真实键盘/CDP 均拦截，AHK+ztrace 实证）
      "edit-mode", "fullscreen",
    ],
    input: () => {
      if (suppressInput) return;
      if (switchApplyPending) return; // v0.3.25 大文档切换装载期：旧 DOM 的信号丢弃（防串文档）
      const doc = activeDoc();
      if (doc && (doc.lazy || doc.loading)) return; // v0.3.26 惰性装载窗口：vditor 里还是旧文档，丢弃（防串）
      if (doc && vditor) {
        if (doc.large) { // v0.3.25 大文档：延迟取值通道（原生 input 捕获层已置 dirty 并调度）
          scheduleValueSync(doc);
        } else {
          const v = mdValue();
          if (v !== "" || doc.content === "") doc.content = v; // 守卫：空值不覆盖
          doc.dirty = true;
          doc.large = v.length > LARGE_DOC_CHARS; // 小文档长过阈值（如整段粘贴）后切到延迟通道
          snapOnInput(doc, v); // v0.3.21 自建撤销栈：按输入停顿分步记快照
        }
      }
      updateTitle();
      renderTabs();
      scheduleOutline();
    },
    after: () => {
      fixToolbarTooltipDirection();
      setupUndoToolbar(); // v0.3.21 撤销/重做按钮劫持（模式/语言切换重建 toolbar 后重绑）
      // v0.3.21 根修「撤销亮但点了没反应/重做恒灰」：Vditor 内置 Undo.resetIcon 按**它自己的栈**
      // enable/disable 按钮——它的 redo 栈恒空（undo 分支已禁用）→ 每次编辑后 disable redo、
      // 打开文档后 enable undo，与自建栈按钮态打时序竞赛，抢设即症状（dist 14274 实锤）。
      // 猴补实例方法为 no-op；构造期它设的初始灰态（栈空语义）恰好保留。
      const vu = (vditor as unknown as { undo?: { resetIcon?: (v: unknown) => void } }).undo;
      if (vu?.resetIcon) vu.resetIcon = () => {};
      // v0.3.21 启动焦点进编辑区（仅首次挂载）：默认大纲页时代启动后焦点停在 body，
      // "打开即打字"落空（CDP 诊断 activeElement=BODY 实锤；boot 末尾延时 focus 会因 pre
      // 未渲染落空，after 才是挂载完成保证）。模式/语言切换重建也进 after，flag 防重抢焦点。
      if (!bootFocused) {
        bootFocused = true;
        window.setTimeout(() => {
          const ed = document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset") as HTMLElement | null;
          if (ed && (document.activeElement === document.body || document.activeElement === null)) ed.focus();
        }, 0);
      }
      // v0.3.11 拼写检查：Vditor 显式给 pre.vditor-reset 设 spellcheck="false"（dist 源码 3 处），
      // 编辑区元素固定不重建，after 统一改回 true 即可持续生效（模式/语言切换重建也会再进 after）。
      // WebView2/Chromium 内建检查：英文错词红波浪线+右键建议；中文无拼写概念不受影响。
      document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset")
        ?.setAttribute("spellcheck", activeDoc()?.large ? "false" : "true"); // v0.3.25 大文档关拼写（万级节点拼写检查烧 CPU）
      rebindImagePreview(); // v0.3.11 编辑器内本地图片预览（wysiwyg；重建后重挂 observer）
      rebindTableResize(); // v0.3.11 表格列宽拖动（近缘判定+持久化重应用）
      closeFind(); // 模式/语言切换销毁重建：旧匹配节点全部失效
      if (!vditorInited) {
        // 首次初始化：处理命令行传入的文件；否则恢复上次会话（v0.3.26：标签+阅读位置），
        // 无会话才开欢迎页。带启动文件=用户明确意图，不叠加会话（双击 .md 场景）
        vditorInited = true;
        if (pendingFile) {
          const f = pendingFile;
          pendingFile = null;
          loadFile(f);
        } else {
          void restoreSession().then((ok) => {
            if (!ok) openDoc(null, welcomeMd(), t("welcomeName"));
          });
        }
      } else {
        // 模式切换后重建：把当前文档内容恢复进新编辑器
        const doc = activeDoc();
        if (doc && vditor) {
          // 模式/语言切换销毁重建实例后同样清栈建基线（与 switchDoc 一致，防 diff 串台）
          suppressInput = true;
          vditor.setValue(doc.content, true);
          suppressInput = false;
          snapReset(doc);
        }
        rebuildOutline();
        renderTabs();
        updateTitle();
        // v0.3.26 大文档×ir 拦截的接力：模式重建完成后开真正要开的文件（loadFile 置入）
        if (pendingLargeOpen) {
          const p = pendingLargeOpen;
          pendingLargeOpen = null;
          openDoc(p.path, p.content, undefined, p.enc || undefined);
        }
      }
      updateModeUI();
      switchInFlight = false; // 重建完成，释放重入锁
    },
  };
}

function initVditor() {
  vditor = new Vditor("editor", vditorOptions(currentMode));
  if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
    (window as unknown as { __vd?: unknown }).__vd = vditor;
  }
}

// 触发 Vditor 撤销/重做：点击工具栏 undo/redo 按钮（走 Vditor 原生 toolbar→undo 路径）。
// 直接调 internal.undo.undo 会因缺少 toolbar handler 收尾、renderDiff 触发 afterRender 连锁，导致一次按键
// pop 两步；按钮点击与用户点工具栏按钮完全等价，单步行为已验证正确。供 Ctrl+Z/Y/Shift+Z 快捷键复用。
function doUndo() {
  if (!vditor) return;
  document.querySelector<HTMLElement>('#editor .vditor-toolbar [data-type="undo"]')?.click();
}
function doRedo() {
  if (!vditor) return;
  document.querySelector<HTMLElement>('#editor .vditor-toolbar [data-type="redo"]')?.click();
}

// 切换编辑模式：Vditor 3.11.2 没有运行时 changeMode，唯一可靠方式 = 销毁实例 + 以目标 mode 重建。
// IR 模式表格是源码态（管道符），不可视化编辑；WYSIWYG 模式表格可点击单元格编辑，
// 且光标进入表格会浮出工具栏：上下插行 / 左右插列 / 删行删列 / 对齐 / 删表。
function switchMode(mode: "ir" | "wysiwyg") {
  // 重入锁：destroy→after 回调之间 vditor 处于重建中间态，连点按钮/狂按 Ctrl+Alt+M 可能在
  // vditor=null 窗口期二次进入，并发触发 destroy/new 导致 DOM 残留、重复实例或内容丢失。重建中直接忽略。
  if (!vditor || currentMode === mode || switchInFlight) return;
  switchInFlight = true;
  // 清场字号交互态：重建后 savedRange/savedTa 指向已销毁旧 DOM，fontInputInteracting 卡 true 会冻结需求2 同步
  fontInputInteracting = false; savedRange = null; savedTa = null; savedStart = 0; savedEnd = 0;
  clearFontSelHl();
  // 销毁前先把当前编辑器内容回写 doc（getValue 空读守卫：空值不覆盖）
  const cur = activeDoc();
  if (cur) {
    const v = mdValue();
    if (v !== "" || cur.content === "") cur.content = v;
  }
  currentMode = mode;
  // destroy 会清掉挂载点内联样式（含 --doc-zoom）：先存后恢复，否则切模式后显示比例静默回 100%
  const savedZoom = document.getElementById("editor")?.style.getPropertyValue("--doc-zoom") || "";
  vditor.destroy();
  vditor = null;
  vditor = new Vditor("editor", vditorOptions(mode));
  if (savedZoom) document.getElementById("editor")?.style.setProperty("--doc-zoom", savedZoom);
  updateModeUI(); // after 回调就绪后还会再更新一次
}

// 更新顶部模式切换按钮文字 + 当前模式徽标
function updateModeUI() {
  const btn = document.getElementById("btn-mode");
  const badge = document.getElementById("mode-badge");
  if (currentMode === "wysiwyg") {
    if (btn) {
      setBtn("btn-mode", t("switchToIR"));
      btn.title = t("switchToIRTip");
    }
    const vm = document.getElementById("vm-mode"); if (vm) vm.textContent = t("switchToIR");
    if (badge) {
      badge.textContent = t("modeWYSIWYG");
      badge.title = t("modeWYSIWYGTip");
      badge.className = "mode-badge wysiwyg";
    }
  } else {
    if (btn) {
      setBtn("btn-mode", t("switchToWYSIWYG"));
      btn.title = t("switchToWYSIWYGTip");
    }
    const vm2 = document.getElementById("vm-mode"); if (vm2) vm2.textContent = t("switchToWYSIWYG");
    if (badge) {
      badge.textContent = t("modeIR");
      badge.title = t("modeIRTip");
      badge.className = "mode-badge ir";
    }
  }
}

// v0.3.28 工具栏按钮文本：拆「图标 + 文字」双 span（窄窗口 @container 只留图标）。
// 匹配行首 emoji（含变体选择符 U+FE0F/肤色修饰）或 ⇄；无图标则整段作 label（btn-mode 切换文案）。
// 注意：ZWJ 组合 emoji（如家庭序列）不在此防御——当前 i18n 无此形态，引入时需先扩展此处。
function setBtn(id: string, text: string) {
  const b = document.getElementById(id);
  if (!b) return;
  const m = /^([⇄\p{Extended_Pictographic}](?:\u{FE0F}|\p{Emoji_Modifier})*)\s?([\s\S]*)$/u.exec(text);
  b.textContent = "";
  if (m) {
    const ico = document.createElement("span"); ico.className = "tb-ico"; ico.textContent = m[1];
    b.appendChild(ico);
    if (m[2]) { const lb = document.createElement("span"); lb.className = "tb-label"; lb.textContent = m[2]; b.appendChild(lb); }
  } else {
    b.textContent = text;
  }
}

// 把所有静态 DOM 文案更新到当前语言（语言切换 / 初始化时调用）
function applyAllText() {
  const bo = document.getElementById("btn-open"); if (bo) { setBtn("btn-open", t("open")); bo.title = t("openTip"); }
  const bs = document.getElementById("btn-save"); if (bs) { setBtn("btn-save", t("save")); bs.title = t("saveTip"); }
  setBtn("btn-export", t("export"));
  // v0.3.29 导出菜单文案收进 i18n（补 v0.3.28 审查登记的 m6 缺口，三语）
  const expItems: Array<[string, string]> = [
    ["pdf", "exportPdf"], ["html", "exportHtmlStyled"], ["html-plain", "exportHtmlPlain"],
    ["image", "exportPng"], ["docx", "exportDocx"],
  ];
  for (const [k, key] of expItems) {
    const el = document.querySelector(`#export-menu button[data-export="${k}"]`);
    if (el) el.textContent = t(key);
  }
  const bp = document.getElementById("btn-print"); if (bp) { setBtn("btn-print", t("printBtn")); bp.title = t("printTip"); }
  const bfw = document.getElementById("btn-focus-mode"); if (bfw) { setBtn("btn-focus-mode", t("focusMode")); bfw.title = t("focusTip"); }
  const bfd = document.getElementById("btn-find"); if (bfd) { setBtn("btn-find", t("findBtn")); bfd.title = t("findTip"); }
  const bh = document.getElementById("btn-history"); if (bh) { setBtn("btn-history", t("histBtn")); bh.title = t("histTitle"); }
  const bd = document.getElementById("btn-diag"); if (bd) { setBtn("btn-diag", t("diagBtn")); bd.title = t("diagTip"); }
  const fi = document.getElementById("find-input") as HTMLInputElement | null; if (fi) fi.placeholder = t("findPlaceholder");
  const ri = document.getElementById("replace-input") as HTMLInputElement | null; if (ri) ri.placeholder = t("replacePlaceholder");
  const ro = document.getElementById("replace-one"); if (ro) ro.textContent = t("replaceOne");
  const ra = document.getElementById("replace-all"); if (ra) ra.textContent = t("replaceAll");
  const pt = document.getElementById("panel-title"); if (pt) pt.textContent = t("panelTitle");
  // v0.3.14/15 侧栏文件页 + 快开 + 主题 + 标签右键菜单
  const sto = document.getElementById("side-tab-outline"); if (sto) sto.textContent = t("sideOutline");
  const stf = document.getElementById("side-tab-files"); if (stf) stf.textContent = t("sideFiles");
  const ofi = document.getElementById("outline-filter") as HTMLInputElement | null; if (ofi) ofi.placeholder = t("outlineFilterPh");
  const ffi = document.getElementById("ftree-filter") as HTMLInputElement | null; if (ffi) ffi.placeholder = t("filterFilesPh");
  const rt = document.getElementById("recent-title"); const rts = rt ? rt.querySelector("span") : null; if (rts) rts.textContent = t("recentTitle");
  const rc = document.getElementById("recent-clear"); if (rc) { rc.title = t("clearRecentTip"); rc.textContent = t("clearRecent"); }
  const fp = document.getElementById("ftree-path") as HTMLInputElement | null; if (fp) fp.placeholder = t("treePathPh");
  const fr = document.getElementById("ftree-refresh"); if (fr) fr.title = t("treeRefreshTip");
  const gsi = document.getElementById("gsearch-input") as HTMLInputElement | null; if (gsi) gsi.placeholder = t("gsearchPh");
  const qot = document.getElementById("qo-title"); if (qot) qot.textContent = t("quickOpenTitle");
  const qoi = document.getElementById("qo-input") as HTMLInputElement | null; if (qoi) qoi.placeholder = t("quickOpenPh");
  const cki = document.getElementById("cmdk-input") as HTMLInputElement | null; if (cki) cki.placeholder = t("cmdkPh");
  const ckf = document.getElementById("cmdk-foot"); if (ckf) ckf.textContent = t("cmdkFoot");
  // v0.4.0 文件/视图菜单文案（菜单项全部复用既有键）
  const bfm2 = document.getElementById("btn-file-menu"); if (bfm2) bfm2.textContent = t("menuFile") + " ▾";
  const bvm2 = document.getElementById("btn-view-menu"); if (bvm2) bvm2.textContent = t("menuView") + " ▾";
  const setTxt = (id: string, key: string) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
  setTxt("fm-open", "openMenu"); setTxt("fm-save", "save"); setTxt("fm-history", "histBtn");
  setTxt("fm-export-pdf", "exportPdf"); setTxt("fm-export-html", "exportHtmlStyled");
  setTxt("fm-export-html-plain", "exportHtmlPlain"); setTxt("fm-export-image", "exportPng");
  setTxt("fm-export-docx", "exportDocx"); setTxt("fm-print", "printMenu"); setTxt("fm-diag", "diagBtn");
  setTxt("vm-focus", "focusMode"); setTxt("vm-reading", "readingFocus"); setTxt("vm-side", "sbSide");
  setTxt("vm-cmdk", "cmdkOpen"); setTxt("vm-qopen", "quickOpenTitle");
  // v0.4.0 状态栏 + 主题菜单（theme-select 已从工具栏移除）
  const sbz = document.getElementById("sb-zoom"); if (sbz) sbz.title = t("zoomResetTip");
  setSideCollapsed(sideCollapsed, false); // 重刷侧栏按钮文案（不动状态不落盘）
  document.querySelectorAll<HTMLElement>("#theme-menu button").forEach((b) => {
    const nm = b.dataset.theme as ThemeName | undefined;
    if (nm) b.textContent = t(themeNameKey(nm));
  });
  const tm = document.getElementById("tab-menu");
  if (tm) {
    const setTxt = (act: string, key: string) => {
      const b = tm.querySelector(`button[data-act="${act}"]`);
      if (b && act !== "close-selected") b.textContent = t(key); // 关闭选中项动态带数量，打开时刷新
    };
    setTxt("close", "tabClose"); setTxt("close-others", "tabCloseOthers");
    setTxt("close-all", "tabCloseAll"); // close-right/left 文案由 openTabMenu 按标签位置动态定
  }
  renderRecent();
  const eh = document.getElementById("empty-hint"); if (eh) eh.textContent = t("emptyHint");
  const cmsg = document.getElementById("cc-msg"); if (cmsg) cmsg.textContent = t("closeSaveMsg");
  const csave = document.getElementById("cc-save"); if (csave) csave.textContent = t("closeSave");
  const cdisc = document.getElementById("cc-discard"); if (cdisc) cdisc.textContent = t("closeDiscard");
  const ccan = document.getElementById("cc-cancel"); if (ccan) ccan.textContent = t("closeCancel");
  const sel = document.getElementById("lang-select") as HTMLSelectElement | null;
  if (sel) sel.value = currentLang;
  const fss = document.getElementById("font-size-select") as HTMLInputElement | null;
  if (fss) fss.title = t("fontSizeTip");
  document.documentElement.lang = currentLang; // a11y：屏幕阅读器发音/CSS :lang/繁体字体回退随语言
  document.title = t("appName"); // 浏览器标签/Tauri 窗口/任务栏标题随语言
  updateModeUI();
}

// 切换界面语言：持久化(localStorage) + Vditor 重建(注入新语言 i18n) + 静态文案更新
function setLang(lang: Lang) {
  // 重入锁：模式切换(switchMode)重建中(switchInFlight)不重入，避免并发 destroy/new 致双实例/DOM 残留/内容丢失
  if (lang === currentLang || switchInFlight) return;
  currentLang = lang;
  // 清场字号交互态（同 switchMode）：重建后 savedRange/savedTa 悬空、fontInputInteracting 需复位
  fontInputInteracting = false; savedRange = null; savedTa = null; savedStart = 0; savedEnd = 0;
  clearFontSelHl();
  try { localStorage.setItem("md-editor-lang", lang); } catch { /* 存储禁用，仅本次会话生效 */ }
  applyAllText();
  if (vditor) {
    switchInFlight = true; // 语言切换重建期间上锁，与 switchMode 互斥（after 回调统一释放）
    const cur = activeDoc();
    if (cur) {
      const v = mdValue();
      if (v !== "" || cur.content === "") cur.content = v;
      // 欢迎页(无 path)随语言切换更新欢迎内容；用户文档(有 path)保留原内容不动
      if (!cur.path) { cur.content = welcomeMd(); cur.name = t("welcomeName"); cur.dirty = false; }
    }
    // 同 switchMode：语言切换重建也须保住 --doc-zoom（用户报"切繁体后正文变大"的真因——
    // 字号没变，是 80% 显示比例被 destroy 清掉、视觉回到 100%）
    const savedZoom = document.getElementById("editor")?.style.getPropertyValue("--doc-zoom") || "";
    vditor.destroy();
    vditor = null;
    vditor = new Vditor("editor", vditorOptions(currentMode));
    if (savedZoom) document.getElementById("editor")?.style.setProperty("--doc-zoom", savedZoom);
  }
}

// WYSIWYG 模式下光标进入表格单元格时显示表格浮层(vditor-panel)。
// Vditor 3.11.2 在销毁重建后的 wysiwyg 实例下"光标进表自动显浮层"逻辑不触发，
// 此处手动监听 selectionchange 显/隐浮层；浮层内增删行列按钮的原生逻辑工作正常。
function bindTablePopoverVisibility() {
  document.addEventListener("selectionchange", () => {
    if (!vditor || currentMode !== "wysiwyg") return;
    const wysEl = document.querySelector("#editor .vditor-wysiwyg");
    const popover = document.querySelector("#editor .vditor-wysiwyg .vditor-panel") as HTMLElement | null;
    if (!wysEl || !popover) return;
    const sel = window.getSelection();
    const anchor = sel && sel.anchorNode;
    // selection 可落在文本节点(其 parentElement 是格)或直接落在空单元格元素(自身即格)；
    // 统一取"起点元素"再 closest，避免空单元格 anchor.parentElement=tr 漏判（cellFound=false→浮层不显示）
    const startEl = anchor ? (anchor.nodeType === 1 ? (anchor as HTMLElement) : anchor.parentElement) : null;
    const cell = startEl ? startEl.closest("td,th") : null;
    // 光标在表格单元格 或 在浮窗内(点按钮/输入行列数)时显示浮窗；
    // 点浮窗按钮/行列 input 时 selection 会落到 popover 上，必须把它视作"仍在表格编辑"，
    // 否则浮窗会一触即消（无法连续增删行/列、无法编辑行列数字）
    const inPopover = startEl ? popover.contains(startEl) : false;
    if ((cell && wysEl.contains(cell)) || inPopover) {
      popover.classList.remove("vditor-panel--none");
      popover.style.display = "block";
      if (cell && wysEl.contains(cell)) {
        // 仅光标在表格时跟随定位；点浮窗时保持原位避免跳动
        const cellRect = (cell as HTMLElement).getBoundingClientRect();
        const wysRect = (wysEl as HTMLElement).getBoundingClientRect();
        popover.style.left = Math.max(0, cellRect.left - wysRect.left) + "px";
        const popH = popover.offsetHeight;
        let top = cellRect.top - wysRect.top - popH - 4;
        if (top < 4) top = cellRect.bottom - wysRect.top + 4; // 上方放不下则放下方
        popover.style.top = top + "px";
      }
    } else {
      popover.style.display = "none";
      popover.classList.add("vditor-panel--none");
    }
  });
}

// 表格浮窗的行/列数字框：用户输入时不立即增删（避免逐字符触发——如想把行数改成 20，先输 "2" 会被
// 立即缩到 2 行、删掉第 3 行起的数据）。改为确认（回车/失焦）后才一次性增删到目标值。
// spinner ±1 也走同一通道：点 spinner 改的是数字框值，确认后才真正增删。
let tableInputIgnore = false; // 临时放行（确认时 dispatch input 让 Vditor 增删）
function commitTableInput(t: HTMLInputElement) {
  tableInputIgnore = true;
  t.dispatchEvent(new Event("input", { bubbles: true })); // 放行：Vditor 按 value 增删到目标行列数
  window.setTimeout(() => { tableInputIgnore = false; }, 100);
}
function bindTableInputConfirm() {
  // capture 拦截：阻止 Vditor 在每次 input 事件时立即增删（tableInputIgnore 时放行）
  document.addEventListener("input", (e) => {
    if (tableInputIgnore) return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== "number") return;
    const popover = document.querySelector("#editor .vditor-wysiwyg .vditor-panel");
    if (!popover || !popover.contains(t)) return;
    e.stopImmediatePropagation(); // 阻止 Vditor 的 input 监听（逐字符增删）
  }, true);
  // 回车确认 → 一次性增删到当前值
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== "number") return;
    const popover = document.querySelector("#editor .vditor-wysiwyg .vditor-panel");
    if (!popover || !popover.contains(t)) return;
    e.preventDefault();
    commitTableInput(t);
    t.blur();
  }, true);
  // 失焦确认 → 一次性增删到当前值
  document.addEventListener("focusout", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== "number") return;
    const popover = document.querySelector("#editor .vditor-wysiwyg .vditor-panel");
    if (!popover || !popover.contains(t)) return;
    commitTableInput(t);
  }, true);
}

// 关闭确认对话框：返回用户选择 保存并关闭 / 不保存关闭 / 取消
// 重入锁：并发调用（destroy 触发的二次 CloseRequested 或快速连点 ×）复用同一 Promise，避免首个永挂
let closeConfirmInFlight: Promise<"save" | "discard" | "cancel"> | null = null;
function showCloseConfirm(): Promise<"save" | "discard" | "cancel"> {
  if (closeConfirmInFlight) return closeConfirmInFlight;
  closeConfirmInFlight = new Promise((resolve) => {
    const mask = document.getElementById("close-confirm")!;
    mask.hidden = false;
    const onAction = (action: "save" | "discard" | "cancel") => {
      mask.hidden = true;
      document.getElementById("cc-save")!.onclick = null;
      document.getElementById("cc-discard")!.onclick = null;
      document.getElementById("cc-cancel")!.onclick = null;
      closeConfirmInFlight = null;
      resolve(action);
    };
    document.getElementById("cc-save")!.onclick = () => onAction("save");
    document.getElementById("cc-discard")!.onclick = () => onAction("discard");
    document.getElementById("cc-cancel")!.onclick = () => onAction("cancel");
  });
  return closeConfirmInFlight;
}

// 保存单个文档：有路径直接存，无路径弹另存；返回是否保存成功
// getValue 守卫：空值不覆盖 doc.content（防 IR 模式空读清零文件）
async function saveDoc(doc: Doc): Promise<boolean> {
  if (vditor && activeDoc()?.id === doc.id) {
    const v = mdValue();
    if (v !== "" || doc.content === "") doc.content = v;
  }
  (window as any).__sLog = (window as any).__sLog || []; // 诊断：保存时刻的取值与栈
  if ((window as any).__sLog.length < 40)
    (window as any).__sLog.push({ v: doc.content.slice(-16), u: doc.undoStack.length, r: doc.redoStack.length });
  let path = doc.path;
  if (!path) {
    const sp = await saveDialog({ filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (!sp) return false; // 用户取消另存
    path = sp as string;
    doc.path = path;
    doc.name = path.split(/[\\/]/).pop()!;
  }
  if (doc.content === "") {
    const seq = currentLang === "en" ? '"' : "「";
    showToast(seq + doc.name + t("saveEmptySuf"), "info");
    return false;
  }
  try {
    await invoke("save_file", { path, content: doc.content });
    doc.dirty = false;
    doc.base = doc.content; // v0.3.21 撤销栈的干净态基线跟随保存
    doc.bytes = utf8Bytes(doc.content); // v0.3.26 状态栏大小
    refreshMeta(doc); // v0.3.26 保存后刷新外改基准（自己的写也变 mtime，不刷会立即误报）
    scheduleSessionSave();
    return true;
  } catch (e) {
    showToast(t("saveFail") + doc.name + " — " + e, "danger");
    return false;
  }
}

// 保存所有未保存文档（关闭窗口前的"保存并关闭"用）
async function saveAllDirty() {
  for (const doc of docs) {
    if (doc.dirty) await saveDoc(doc);
  }
}

// ---- 自动保存（第二批）：仅对 dirty 且已有路径的文档静默落盘 ----
// 未命名文档跳过（无落点）；失败静默但 dirty 保留（标题 * 不消失=可感知未存成），周期 30s + 窗口失焦即存
const AUTOSAVE_INTERVAL_MS = 30_000;
let autosaveTimer: number | undefined;
async function autosaveDirty(): Promise<void> {
  if (!vditor) return;
  if (switchApplyPending) return; // v0.3.25 大文档切换装载期：此刻 mdValue 取到的是旧文档，本轮跳过
  if (activeDoc()?.lazy || activeDoc()?.loading) return; // v0.3.26 惰性装载窗口：同上，防把旧文档写进占位标签
  // 兜底：键入后立刻失焦时，Vditor input 回调可能仍在防抖窗口内未跑（dirty 未置位）——
  // 主动从编辑器取真值对比，不等 input 回调（fullcheck A11b 实证：type 后立即 blur 会漏存最后一段）
  const a = activeDoc();
  if (a?.path) {
    if (a.large) { flushValueSync(a); } // v0.3.25 大文档：有待同步才取值（阅读闲置时 30s tick 零取值成本）
    else {
      const v = mdValue();
      if ((v !== "" || a.content === "") && v !== a.content) { a.content = v; a.dirty = true; }
    }
  }
  for (const doc of docs) {
    if (!doc.dirty || !doc.path) continue;
    if (activeDoc()?.id === doc.id && !doc.large) { // v0.3.25 大文档刚在上面 flushValueSync 取过真值，不再二次付 465ms
      const v = mdValue();
      if (v !== "" || doc.content === "") doc.content = v; // 守卫：空值不覆盖（同 saveDoc）
    }
    if (doc.content === "") continue;
    try {
      await invoke("save_file", { path: doc.path, content: doc.content });
      doc.dirty = false;
      doc.encoding = "UTF-8"; // 统一写 UTF-8 无 BOM（同手动保存）
      refreshMeta(doc); // v0.3.26 自动保存同样刷新外改基准
      doc.bytes = utf8Bytes(doc.content);
      if (activeDoc()?.id === doc.id) { updateTitle(); renderTabs(); }
    } catch { /* 静默失败：dirty 保留，下轮重试 */ }
  }
}
function startAutosave() {
  if (autosaveTimer !== undefined) return;
  autosaveTimer = window.setInterval(() => { void autosaveDirty(); }, AUTOSAVE_INTERVAL_MS);
  window.addEventListener("blur", () => { window.setTimeout(() => { void autosaveDirty(); }, 200); });
}

// ---- 专注模式 + 打字机模式（第二批，Typora 对位 F8/F9）----
const FOCUS_KEY = "md-editor-focus-mode";
let focusModeOn = false;

// 编辑区滚动容器：从 pre.vditor-reset 自身起向上找第一个可滚动元素（实测滚动就发生在 pre 自身，overflowY:auto）
function editorScrollEl(): HTMLElement | null {
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset") as HTMLElement | null;
  let el: HTMLElement | null = root;
  while (el) {
    const st = getComputedStyle(el);
    if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return null;
}

// 专注模式：光标所在顶层块（编辑区根的直接子元素）标 .fw-current，CSS 淡化其余
function markCurrentBlock() {
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset");
  if (!root) return;
  const sel = getSelection();
  let blk: Element | null = null;
  if (sel && sel.focusNode) {
    let n: Node | null = sel.focusNode;
    while (n && n !== root) {
      if (n.parentElement === root) { blk = n instanceof Element ? n : n.parentElement; break; }
      n = n.parentElement;
    }
  }
  root.querySelectorAll(":scope > .fw-current").forEach((e) => e.classList.remove("fw-current"));
  if (blk) blk.classList.add("fw-current");
}

// 光标滚入视线带（40% 线）：供粘贴跟随复用（打字机模式本身已按用户要求移除）。
// 偏离超过约一行(~28px)即平滑补偿
function typewriterScroll() {
  const sel = getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return; // 无可视光标（如焦点在输入框）
  const sc = editorScrollEl();
  if (!sc) return;
  const cur = r.top - sc.getBoundingClientRect().top;
  const target = sc.clientHeight * 0.4;
  const delta = cur - target;
  if (Math.abs(delta) > 28) sc.scrollTo({ top: sc.scrollTop + delta, behavior: reducedMotion() ? "auto" : "smooth" });
}

function setFocusMode(on: boolean) {
  focusModeOn = on;
  document.body.classList.toggle("focus-mode", on);
  try { localStorage.setItem(FOCUS_KEY, on ? "1" : "0"); } catch { /* 存储禁用，仅本次会话生效 */ }
  document.getElementById("btn-focus-mode")?.classList.toggle("active", on);
  if (on) markCurrentBlock();
  else document.querySelectorAll(".fw-current").forEach((e) => e.classList.remove("fw-current"));
}

// selectionchange 防抖驱动（专注模式开启时干活）
let fwSelDebounce: number | undefined;
function bindFocusTypewriter() {
  document.addEventListener("selectionchange", () => {
    if (!focusModeOn) return;
    window.clearTimeout(fwSelDebounce);
    fwSelDebounce = window.setTimeout(() => { if (focusModeOn) markCurrentBlock(); }, 120);
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "F8") { e.preventDefault(); setFocusMode(!focusModeOn); }
  });
  document.getElementById("btn-focus-mode")?.addEventListener("click", () => setFocusMode(!focusModeOn));
  // 粘贴跟随光标（与打字机无关，普适 UX）：粘贴长文本后光标落在视口外，
  // 视口必须滚过去（用户实测"要手动翻页找光标"）。
  // 监听必须 capture 阶段：Vditor 元素级粘贴处理会 stopPropagation，冒泡到不了 document。
  // anchor 判定放在 350ms 后：粘贴瞬间 anchor 在 Vditor 临时接收节点（不在编辑区），
  // 插入完成后才落到粘贴尾部（探针实证 anchorIn=True）。双时点重试防重渲染竞态。
  let pasteAt = 0;
  document.addEventListener("paste", () => {
    pasteAt = Date.now();
    window.setTimeout(() => { if (Date.now() - pasteAt < 4000) scrollCaretIntoBand(); }, 350);
    window.setTimeout(() => { if (Date.now() - pasteAt < 4000) scrollCaretIntoBand(); }, 900);
  }, true);
}

// 光标入带：非编辑区选区直接忽略；可见则不动；视口外则滚到 40% 带；rect 无效（渲染竞态）则原生兜底
function scrollCaretIntoBand() {
  const sel = getSelection();
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset");
  if (!sel || sel.rangeCount === 0 || !root || !root.contains(sel.anchorNode ?? null)) return;
  const sc = editorScrollEl();
  if (!sc) return;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  const scRect = sc.getBoundingClientRect();
  if (r.height > 0 && r.top >= scRect.top - 5 && r.bottom <= scRect.bottom + 5) return; // 已可见
  if (r.height > 0) { typewriterScroll(); return; }
  const el = sel.getRangeAt(0).startContainer.parentElement as HTMLElement | null;
  el?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
}

// ---- 查找替换（第二批）：overlay 高亮层方案 ----
// 高亮画在 fixed 覆盖层（不进 contenteditable DOM → 不污染 md 源码/undo 栈）；
// 替换单个走 execCommand（键入管线，undo 完整）；全部替换走源码级（快照节点会被 Vditor 重渲染失效，源码级绝对可靠）
interface FindMatch { node: Text; start: number; end: number; }
let findMatches: FindMatch[] = [];
let findIndex = -1;
// v0.3.11 正则模式：查找条 ".*" 开关（会话内保持）。字面模式大小写不敏感；正则默认 gi
// （与字面行为一致），元字符生效，替换支持 $1 引用。无效正则按 0 命中处理并在计数位提示。
let findRegexOn = false;

function buildFindRegex(query: string): RegExp | null {
  try { return new RegExp(query, "gi"); } catch { return null; }
}

function scanMatches(query: string): FindMatch[] {
  const out: FindMatch[] = [];
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset");
  if (!root || !query) return out;
  const re = findRegexOn ? buildFindRegex(query) : null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      // 1=FILTER_ACCEPT 2=FILTER_REJECT（TS lib 的 filter 类型缺 FILTER 常量表，用数值）
      return (!p || p.closest(".vditor-hint, .vditor-panel")) ? 2 : 1; // 编辑器自身 UI 不搜
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    if (findRegexOn) {
      if (!re) break; // 无效正则：空结果
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(t.data)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; } // 空匹配（如 a*）防死循环
        out.push({ node: t, start: m.index, end: m.index + m[0].length });
      }
    } else {
      const hay = t.data.toLowerCase();
      const q = query.toLowerCase();
      let i = hay.indexOf(q);
      while (i !== -1) {
        out.push({ node: t, start: i, end: i + q.length });
        i = hay.indexOf(q, i + q.length);
      }
    }
  }
  return out;
}

function renderFindOverlay() {
  const ov = document.getElementById("find-overlay");
  const cnt = document.getElementById("find-count");
  if (!ov) return;
  ov.innerHTML = "";
  findMatches.forEach((m, i) => {
    try {
      const r = document.createRange();
      r.setStart(m.node, m.start); r.setEnd(m.node, m.end);
      for (const rect of r.getClientRects()) {
        const d = document.createElement("div");
        d.className = "find-mark" + (i === findIndex ? " current" : "");
        d.style.left = rect.left + "px";
        d.style.top = rect.top + "px";
        d.style.width = Math.max(rect.width, 4) + "px";
        d.style.height = rect.height + "px";
        ov.appendChild(d);
      }
    } catch { /* 节点已被 Vditor 重渲染移除：跳过该匹配 */ }
  });
  if (cnt) cnt.textContent = findMatches.length === 0 ? "0/0" : `${findIndex + 1}/${findMatches.length}`;
}

function gotoMatch(idx: number) {
  if (findMatches.length === 0) { findIndex = -1; renderFindOverlay(); return; }
  findIndex = ((idx % findMatches.length) + findMatches.length) % findMatches.length;
  const m = findMatches[findIndex];
  try {
    const r = document.createRange();
    r.setStart(m.node, m.start); r.setEnd(m.node, m.end);
    const rect = r.getBoundingClientRect();
    if (rect.top < 130 || rect.bottom > innerHeight - 60) m.node.parentElement?.scrollIntoView({ block: "center" });
  } catch { /* 同上 */ }
  renderFindOverlay();
}

function refreshFind(resetIndex: boolean) {
  if (document.getElementById("find-bar")?.hidden) return;
  const q = (document.getElementById("find-input") as HTMLInputElement).value;
  findMatches = scanMatches(q);
  if (resetIndex || findIndex >= findMatches.length) findIndex = findMatches.length > 0 ? 0 : -1;
  renderFindOverlay();
  // 无效正则显式提示（0/0 与"没找到"不可区分会误导排错）
  const cnt = document.getElementById("find-count");
  if (cnt && findRegexOn && q && !buildFindRegex(q)) cnt.textContent = "无效";
}

function openFind(withReplace: boolean) {
  const bar = document.getElementById("find-bar")!;
  const wasOpen = !bar.hidden; // v0.3.12：条已开（如 Ctrl+F 后再 Ctrl+H 展开替换行）时
  bar.hidden = false;          // 不做选区预填——否则编辑区残留选区会覆盖用户已输入的查找词
  if (withReplace) document.getElementById("replace-row")!.hidden = false;
  const inp = document.getElementById("find-input") as HTMLInputElement;
  // 选区文本预填（≤200 字符），无选区保留上次关键词
  const selText = wasOpen ? "" : (getSelection()?.toString() ?? "");
  if (selText && selText.length <= 200 && selText.includes("\n") === false) {
    inp.value = selText;
    refreshFind(true);
  }
  inp.focus();
  inp.select();
}

function closeFind() {
  const bar = document.getElementById("find-bar");
  if (!bar || bar.hidden) return;
  bar.hidden = true;
  document.getElementById("replace-row")!.hidden = true;
  findMatches = [];
  findIndex = -1;
  document.getElementById("find-overlay")!.innerHTML = "";
  (document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset") as HTMLElement | null)?.focus?.();
}

// 单个替换：DOM Range 选中 → execCommand 插入（走 Vditor 键入管线：内容/undo/大纲联动）
// 焦点必须先回编辑区再重设 selection：点击"替换"按钮后焦点在按钮上，此时 execCommand 的
// "替换当前选区"不生效（表现为只插入不删除旧词）
function replaceCurrent() {
  const m = findMatches[findIndex];
  if (!m || !vditor) return;
  const repRaw = (document.getElementById("replace-input") as HTMLInputElement).value;
  // 正则模式：把 $1/$2 展开为当前命中里的实际分组内容，再走 insertText（键入管线/undo 完整）
  let rep = repRaw;
  if (findRegexOn) {
    const q = (document.getElementById("find-input") as HTMLInputElement).value;
    const hit = m.node.data.slice(m.start, m.end);
    try { rep = hit.replace(new RegExp(q, "i"), repRaw); } catch { /* 无效正则按字面 */ }
  }
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset") as HTMLElement | null;
  try {
    const r = document.createRange();
    r.setStart(m.node, m.start); r.setEnd(m.node, m.end);
    root?.focus();
    const sel = getSelection(); sel!.removeAllRanges(); sel!.addRange(r);
    if (!document.execCommand("insertText", false, rep)) return;
  } catch { return; }
  refreshFind(false);
}

// 全部替换：DOM 循环替换（每轮重扫拿新快照再替换第一处）。
// v0.3.12 重做：旧路径 getValue→setValue(newSrc, **true**) 会清空 undo 栈=全替后完全
// 不可撤销（全面测试实测落盘铁证，用户误替换只能靠版本历史救）。改为与单替同构的
// execCommand("insertText") 键入管线——每处替换一个 undo 步，Ctrl+Z 逐处回退（Word 同语义）。
// 当年弃用 DOM 快照的根因（execCommand 后 Vditor 重渲染使快照节点失效）用"每轮重扫"化解。
// 语义注记：单替/全替统一作用于渲染文本（含 md 标记的关键词命中一致）；
// insertText 原样插入替换串，字面 rep 含 $&/$1 不展开（String.replace 隐患不再存在）。
// 全部替换：源码层一次性替换 + setValue 不清 undo 栈（v0.3.14 定稿）。
// 历史教训：v0.3.13 曾用"逐处 execCommand 循环"（每处一个 undo 步），但 Vditor 每处
// 替换后全量重渲染会把选区锚点重置到元素级，"已处理边界"过滤随之失效——替换产物自身
// 含匹配时（(\d+)→#$1# 产 #123#，其中的 123 再命中）滚雪球死循环，e2e B4 实锤 1500 轮
// guard 跑满、文档被毁容（find-count 1502）。两轮位置型修补（节点相等/FOLLOWING 位、
// compareBoundaryPoints）都被"重渲染重置锚点"击穿后，改为与 Typora/VSCode 同构的
// 源码层单遍替换：一次 setValue 写回（第二参不传=不清 undo 栈），Ctrl+Z 一次回退整个
// 全替（Word 同语义）。字面模式 split/join（$ 不展开）；正则模式原生 $1/$& 语义。
// 口径注记：查找高亮数的是渲染文本，全替按源码替换——跨语法标记的匹配两者计数可差，
// 纯内容场景一致（Typora 全替亦为源码层）。
function replaceAllMatches() {
  if (!vditor) return;
  const q = (document.getElementById("find-input") as HTMLInputElement).value;
  if (!q) return;
  const repRaw = (document.getElementById("replace-input") as HTMLInputElement).value;
  const src = mdValue();
  let out: string;
  if (findRegexOn) {
    let re: RegExp | null = null;
    try { re = new RegExp(q, "gi"); } catch { return; } // 无效正则：不动作（find-count 已示"无效"）
    out = src.replace(re, repRaw);
  } else {
    out = src.split(q).join(repRaw);
  }
  if (out === src) { refreshFind(true); return; } // 0 处命中
  // v0.3.21 自建撤销栈时代补记：历史上全替靠"setValue 第二参不传=不清 Vditor 内置栈"实现
  // Ctrl+Z 一次回退（v0.3.14 定稿）；自建栈接管键盘后 Vditor undo 不可达，若不显式记步，
  // 全替彻底不可撤销（B5 实锤：栈深 0，Ctrl+Z 无步可撤）。现以替换前源码为一步，Word 同语义。
  const doc0 = activeDoc();
  if (doc0) {
    doc0.undoStack.push(src);
    if (doc0.undoStack.length > 100) doc0.undoStack.shift();
    doc0.redoStack.length = 0; // 新编辑作废重做分支
  }
  suppressInput = true;
  try { vditor.setValue(out); } finally { suppressInput = false; }
  const doc = activeDoc();
  if (doc) { doc.content = out; doc.dirty = true; }
  snapReset(doc); // snapBase 对齐替换后值：后续键入开步基线正确，不会把 out 重复记步
  scheduleOutline(); updateTitle(); refreshFind(true);
}

let findInputDebounce: number | undefined;
function bindFindBar() {
  const inp = document.getElementById("find-input") as HTMLInputElement;
  inp.setAttribute("list", "find-hist-dl"); // v0.3.26 查找历史下拉（datalist）
  (document.getElementById("replace-input") as HTMLInputElement)?.setAttribute("list", "rep-hist-dl");
  inp.addEventListener("input", () => {
    window.clearTimeout(findInputDebounce);
    findInputDebounce = window.setTimeout(() => refreshFind(true), 250);
  });
  inp.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // IME 组合态的 Enter/Esc 交给输入法
    if (e.key === "Enter") {
      e.preventDefault();
      if (inp.value.trim()) pushFindHistory("findHist", inp.value); // v0.3.26 执行时记历史（N++ 同语义）
      gotoMatch(e.shiftKey ? findIndex - 1 : findIndex + 1);
    }
    else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });
  // 查找条所有按钮统一 pointerdown（按下即触发）：click 需 down+up 落在同一元素，
  // 微拖/浮层闪现/输入法状态切换都会吃掉事件且无任何报错——用户三次报告"点不动"。
  // pointerdown 物理级可靠；各处理函数幂等，后续 click 重入无害。
  const onDown = (id: string, fn: () => void) => {
    document.getElementById(id)!.addEventListener("pointerdown", (e) => { e.preventDefault(); fn(); });
  };
  onDown("find-next", () => gotoMatch(findIndex + 1));
  onDown("find-prev", () => gotoMatch(findIndex - 1));
  // 正则模式开关：toggle 后立即重扫（.* 高亮态即当前语义）
  document.getElementById("find-re")!.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    findRegexOn = !findRegexOn;
    (e.currentTarget as HTMLElement).classList.toggle("active", findRegexOn);
    refreshFind(true);
  });
  // ✕ 用 pointerdown 而非 click：click 需 down+up 落在同一元素，任何扰动（微小拖动、
  // 浮层闪现、IME 状态切换）都会吃掉事件且无任何报错——用户两次报告"点✕无反应"。
  // pointerdown 按下即触发；closeFind 幂等（bar.hidden 直接 return），后续 click 重入无害。
  document.getElementById("find-close")!.addEventListener("pointerdown", (e) => { e.preventDefault(); closeFind(); });
  // ⇄"展开/收起替换"按钮已按用户要求移除：替换行只由 Ctrl+H 控制
  onDown("replace-one", replaceCurrent);
  onDown("replace-all", () => {
    if (findMatches.length > 500 && !confirm(t("replaceManyConfirm"))) return;
    // v0.3.26 替换执行记历史（查找词+替换词）
    const fq = (document.getElementById("find-input") as HTMLInputElement).value.trim();
    const rq = (document.getElementById("replace-input") as HTMLInputElement).value.trim();
    if (fq) pushFindHistory("findHist", fq);
    if (rq) pushFindHistory("repHist", rq);
    replaceAllMatches();
  });
  (document.getElementById("replace-input") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });
  // 全局 Esc 兜底：焦点不在查找条输入框时（如在编辑区）Esc 也能关闭
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.isComposing) return;
    const bar = document.getElementById("find-bar");
    if (bar && !bar.hidden) { e.preventDefault(); closeFind(); }
  });
  // 不做"点击外部收起"（2026-08-27 用户定调：点正文编辑时查找条要留着，等点 ✕ 才关）。
  // 关闭路径 = ✕ 按钮 / Esc（含输入框外的全局兜底）/ 🔍按钮 toggle。
  // 🔍查找按钮 toggle：开→关（用户预期：再点一次消失）。Ctrl+F/H 仍只开（编辑中快捷键不反关）
  document.getElementById("btn-find")!.addEventListener("click", () => {
    const bar = document.getElementById("find-bar")!;
    if (!bar.hidden) closeFind(); else openFind(false);
  });
  // Ctrl+F / Ctrl+H（WebView2 无原生查找 UI）。必须用捕获阶段 + stopPropagation：
  // Vditor 内置 toolbar headings 按钮的 hotkey 是 ⌘H（Ctrl+H 弹"一级~六级标题"下拉），
  // 其 keydown 绑在编辑器元素上，先于 window 冒泡 handler 执行——不拦截就会替换框+标题菜单双弹。
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault(); e.stopPropagation(); openFind(false);
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "h" || e.key === "H")) {
      e.preventDefault(); e.stopPropagation(); openFind(true);
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "p" || e.key === "P")) {
      // v0.3.9 打印。Vditor 内置 ⌘P=edit-mode 按钮热键，但工具栏未配置该按钮不激活；
      // 捕获拦截兜底（与 Ctrl+H 同理），防双触发
      e.preventDefault(); e.stopPropagation(); printCurrentDoc();
    }
    // ⌘Z/⌘Y/⌘S/⌘⇧Z 已搬到模块顶层注册（早于 Vditor 抢占，见文件头注释）
  }, true);
  // 编辑内容变化 → 高亮同步（document input 捕获 contenteditable 键入，避免动 vditor 共用 input 回调链）
  // 排除查找条自身输入：否则会清掉 find-input 的 250ms 定时器（同一 debounce 变量被互踩 → findIndex 恒 -1）
  document.addEventListener("input", (e) => {
    const tid = (e.target as HTMLElement)?.id;
    if (tid === "find-input" || tid === "replace-input") return;
    if (document.getElementById("find-bar")?.hidden) return;
    window.clearTimeout(findInputDebounce);
    findInputDebounce = window.setTimeout(() => refreshFind(false), 400);
  });
  // 滚动 → 重绘高亮（Range 跟随 DOM，rect 视口坐标需重取）
  let findScrollRaf = false;
  document.addEventListener("scroll", () => {
    if (document.getElementById("find-bar")?.hidden || findScrollRaf) return;
    findScrollRaf = true;
    requestAnimationFrame(() => { findScrollRaf = false; renderFindOverlay(); });
  }, true);
  window.addEventListener("resize", () => { if (!document.getElementById("find-bar")?.hidden) renderFindOverlay(); });
}

// 把相对图片 src 解析为绝对 file:// 路径：Rust 端把完整 HTML 写临时文件交 msedge 渲染，
// msedge 进程工作目录非文档目录，相对路径 ./x.png 会指向 temp 目录而解析失败。
// 仅处理相对路径（./ 或不带协议的），远程(http/https)与 data: base64 原样不动。
// doc 未保存（path=null）时无法解析目录 → 照原样（非回归，与历史行为一致）。
function resolveImageSources(fragment: HTMLElement, docPath: string | null) {
  if (!docPath) return;
  // 取文档所在目录作为 base（Windows 反斜杠统一为正斜杠）
  const dir = docPath.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  fragment.querySelectorAll<HTMLImageElement>("img[src]").forEach((img) => {
    let src = img.getAttribute("src");
    if (!src) return;
    // v0.3.11 图片预览的显示层 asset URL（getHTML 从污染源码生成）→ 解码还原磁盘绝对路径，
    // 走下方既有链路（绝对路径保持原样，浏览器按 file:/// 规范化解析）
    const am = src.match(/^(?:https?:)?\/\/asset\.localhost\/(.+)$/);
    if (am) {
      try { src = decodeURIComponent(am[1]).replace(/\/$/, ""); img.setAttribute("src", src); }
      catch { /* 解码失败保原样 */ }
    }
    // 已带协议（http/https/file）或 data: base64 的绝对资源不动
    if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(src) || src.startsWith("data:")) return;
    const clean = src.replace(/^\.\//, "");
    if (/^[a-zA-Z]:[\\/]/.test(clean)) return; // 已是 Windows 绝对路径
    const abs = dir + "/" + clean;
    // 转 file:/// URL：反斜杠→正斜杠，encodeURI 处理中文与空格
    img.setAttribute("src", "file:///" + encodeURI(abs.replace(/\\/g, "/")));
  });
}

// 把渲染好的 HTML 片段包装成可独立渲染的完整文档，交 Rust 端 msedge headless 导出。
// 内联整份 Vditor CSS（构建期 ?raw 编为字符串常量），保证导出渲染规则（.vditor-reset/代码高亮/表格/引用）
// 与编辑区一致；@page 控制纸张 A4 与页边距；打印样式防分页断裂与图片缩放。
// 该 HTML 由独立 msedge 进程从 file:// 加载，不经过 Tauri webview，应用 CSP（script-src 'self'）不适用。
// v0.3.8 修正：katex css 的 @font-face 以相对路径引 fonts/*.woff2，临时 html 里必 404，
// Chromium print-to-pdf 等 document.fonts.ready 直接挂死（D1 后 overlay 永不消失挡住一切输入的根因）——
// 构建期剥掉字体声明，公式字形回退系统字体（上下标等排版结构由 css 类控制不受影响），导出物零外链资源。
const katexCssNoFonts = katexCssText.replace(/@font-face\s*\{[^}]*\}/g, "");
function wrapExportHtml(fragmentHtml: string): string {
  const langAttr = currentLang === "en" ? "en" : currentLang === "zh-TW" ? "zh-TW" : "zh-CN";
  return `<!DOCTYPE html>
<html lang="${langAttr}">
<head>
<meta charset="UTF-8">
<style>
${vditorCssText}
${katexCssNoFonts}
@page { size: A4; margin: 15mm; }
html, body {
  margin: 0; padding: 0; background: #fff; color: #000;
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", "Segoe UI", system-ui, sans-serif;
  font-size: 14px; line-height: 1.75;
}
.vditor-reset { max-width: none; margin: 0; padding: 0; }
pre { white-space: pre-wrap; word-break: break-word; }
/* v0.3.24：table 从 avoid 名单移除——表格能换行后整表变高，avoid 会把整表推到下页
 * （首页标题下大片空白）；tr 保持不拆 + Chrome 断页时自动重复 thead */
pre, tr, blockquote, img { break-inside: avoid; }
img { max-width: 100%; }
/* v0.3.24 宽表修复：此前只有 border-collapse，多列长文本表被内容撑出 A4 页面（右侧截断）。
 * 特异性两次踩坑实录：①裸 table/td (0,0,1) 输给 Vditor (0,1,1)/(0,1,2)；②.vditor-reset td
 * (0,1,1) 仍输——Vditor 单元格规则实为 .vditor-reset table td (0,1,2)（nowrap 移动端滚动表
 * 设计）。必须逐字同形 (0,1,2)+本块位于 vditorCssText 之后才生效。fixed 布局以首行单元格宽
 * 为列宽基准（applyTableColWeights 按内容权重预设百分比），超出列宽的内容强制换行 */
.vditor-reset table { border-collapse: collapse; width: 100%; table-layout: fixed; display: table; overflow: visible; }
.vditor-reset table th, .vditor-reset table td { overflow-wrap: anywhere; word-break: break-word; white-space: normal; }
</style>
</head>
<body class="vditor-reset"><div class="vditor-reset">${fragmentHtml}</div></body>
</html>`;
}

// ===== v0.3.0 导出中心：HTML 两档 / 图片长图 / DOCX（v0.3.2 移除"复制富文本"，v0.3.5 移除 Pandoc 桥）=====


/** File → 纯 base64（无 data: 前缀） */
function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve((fr.result as string).split(",")[1]);
    fr.onerror = reject;
    fr.readAsDataURL(f);
  });
}

/** 粘贴/拖入图片落地：Rust 写 assets/（或未命名文档 pasted/）→ 插入引用 */
async function handlePasteImages(files: File[]): Promise<null> {
  const imgs = files.filter((f) => f.type.startsWith("image/"));
  if (!imgs.length || !vditor) return null;
  const doc = activeDoc();
  const docDir = doc?.path ? doc.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "") : "";
  for (const f of imgs) {
    try {
      const b64 = await fileToBase64(f);
      const ext = (f.name.split(".").pop() || "png").toLowerCase();
      const r = await invoke<{ rel: string; abs: string }>("save_paste_image", { docDir, ext, dataB64: b64 });
      vditor.insertValue(`\n![](${r.rel})\n`);
    } catch (e) {
      console.error("paste image save failed:", e);
    }
  }
  return null; // 阻止 Vditor 默认上传 UI
}

/** 渲染层图片路径换算：源码保持可移植的相对路径，预览时转 asset:// URL（webview 按文件系统解析） */
function resolvePreviewImages(html: string): string {
  const doc = activeDoc();
  const docDir = doc?.path ? doc.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "") : null;
  return html.replace(/(src=")([^"]+)(")/g, (m, p1: string, src: string, p3: string) => {
    if (/^(https?:|data:|blob:|asset:|\/vditor-assets)/i.test(src)) return m;
    let abs: string | null = null;
    if (/^[A-Za-z]:\//.test(src)) abs = src; // 绝对路径（未命名文档粘贴的截图）
    else if (docDir) abs = docDir + "/" + src.split("?")[0]; // 相对路径按文档目录解析
    if (!abs) return m;
    try { return p1 + convertFileSrc(abs) + p3; } catch { return m; }
  });
}

// ===== v0.3.11 编辑器内本地图片预览（wysiwyg）=====
// 架构：v0.3.0 取舍"源码可移植 vs 编辑器内显示"——现在两头都要：显示层把相对 src 换算
// asset://（MutationObserver 持续兜住 Vditor 重渲染），序列化层统一走 mdValue() 把 asset
// URL 还原为相对路径。IR 模式继续走 preview.transform（resolvePreviewImages），互不干扰。
let imgPreviewObserver: MutationObserver | null = null;
function rebindImagePreview(): void {
  imgPreviewObserver?.disconnect();
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset") as HTMLElement | null;
  if (!root) return;
  const fix = (): void => {
    const doc = activeDoc();
    const dir = doc?.path ? doc.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "") : null;
    root.querySelectorAll<HTMLImageElement>("img[src]").forEach((img) => {
      const src = img.getAttribute("src") || "";
      // 已是显示 URL（asset）或远程/base64/应用资源：不动。data-orig-src 标记防重入循环
      if (img.dataset.origSrc !== undefined || !src) return;
      if (/^(https?:|data:|blob:|asset:|\/\/|\/vditor-assets)/i.test(src)) return;
      let abs: string | null = null;
      if (/^[A-Za-z]:[\\/]/.test(src)) abs = src.replace(/\\/g, "/"); // 未命名文档的绝对路径粘贴
      else if (dir) abs = dir + "/" + src.split("?")[0];
      if (!abs) return;
      img.dataset.origSrc = src;
      try { img.src = convertFileSrc(abs); } catch { delete img.dataset.origSrc; }
    });
  };
  fix();
  imgPreviewObserver = new MutationObserver(() => fix());
  imgPreviewObserver.observe(root, { childList: true, subtree: true });
}

// ===== v0.3.11 表格列宽拖动（视图层方案：不动 md 源码，宽度按文档+表格签名持久化） =====
// 交互=Excel/Word 式近缘判定：鼠标移到表头单元格右缘 6px 内出 col-resize 光标，拖动改列宽，
// 右邻列互补（表格总宽稳定）。table-layout:fixed + 首行 th.style.width 定列宽（Lute 序列化
// 只取文本与对齐，样式不进源码——e2e 断言 getValue 干净性兜底）。Vditor 重渲染清 style 后由
// observer 重应用。导出链在 resolveImageSources 同期把宽度写进产物（见 applyExportWidths）。
const COLW_KEY = "mded-colw-v1";
let tblWidthObserver: MutationObserver | null = null;

function colwAll(): Record<string, Record<string, number[]>> {
  try { return JSON.parse(localStorage.getItem(COLW_KEY) || "{}"); } catch { return {}; }
}
function tableSig(tb: HTMLTableElement): string {
  return (tb.rows[0]?.innerText || "").replace(/\s+/g, "").slice(0, 60);
}
function docKeyOf(): string {
  const doc = activeDoc();
  return doc?.path || ("name:" + (doc?.name || ""));
}
/** 把存档宽度应用到当前所有表格（重渲染/切文档/启动后调用） */
function applyTableWidths(): void {
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset");
  if (!root) return;
  const saved = colwAll()[docKeyOf()] || {};
  root.querySelectorAll<HTMLTableElement>("table").forEach((tb) => {
    const w = saved[tableSig(tb)];
    if (!w) return;
    tb.style.tableLayout = "fixed";
    const first = tb.rows[0];
    if (!first) return;
    [...first.cells].forEach((c, i) => { if (w[i] > 0) (c as HTMLElement).style.width = w[i] + "px"; });
  });
}
/** 导出用：把编辑器当前的列宽写进导出 fragment 的 table（HTML/PDF/PNG 同步所见） */
/** v0.3.24 导出表格按内容权重分配列宽：table-layout:fixed 下浏览器以首行单元格宽为
 * 列宽基准——给每表首行设百分比，替代均分（# 列不再与长文本列同宽，长文本列自动换行）。
 * 与 applyExportWidths 协作：本函数先跑设百分比兜底，用户编辑器内拖定的 px 宽后跑覆盖。 */
function applyTableColWeights(fragment: HTMLElement): void {
  fragment.querySelectorAll<HTMLTableElement>("table").forEach((tb) => {
    const first = tb.rows[0];
    if (!first) return;
    const cells = [...first.cells];
    const n = cells.length;
    if (n < 2) return;
    const weights = new Array(n).fill(1);
    for (const tr of tb.rows) {
      [...tr.cells].forEach((c, i) => { if (i < n) weights[i] = Math.max(weights[i], visualLen(c.textContent || ""), 1); });
    }
    const pct = allocColWidths(weights, 1000).map((x) => (x / 10).toFixed(1) + "%");
    cells.forEach((c, i) => { (c as HTMLElement).style.width = pct[i]; });
  });
}
function applyExportWidths(fragment: HTMLElement): void {
  const saved = colwAll()[docKeyOf()] || {};
  fragment.querySelectorAll<HTMLTableElement>("table").forEach((tb) => {
    const w = saved[tableSig(tb)];
    if (!w) return;
    tb.style.tableLayout = "fixed";
    const first = tb.rows[0];
    if (!first) return;
    [...first.cells].forEach((c, i) => { if (w[i] > 0) (c as HTMLElement).style.width = w[i] + "px"; });
  });
}
/** v0.3.24 mermaid 图随显示比例缩放：mermaid 输出的 SVG 是 width=100% + 内联
 * max-width:Npx，而显示比例=#editor .vditor-content 的 CSS zoom——zoom 放大内容但不放宽
 * 容器（物理宽受窗口约束），width:100% 的 SVG 视觉宽恒等于容器宽，放大对图无效（无头
 * Chrome 实测复现）。改为显式自然宽 px（zoom 下按倍数放大 ✓，同样实测验证），外层容器
 * 横向滚动兜底。幂等：处理后 max-width 变 none，px 正则不再命中。 */
function fitMermaidSvgs(): void {
  document.querySelectorAll<SVGSVGElement>(".vditor-reset svg").forEach((svg) => {
    const m = /max-width:\s*([\d.]+)px/.exec(svg.getAttribute("style") || "");
    if (!m) return;
    svg.style.width = m[1] + "px";
    svg.style.maxWidth = "none";
    const holder = svg.parentElement;
    if (holder) holder.style.overflowX = "auto"; // 超容器宽时滚动而非撑破布局
  });
}

function rebindTableResize(): void {
  tblWidthObserver?.disconnect();
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset") as HTMLElement | null;
  if (!root) return;
  applyTableWidths();
  fitMermaidSvgs();
  tblWidthObserver = new MutationObserver(() => { applyTableWidths(); fitMermaidSvgs(); });
  tblWidthObserver.observe(root, { childList: true, subtree: true });

  // 近缘光标（mousemove 节流切换，不加 DOM 手柄——零注入零序列化风险）
  root.addEventListener("mousemove", (e) => {
    const cell = (e.target as HTMLElement).closest?.("th,td") as HTMLElement | null;
    if (!cell) { root.style.cursor = ""; return; }
    const r = cell.getBoundingClientRect();
    const near = e.clientX > r.right - 6 && e.clientX < r.right + 4;
    root.style.cursor = near ? "col-resize" : "";
  });
  root.addEventListener("mouseleave", () => { root.style.cursor = ""; });
  root.addEventListener("mousedown", (e) => {
    const cell = (e.target as HTMLElement).closest?.("th,td") as HTMLElement | null;
    if (!cell || !cell.closest("table")) return;
    const r = cell.getBoundingClientRect();
    if (!(e.clientX > r.right - 6 && e.clientX < r.right + 4)) return;
    const tb = cell.closest("table") as HTMLTableElement;
    const idx = (cell as HTMLTableCellElement).cellIndex;
    const first = tb.rows[0];
    if (!first || idx >= first.cells.length) return;
    // 锚定：编辑器当前真实列宽（渲染态可能与存档有偏差，从 rect 起算）
    const colRect = (first.cells[idx] as HTMLElement).getBoundingClientRect();
    const nextCell = first.cells[idx + 1] as HTMLElement | undefined;
    const nextRect = nextCell?.getBoundingClientRect();
    const startX = e.clientX;
    const w0 = colRect.width, w1 = nextRect?.width ?? 0;
    tb.style.tableLayout = "fixed";
    (first.cells[idx] as HTMLElement).style.width = w0 + "px";
    if (nextCell) nextCell.style.width = w1 + "px"; // 固定右邻宽，拖动只伸缩本列+压缩右邻
    e.preventDefault();
    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX;
      const nw = Math.max(30, w0 + dx);
      (first.cells[idx] as HTMLElement).style.width = nw + "px";
      if (nextCell) nextCell.style.width = Math.max(30, w1 - dx) + "px";
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const widths = [...first.cells].map((c) => Math.round((c as HTMLElement).getBoundingClientRect().width));
      const all = colwAll();
      const k = docKeyOf();
      all[k] = all[k] || {};
      all[k][tableSig(tb)] = widths;
      try { localStorage.setItem(COLW_KEY, JSON.stringify(all)); } catch { /* 存储禁用则仅本会话 */ }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/** v0.3.12 大纲侧栏可拖宽（参考 Word 导航窗格）：右缘 5px 近缘拖动，clamp [180, 520]
 *  且不超过视口一半，宽度持久化 localStorage。面板为静态元素只挂一次。 */
const OUTLINE_W_KEY = "mded-outline-w-v2"; // v2：默认宽改 180（用户要最窄起步），v1 旧宽值作废
const OUTLINE_W_MIN = 180, OUTLINE_W_MAX = 520;
function initOutlineResize(): void {
  const panel = document.getElementById("outline-panel");
  const gutter = document.getElementById("side-gutter");
  if (!panel || !gutter) return;
  const clamp = (w: number): number =>
    Math.min(OUTLINE_W_MAX, Math.max(OUTLINE_W_MIN, Math.min(w, Math.floor(window.innerWidth / 2))));
  try {
    const saved = parseInt(localStorage.getItem(OUTLINE_W_KEY) || "", 10);
    if (!isNaN(saved)) panel.style.width = clamp(saved) + "px";
  } catch { /* 存储禁用则用 CSS 默认宽 */ }
  // v0.3.15：事件挂独立把手（不再用面板近缘判定）——大纲/文件列表内容溢出时右缘被
  // 原生滚动条占据，真机 mousedown 被滚动条消费=拖不动（CDP e2e 看不见非 DOM 层测不到）
  gutter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    gutter.classList.add("dragging");
    const startX = e.clientX, w0 = panel.getBoundingClientRect().width;
    const onMove = (ev: MouseEvent): void => {
      panel.style.width = clamp(w0 + (ev.clientX - startX)) + "px";
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      gutter.classList.remove("dragging");
      try { localStorage.setItem(OUTLINE_W_KEY, String(Math.round(panel.getBoundingClientRect().width))); } catch { /* 存储禁用则仅本会话 */ }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/** 统一取"干净"md 源码：wysiwyg 显示层换算会把 img src 写成 asset URL（DOM 序列化污染），
 *  保存/导出/查找前还原为可移植相对路径。全部 getValue 调用点统一走此函数（单一出口）。 */
function mdValue(): string {
  if (!vditor) return "";
  const v = (vditor as { getValue(): string }).getValue(); // 间接调用防下方全局替换误伤自身
  if (!v.includes("asset.localhost")) return v;
  const doc = activeDoc();
  const dir = doc?.path ? doc.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "") : null;
  // `![alt](http://asset.localhost/F%3A/dir/x.png)` 与 `<img src="http://asset.localhost/...">`
  return v.replace(/(\]\(|src=")(?:https?:)?\/\/asset\.localhost\/([^)"\s]+)/g, (m, p1: string, enc: string) => {
    try {
      const abs = decodeURIComponent(enc).replace(/\/$/, "");
      let rel = abs;
      if (dir && abs.toLowerCase().startsWith(dir.toLowerCase() + "/")) rel = abs.slice(dir.length + 1);
      // 空格/括号会破坏 md 链接语法，按需转义；中文路径保持原样（与插入时形态一致）
      return p1 + rel.replace(/([ ()])/g, (c) => ({ " ": "%20", "(": "%28", ")": "%29" }[c] as string));
    } catch { return m; }
  });
}

/** 本地脚本按需加载（/vditor-assets 同源，符合 CSP；去重缓存）。导出渲染 math/mermaid 用 */
const _loadedScripts = new Map<string, Promise<void>>();
function loadLocalScript(src: string): Promise<void> {
  let p = _loadedScripts.get(src);
  if (!p) {
    p = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error("load " + src));
      document.head.appendChild(s);
    });
    _loadedScripts.set(src, p);
  }
  return p;
}

/** v0.3.8（P1#1 修复）：导出片段内 math/mermaid 块就地渲染。
 * 背景：getHTML 对 $$..$$/```mermaid 块保留源码语义（<div class="language-math">tex</div>），
 * 导出的 HTML/PDF/PNG 里公式是纯文本、图表是代码块——编辑器里正常、交付物里丢了。
 * 这里在导出前把块渲染掉：math 走 KaTeX（与 Vditor 同源本地库），mermaid 走 mermaid.render。
 * mathOutput: "html"=HTML+MathML 双输出（带样式档/PDF/PNG，katex css 已入导出模板）；
 *             "mathml"=纯 MathML（纯净档无 CSS，浏览器原生渲染零依赖）。
 * 任一环节失败降级保源文本，不阻断导出。 */
/** v0.3.24 mermaid 渲染器最小形态（两条导出管线共用） */
type MmRenderer = { initialize: (o: object) => void; render: (id: string, code: string) => Promise<{ svg: string }> };
/** mermaid SVG 字符串 → 自然像素尺寸（viewBox 优先，width/height 兜底） */
function mmSvgSize(svg: string): { w: number; h: number } {
  try {
    const el = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
    const vb = (el.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    const w = vb.length === 4 && vb[2] > 0 ? vb[2] : parseFloat(el.getAttribute("width") || "") || 0;
    const h = vb.length === 4 && vb[3] > 0 ? vb[3] : parseFloat(el.getAttribute("height") || "") || 0;
    return { w, h };
  } catch { return { w: 0, h: 0 }; }
}
/** v0.3.24 第四轮：超宽 mermaid 导出自动转竖排。
 * LR/RL 全景图（样本 3596px 宽）压进 A4 内容区只剩 ~15% 缩放，图在但文字不可读=没修。
 * 这里在导出副本上把方向声明 LR/RL→TB 重渲染（不动用户源文件），两版里选放进 A4
 * 内容区（550×933px@96dpi，与 DOCX MAXW 同基准）后缩放比例更高的那个；TB 只在明显
 * 更优（>1.15×）时才采用，防止微幅抖动导致布局来回切。任一环节失败保原方向。 */
const MM_DIR_RE = /^(\s*(?:flowchart|graph)\s+)(LR|RL)(?=\s)/m;
const MM_FIT_W = 550, MM_FIT_H = 933;
async function pickExportMermaidSvg(mermaid: MmRenderer, code: string, idBase: string): Promise<string | null> {
  let best: { svg: string; scale: number } | null = null;
  try {
    const { svg } = await mermaid.render(idBase + "-a", code);
    const { w, h } = mmSvgSize(svg);
    if (w && h) best = { svg, scale: Math.min(MM_FIT_W / w, MM_FIT_H / h) };
  } catch { return null; }
  if (best && MM_DIR_RE.test(code)) {
    try {
      const { svg } = await mermaid.render(idBase + "-b", code.replace(MM_DIR_RE, "$1TB "));
      const { w, h } = mmSvgSize(svg);
      if (w && h) {
        const scale = Math.min(MM_FIT_W / w, MM_FIT_H / h);
        if (best && scale > best.scale * 1.15) best = { svg, scale };
      }
    } catch { /* TB 重渲染失败保原方向 */ }
  }
  return best ? best.svg : null;
}

async function renderSpecialBlocks(root: HTMLElement, mathOutput: "html" | "mathml"): Promise<void> {
  const maths = [...root.querySelectorAll<HTMLElement>(".language-math")];
  if (maths.length) {
    try {
      await loadLocalScript("/vditor-assets/dist/js/katex/katex.min.js");
      const katex = (window as unknown as { katex?: { render: (tex: string, el: HTMLElement, o: object) => void } }).katex;
      if (katex) {
        for (const el of maths) {
          const tex = (el.textContent || "").trim();
          if (!tex) continue;
          const out = document.createElement("div");
          out.className = "export-math";
          try { katex.render(tex, out, { displayMode: true, throwOnError: false, output: mathOutput }); el.replaceWith(out); }
          catch { /* 单块语法错保源文本 */ }
        }
      }
    } catch { /* 库加载失败保源文本（降级不阻断导出） */ }
  }
  const mms = [...root.querySelectorAll<HTMLElement>(".language-mermaid")];
  if (mms.length) {
    try {
      await loadLocalScript("/vditor-assets/dist/js/mermaid/mermaid.min.js");
      const mermaid = (window as unknown as { mermaid?: { initialize: (o: object) => void; render: (id: string, code: string) => Promise<{ svg: string }> } }).mermaid;
      if (mermaid) {
        // v0.3.24 htmlLabels:false 与 DOCX 嵌图路径（renderMermaidPng）统一初始化——
        // mermaid.initialize 是全局合并配置，两路形态不一致会互相覆盖；纯 <text> 标签
        // 也让 SVG 经 <img> 光栅化可成像（foreignObject 限制，见 renderMermaidPng 注释）
        mermaid.initialize({ startOnLoad: false, securityLevel: "loose", htmlLabels: false, flowchart: { htmlLabels: false } });
        for (let i = 0; i < mms.length; i++) {
          const code = (mms[i].textContent || "").trim();
          if (!code) continue;
          // 超宽 LR/RL 图转 TB 竖排（HTML/PDF 管线，pickExportMermaidSvg 注释）
          try { const svg = await pickExportMermaidSvg(mermaid as MmRenderer, code, "export-mm-" + Date.now() + "-" + i); if (svg) mms[i].innerHTML = svg; }
          catch { /* 单图渲染错保源码 */ }
        }
      }
    } catch { /* 同上 */ }
  }
}

/** v0.3.24 mermaid 源码 → PNG（字节 + viewBox 原始尺寸），导出 DOCX 嵌图用。
 * 路线：mermaid.render 出 SVG → DOMParser 副本上设显式像素宽高 → <img> 载入 →
 * canvas 2x 白底光栅化（Word 里放大查看不糊；透明底在 Word 深色模式会糊成黑块）。
 * 关键：initialize 必须关 htmlLabels——SVG 内的 foreignObject 经 <img> 光栅化时
 * Chromium 不渲染（安全限制），纯 <text> 才能成像。
 * 任一环节失败返回 null，调用方降级保源码文本。 */
async function renderMermaidPng(code: string, seq: number): Promise<{ data: Uint8Array; w: number; h: number } | null> {
  try {
    await loadLocalScript("/vditor-assets/dist/js/mermaid/mermaid.min.js");
    const mermaid = (window as unknown as { mermaid?: { initialize: (o: object) => void; render: (id: string, code: string) => Promise<{ svg: string }> } }).mermaid;
    if (!mermaid) return null;
    mermaid.initialize({ startOnLoad: false, securityLevel: "loose", htmlLabels: false, flowchart: { htmlLabels: false } });
    // 超宽 LR/RL 图先经 pickExportMermaidSvg 选型（可能已在 TB 副本上重渲染）
    const svgPicked = await pickExportMermaidSvg(mermaid as MmRenderer, code, "docx-mm-" + seq);
    if (!svgPicked) return null;
    const docXml = new DOMParser().parseFromString(svgPicked, "image/svg+xml");
    const svgEl = docXml.documentElement;
    // 自然尺寸以 viewBox 为准（mermaid 必带）；width/style 只作 fallback
    const vb = (svgEl.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    let w = vb.length === 4 && vb[2] > 0 ? vb[2] : parseFloat(svgEl.getAttribute("width") || "") || 0;
    let h = vb.length === 4 && vb[3] > 0 ? vb[3] : parseFloat(svgEl.getAttribute("height") || "") || 0;
    if (!w || !h) return null;
    const RASTER = 2;
    const cw = Math.min(6000, Math.ceil(w * RASTER)), ch = Math.min(6000, Math.ceil(h * RASTER));
    svgEl.setAttribute("width", String(cw));
    svgEl.setAttribute("height", String(ch));
    svgEl.removeAttribute("style"); // 去 max-width:100% 限制，显式像素宽生效
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svgEl)], { type: "image/svg+xml;charset=utf-8" }));
    try {
      const img = new Image();
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("svg load")); img.src = url; });
      const canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
      if (!blob) return null;
      return { data: new Uint8Array(await blob.arrayBuffer()), w, h };
    } finally { URL.revokeObjectURL(url); }
  } catch { /* 降级源码文本 */ return null; }
}

/** 导出片段（HTML 两档/PNG/PDF 公共管线：getHTML + 相对图片解析 + math/mermaid 渲染），失败返回 null */
async function exportFragment(mathOutput: "html" | "mathml" = "html"): Promise<string | null> {
  const doc = activeDoc();
  if (!doc || !vditor) { showToast(t("exportNoDoc"), "info"); return null; }
  let fragmentHtml = "";
  try { fragmentHtml = vditor.getHTML(); } catch (e) { showToast(t("exportFail") + e, "danger"); return null; }
  if (!fragmentHtml) { showToast(t("exportNoDoc"), "info"); return null; }
  const tmp = document.createElement("div");
  tmp.innerHTML = fragmentHtml;
  resolveImageSources(tmp, doc.path);
  applyTableColWeights(tmp); // v0.3.24 按内容权重设首行百分比列宽（fixed 布局基准）
  applyExportWidths(tmp); // v0.3.11 编辑器内拖定的列宽同步进导出物（px 覆盖百分比）
  await renderSpecialBlocks(tmp, mathOutput);
  return tmp.innerHTML;
}

async function pickExportPath(ext: string, filterName: string): Promise<string | null> {
  const doc = activeDoc();
  const baseName = (doc?.name || t("untitled")).replace(/\.[^.]+$/, "");
  // e2e 自测模式（--export-selftest <dir>）：跳过原生对话框直接拼路径，与生产同代码路径
  try {
    const dir = await invoke<string | null>("export_selftest_dir");
    if (dir) return dir.replace(/[\\/]+$/, "") + "/" + baseName + ext;
  } catch { /* 正常启动 */ }
  const sp = await saveDialog({
    defaultPath: baseName + ext,
    filters: [{ name: filterName, extensions: [ext.slice(1)] }],
  });
  return sp ? (sp as string) : null;
}

/** HTML 导出：带样式档=完整排版（与 PDF 同模板）；纯净档=裸 fragment 无 CSS（公式用 MathML 零依赖渲染） */
async function exportHtml(styled: boolean): Promise<void> {
  const frag = await exportFragment(styled ? "html" : "mathml");
  if (!frag) return;
  const path = await pickExportPath(".html", "HTML");
  if (!path) return;
  const langAttr = currentLang === "en" ? "en" : currentLang === "zh-TW" ? "zh-TW" : "zh-CN";
  const html = styled ? wrapExportHtml(frag)
    : `<!DOCTYPE html>\n<html lang="${langAttr}">\n<head><meta charset="UTF-8"></head>\n<body>\n${frag}\n</body>\n</html>\n`;
  try {
    await invoke("write_export_file", { path, content: html });
    showToast(t("exportDone") + path, "success");
  } catch (e) { showToast(t("exportFail") + e, "danger"); }
}

/** 图片长图：离屏容器渲染 → html2canvas → PNG。超 canvas 上限自动分片（Typora 官方做不到的差异化点） */
async function exportImagePng(): Promise<void> {
  const frag = await exportFragment("html");
  if (!frag) return;
  const path = await pickExportPath(".png", "PNG");
  if (!path) return;
  const overlay = document.getElementById("export-overlay");
  const msg = document.getElementById("export-msg");
  if (overlay) { (document.getElementById("export-pct") as HTMLElement).style.width = "10%"; msg!.textContent = "Rendering…"; overlay.hidden = false; }
  try {
    const { default: html2canvas } = await import("html2canvas");
    const holder = document.createElement("div");
    holder.className = "vditor-reset";
    holder.style.cssText = "position:fixed;left:-20000px;top:0;width:820px;background:#fff;padding:24px 32px;";
    holder.innerHTML = wrapExportHtml(frag)
      .replace(/^[\s\S]*?<body[^>]*>/, "").replace(/<\/body>[\s\S]*$/, ""); // 取 body 内（样式已在 wrap 的 <style>，需带入）
    const styleEl = document.createElement("style");
    styleEl.textContent = wrapExportHtml("").match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
    holder.prepend(styleEl);
    document.body.appendChild(holder);
    const canvas = await html2canvas(holder, { scale: 2, backgroundColor: "#ffffff", logging: false, useCORS: true });
    holder.remove();
    if (overlay) (document.getElementById("export-pct") as HTMLElement).style.width = "70%";
    // canvas 单边上限 32767；超高分片导出 name_pageN.png
    const MAXH = 30000;
    const slices: string[] = [];
    if (canvas.height <= MAXH) {
      slices.push(canvas.toDataURL("image/png"));
    } else {
      const n = Math.ceil(canvas.height / MAXH);
      for (let i = 0; i < n; i++) {
        const c = document.createElement("canvas");
        c.width = canvas.width; c.height = Math.min(MAXH, canvas.height - i * MAXH);
        c.getContext("2d")!.drawImage(canvas, 0, -i * MAXH);
        slices.push(c.toDataURL("image/png"));
      }
    }
    const base = path.replace(/\.png$/i, "");
    for (let i = 0; i < slices.length; i++) {
      const p = slices.length === 1 ? path : `${base}_page${i + 1}.png`;
      await invoke("save_binary_file", { path: p, dataB64: slices[i].split(",")[1] });
    }
    if (overlay) (document.getElementById("export-pct") as HTMLElement).style.width = "100%";
    showToast(slices.length === 1 ? t("exportDone") + path : t("exportImageSlices") + slices.length + " 张", "success");
  } catch (e) {
    showToast(t("exportFail") + e, "danger");
  } finally {
    if (overlay) overlay.hidden = true;
  }
}

/** v0.3.9 打印正文：内容与导出同管线（公式/图表渲染、图片 file:// 解析、A4 模板样式）备进
 * #print-root（屏幕藏视口外），打印态只留它；再走 Rust ShowPrintUI 弹系统打印预览
 * （WebView2 的 window.print() 被静默忽略——宿主负责打印，实测无任何窗口）。
 * 模板 CSS 整体包 @media print 注入：屏幕零扰动，打印布局与 PDF 导出一致（含 @page A4）。
 * 预览窗口关闭后 WebView 发 afterprint 清理；兜底 120s（打印引擎不发事件的极端情况）。 */
let printingCleanupTimer = 0;
function cleanupPrintRoot(): void {
  document.getElementById("print-root")?.remove();
  if (printingCleanupTimer) { window.clearTimeout(printingCleanupTimer); printingCleanupTimer = 0; }
}

// ===== v0.3.11 版本历史：列表+预览+恢复（恢复=载入编辑器并标 dirty，不直接写盘——用户确认后 Ctrl+S） =====
let histSelected = "";
function fmtHistTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
async function openHistory(): Promise<void> {
  const doc = activeDoc();
  const modal = document.getElementById("history-modal") as HTMLElement;
  const list = document.getElementById("hist-list") as HTMLUListElement;
  const preview = document.getElementById("hist-preview") as HTMLPreElement;
  const restoreBtn = document.getElementById("hist-restore") as HTMLButtonElement;
  if (!doc?.path) { showToast(t("histNoDoc"), "info"); return; }
  document.getElementById("hist-title")!.textContent = `${doc.name} · ` + t("histTitle");
  list.innerHTML = ""; preview.textContent = t("histPreview"); histSelected = "";
  restoreBtn.disabled = true;
  modal.hidden = false;
  let versions: { file: string; mtimeMs: number; size: number }[] = [];
  try { versions = await invoke("list_versions", { path: doc.path }); }
  catch (e) { showToast(t("histRestoreFail") + e, "danger"); modal.hidden = true; return; }
  if (versions.length === 0) {
    const li = document.createElement("li");
    li.textContent = t("histEmpty");
    li.style.cursor = "default"; li.style.color = "#999";
    list.appendChild(li);
    return;
  }
  versions.forEach((v, i) => {
    const li = document.createElement("li");
    const tm = document.createElement("span");
    tm.textContent = fmtHistTime(v.mtimeMs);
    const sz = document.createElement("span");
    sz.className = "hv-size";
    sz.textContent = (v.size / 1024).toFixed(1) + " KB";
    li.appendChild(tm); li.appendChild(sz);
    li.addEventListener("click", async () => {
      list.querySelectorAll("li").forEach((x) => x.classList.remove("sel"));
      li.classList.add("sel");
      histSelected = v.file;
      restoreBtn.disabled = false;
      try { preview.textContent = (await invoke<string>("read_version", { file: v.file })).slice(0, 2000); }
      catch { preview.textContent = "(…)"; }
    });
    if (i === 0) { // 默认选中最新一版（下一版即当前磁盘内容的前身）
      // 首版不自动选中：恢复是显式动作，误触恢复旧版代价高。仅高亮提示
    }
    list.appendChild(li);
  });
}
function bindHistory(): void {
  document.getElementById("btn-history")!.addEventListener("click", () => { void openHistory(); });
  // v0.3.23 导出诊断包：Rust 收集日志+版本+系统信息写单个 txt（报障从口述复现变带日志自证）
  document.getElementById("btn-diag")!.addEventListener("click", async () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const sp = await saveDialog({
      defaultPath: `md-editor-diagnostics-${stamp}.txt`,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!sp) return;
    try {
      const saved = await invoke<string>("export_diagnostics", { path: sp });
      showToast(t("diagOk") + "  " + saved, "success");
    } catch (e) {
      showToast(t("diagFail") + "  " + e, "danger");
    }
  });
  document.getElementById("hist-close")!.addEventListener("click", () => {
    (document.getElementById("history-modal") as HTMLElement).hidden = true;
  });
  document.getElementById("history-modal")!.addEventListener("pointerdown", (e) => {
    if (e.target === e.currentTarget) (e.currentTarget as HTMLElement).hidden = true; // 点遮罩关闭
  });
  document.getElementById("hist-restore")!.addEventListener("click", async () => {
    if (!histSelected || !vditor) return;
    const doc = activeDoc();
    try {
      const content = await invoke<string>("read_version", { file: histSelected });
      suppressInput = true;
      vditor.setValue(content, true);
      suppressInput = false;
      if (doc) { doc.content = content; doc.dirty = true; updateTitle(); scheduleOutline(); }
      (document.getElementById("history-modal") as HTMLElement).hidden = true;
      showToast(t("histRestored"), "success");
    } catch (e) { showToast(t("histRestoreFail") + e, "danger"); }
  });
}
async function printCurrentDoc(): Promise<void> {
  if (!vditor || exporting) return; // 重入锁：所有入口（工具栏按钮/Ctrl+P）统一，避免打印预览叠加
  const frag = await exportFragment("html");
  if (!frag) return;
  cleanupPrintRoot();
  const root = document.createElement("div");
  root.id = "print-root";
  const css = wrapExportHtml("").match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
  root.innerHTML = `<style>@media print{\n${css}\n}</style><div class="vditor-reset">${frag}</div>`;
  document.body.appendChild(root);
  try {
    await invoke("print_webview");
    window.addEventListener("afterprint", cleanupPrintRoot, { once: true });
    printingCleanupTimer = window.setTimeout(cleanupPrintRoot, 120000);
  } catch (e) {
    cleanupPrintRoot();
    showToast(t("exportFail") + e, "danger");
  }
}

/** 脚注定义抢救：Vditor 所见即所得对复杂文档的 DOM 渲染会丢脚注定义区（内核限制，
 * DOM 即源码架构下 getValue 随之丢失）。导出前从磁盘原文件把缺失的定义拼回 md 尾部——
 * 只读原文件、不回写，导出物脚注完整；未保存的新文档无原文件则尽力。 */
async function rescueFootnoteDefs(md: string, docPath: string | null | undefined): Promise<string> {
  const refs = new Set((md.match(/\[\^([^\]\s]+)\](?!:)/g) || []).map((s) => s.slice(2, -1)));
  const defs = new Set((md.match(/^\[\^([^\]\s]+)\]:/gm) || []).map((s) => s.slice(2, -2)));
  const missing = [...refs].filter((l) => !defs.has(l));
  if (!missing.length || !docPath) return md;
  try {
    const [orig] = await invoke<[string, string]>("open_file", { path: docPath });
    const defLines: string[] = [];
    for (const ln of orig.split("\n")) {
      const m = ln.match(/^\[\^([^\]\s]+)\]:/);
      if (m && missing.includes(m[1])) defLines.push(ln);
    }
    if (defLines.length) return md.replace(/\s*$/, "\n\n") + defLines.join("\n") + "\n";
  } catch { /* 原文件读不到→尽力 */ }
  return md;
}

/** 从图片字节解析宽高+类型（PNG IHDR / JPEG SOF / GIF / BMP 魔数），非图片返回 null */
function imageSize(b: Uint8Array): { w: number; h: number; type: "png" | "jpg" | "gif" | "bmp" } | null {
  if (b.length < 12) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (dv.getUint32(0) === 0x89504e47) return { w: dv.getUint32(16), h: dv.getUint32(20), type: "png" };
    if (dv.getUint32(0) === 0x47494638) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true), type: "gif" };
    if (dv.getUint16(0) === 0x424d && b.length > 26) return { w: Math.abs(dv.getInt32(18, true)), h: Math.abs(dv.getInt32(22, true)), type: "bmp" };
    if (dv.getUint16(0) === 0xffd8) { // JPEG：扫 SOF0-15 段（DHT/DAC/JPG 除外）
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { w: dv.getUint16(i + 7), h: dv.getUint16(i + 5), type: "jpg" };
        }
        i += 2 + dv.getUint16(i + 2);
      }
    }
  } catch { /* 非法头 → null */ }
  return null;
}

/** v0.3.24 视觉宽度：CJK/全角字符计 2、其余计 1——表格列宽按内容权重分配的度量 */
function visualLen(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return n;
}

/** v0.3.24 列宽分配：weights（各列内容视觉宽度）→ 总宽 total DXA/百分比基准。
 * 按权重比例分，单列最小 total*7% 防压扁，尾差吸收进末列；和恒等于 total。
 * DOCX（DXA 像素）与导出 HTML（百分比）两路共用同一算法。 */
function allocColWidths(weights: number[], total: number): number[] {
  const n = Math.max(1, weights.length);
  const w = Array.from({ length: n }, (_, i) => Math.max(weights[i] || 1, 1));
  const min = Math.floor(total * 0.07);
  const sum = w.reduce((a, b) => a + b, 0);
  const widths = w.map((x) => Math.max(min, Math.round(total * x / sum)));
  const wsum = widths.reduce((a, b) => a + b, 0);
  widths[n - 1] += total - wsum; // 尾差吸收（min 抬升后 wsum 可能超 total，负尾差同样成立）
  return widths.map((x) => Math.max(x, 1));
}

/** markdown-it token → docx 元素转换（覆盖：标题/段落/行内样式/链接/嵌套列表(原生numbering)/引用(含嵌套与内嵌列表)/代码块/表格/图片(真嵌入)/脚注/分隔线） */
async function exportDocx(): Promise<void> {
  const doc = activeDoc();
  if (!doc || !vditor) { showToast(t("exportNoDoc"), "info"); return; }
  const md = await rescueFootnoteDefs(mdValue(), doc.path);
  if (!md) { showToast(t("exportNoDoc"), "info"); return; }
  const path = await pickExportPath(".docx", "Word");
  if (!path) return;
  const overlay = document.getElementById("export-overlay");
  if (overlay) { (document.getElementById("export-pct") as HTMLElement).style.width = "20%"; (document.getElementById("export-msg") as HTMLElement).textContent = "DOCX…"; overlay.hidden = false; }
  try {
    const MarkdownIt = (await import("markdown-it")).default;
    const docx = await import("docx");
    const mdit = new MarkdownIt({ html: false, linkify: true });
    mdit.use((await import("markdown-it-footnote")).default);
    const tokens = mdit.parse(md, {});

    const { Paragraph, TextRun, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType, TableLayoutType } = docx;
    const FONT = "Microsoft YaHei";
    const MONO = "Consolas";

    // 预取文档内本地图片（相对路径按文档目录解析）→ 字节+宽高，供 ImageRun 真嵌入；
    // 读不到/非本地 → 降级 [图片:] 占位文本
    const imgCache = new Map<string, { data: Uint8Array; w: number; h: number; type: "png" | "jpg" | "gif" | "bmp" }>();
    const docDir = doc.path ? doc.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "") : "";
    for (const tk of tokens) {
      if (tk.type !== "inline" || !tk.children) continue;
      for (const c of tk.children) {
        if (c.type !== "image") continue;
        const src = String(c.attrGet("src") || "").split("?")[0];
        // v0.3.8（P1#3 修复）：markdown-it 的 normalizeLink 会把非 ASCII 的 src URL 编码
        // （assets/截图_x.png → assets/%E6%88%AA...），磁盘上是中文名 → fs 找不到 → 降级占位丢图。
        // 拼路径前先解码还原原名（编码态与原名都可能出现在 src 里，decode 失败保原样）。
        let srcDec = src;
        try { if (/%[0-9a-f]{2}/i.test(src)) srcDec = decodeURIComponent(src); } catch { srcDec = src; }
        if (!src || /^(https?:|asset:|data:)/i.test(srcDec) || imgCache.has(src)) continue;
        const abs = /^[a-zA-Z]:[\\/]/.test(srcDec) ? srcDec : (docDir ? docDir + "/" + srcDec : "");
        if (!abs) continue;
        try {
          const b64 = await invoke<string>("read_binary_file", { path: abs.replace(/\//g, "\\") });
          const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
          const size = imageSize(bin);
          if (size) imgCache.set(src, { data: bin, w: size.w, h: size.h, type: size.type });
        } catch { /* 降级占位 */ }
      }
    }

    // 递归辅助：从 start 到匹配的 *_close，把行内结果并进 out，返回 close 下标（function 声明提升，inlineRuns 可前向引用）
    function collectInline(toks: any[], start: number, style: any, out: any[]): number {
      const close = `${toks[start - 1].type.replace("_open", "_close")}`;
      let j = start;
      for (; j < toks.length && toks[j].type !== close; j++) { /* 找 close */ }
      out.push(...inlineRuns(toks.slice(start, j), style));
      return j;
    }
    // 行内 token 递归 → TextRun/ExternalHyperlink 数组
    const inlineRuns = (toks: any[], base: { bold?: boolean; italics?: boolean; strike?: boolean; code?: boolean } = {}): any[] => {
      const out: any[] = [];
      for (let i = 0; i < toks.length; i++) {
        const tk = toks[i];
        if (tk.type === "text") {
          out.push(new TextRun({ text: tk.content, bold: base.bold, italics: base.italics, strike: base.strike, font: base.code ? MONO : FONT }));
        } else if (tk.type === "code_inline") {
          out.push(new TextRun({ text: tk.content, font: MONO, color: "C7254E", shading: { type: "clear", fill: "F9F2F4" } }));
        } else if (tk.type === "softbreak" || tk.type === "hardbreak") {
          out.push(new TextRun({ text: " ", font: FONT }));
        } else if (tk.type === "strong_open") i = collectInline(toks, i + 1, { ...base, bold: true }, out);
        else if (tk.type === "em_open") i = collectInline(toks, i + 1, { ...base, italics: true }, out);
        else if (tk.type === "s_open") i = collectInline(toks, i + 1, { ...base, strike: true }, out);
        else if (tk.type === "link_open") {
          const href = tk.attrGet("href") || "";
          let j = i + 1;
          for (; j < toks.length && toks[j].type !== "link_close"; j++) { /* 收集 */ }
          const inner = inlineRuns(toks.slice(i + 1, j), { ...base, bold: true });
          out.push(new ExternalHyperlink({ link: href, children: inner }));
          i = j;
        } else if (tk.type === "image") {
          const src = String(tk.attrGet("src") || "").split("?")[0];
          const img = imgCache.get(src);
          if (img) {
            const MAXW = 550; // A4 可用宽 ~15cm ≈ 550px@96dpi，超出等比缩
            const scale = img.w > MAXW ? MAXW / img.w : 1;
            out.push(new docx.ImageRun({ type: img.type, data: img.data, transformation: { width: Math.round(img.w * scale), height: Math.round(img.h * scale) } }));
          } else {
            out.push(new TextRun({ text: `[图片: ${String(tk.attrGet("src") || "")}]`, font: FONT, italics: true, color: "888888" }));
          }
        } else if (tk.type === "footnote_ref") {
          out.push(new docx.FootnoteReferenceRun(Number(tk.meta?.id ?? 0) + 1));
        }
      }
      return out;
    };

    // 列表 → Word 原生 numbering（导航/继续编号正确；嵌套=独立 reference 各自层级，
    // 修掉旧版"内层列表重置外层 ordered 状态"与符号近似）。每列表一个 reference，
    // start>1 的有序列表把起始号写进 level 定义。
    const blocks: any[] = [];
    const { LevelFormat, AlignmentType } = docx;
    const numberingConfigs: any[] = [];
    let listSeq = 0;
    const listStack: { reference: string; level: number }[] = [];
    // 脚注（markdown-it-footnote）：正文 FootnoteReferenceRun(id+1)，块尾收集定义；
    // docx 要求 key≥1，markdown-it 的 meta.id 从 0 起
    const footnotesMap: Record<string, { children: any[] }> = {};

    // 主循环 inline 驱动：段落内容以 inline token 为真身（markdown-it 对紧凑列表的
    // paragraph_open/close 标 hidden，逐 token 分支会漏——看 open 不看 hidden，见 token 流实测）
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (tk.type === "heading_open") {
        const lvl = parseInt(tk.tag.slice(1), 10);
        const inline = tokens[i + 1];
        blocks.push(new Paragraph({
          heading: ([HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6] as any[])[lvl - 1],
          children: inlineRuns(inline.children || []),
        }));
        i += 2;
      } else if (tk.type === "inline") {
        if (listStack.length > 0) {
          const L = listStack[listStack.length - 1];
          blocks.push(new Paragraph({
            numbering: { reference: L.reference, level: L.level },
            children: inlineRuns(tk.children || []),
            spacing: { after: 60 },
          }));
        } else {
          blocks.push(new Paragraph({ children: inlineRuns(tk.children || []), spacing: { after: 120 } }));
        }
      } else if (tk.type === "bullet_list_open" || tk.type === "ordered_list_open") {
        const ordered = tk.type === "ordered_list_open";
        const depth = listStack.length; // 0-based 嵌套层级
        const reference = `mdl${++listSeq}`;
        const start = parseInt(String(tk.attrGet("start") || "1"), 10) || 1;
        numberingConfigs.push({
          reference,
          levels: [{
            level: depth,
            format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
            text: ordered ? "%1." : ["•", "◦", "▪", "·"][Math.min(depth, 3)],
            alignment: AlignmentType.START,
            ...(ordered && start > 1 ? { start } : {}),
            style: { paragraph: { indent: { left: 480 * (depth + 1), hanging: ordered ? 360 : 280 } } },
          }],
        });
        listStack.push({ reference, level: depth });
      } else if (tk.type === "list_item_open") {
        /* 计号交给 Word numbering */
      } else if (tk.type === "bullet_list_close" || tk.type === "ordered_list_close") {
        listStack.pop();
      } else if (tk.type === "blockquote_open") {
        // 整块扫到配对 close（depth 从 1 起算=含自身）：嵌套引用按深度缩进；
        // 引用内列表用文本 marker 近似；段落同样以 inline 为真身
        let depth = 1; let j = i + 1;
        let bqListDepth = 0; let bqOrdered = false; let bqIdx = 0;
        for (; j < tokens.length; j++) {
          const t2 = tokens[j];
          if (t2.type === "blockquote_open") depth++;
          else if (t2.type === "blockquote_close") { depth--; if (depth === 0) break; }
          else if (t2.type === "bullet_list_open" || t2.type === "ordered_list_open") { bqOrdered = t2.type === "ordered_list_open"; bqIdx = 0; bqListDepth++; }
          else if (t2.type === "bullet_list_close" || t2.type === "ordered_list_close") bqListDepth = Math.max(0, bqListDepth - 1);
          else if (t2.type === "list_item_open") bqIdx++;
          else if (t2.type === "inline") {
            const marker = bqListDepth > 0 ? (bqOrdered ? `${bqIdx}. ` : "• ") : "";
            blocks.push(new Paragraph({
              children: [new TextRun({ text: marker, font: FONT, italics: true }), ...inlineRuns(t2.children || [], { italics: true })],
              indent: { left: 480 * depth }, spacing: { after: 100 },
            }));
          }
        }
        i = j;
      } else if (tk.type === "footnote_block_open") {
        // 收集脚注定义到 footnotesMap，不再进正文
        let j = i + 1; let curId = -1; let curRuns: any[] = [];
        const flushFn = () => {
          if (curId >= 0 && curRuns.length) footnotesMap[String(curId + 1)] = { children: [new Paragraph({ children: curRuns })] };
          curRuns = [];
        };
        for (; j < tokens.length && tokens[j].type !== "footnote_block_close"; j++) {
          const t2 = tokens[j];
          if (t2.type === "footnote_open") { flushFn(); curId = Number(t2.meta?.id ?? -1); }
          else if (t2.type === "inline") curRuns.push(...inlineRuns(t2.children || []));
        }
        flushFn();
        i = j;
      } else if (tk.type === "fence" && /mermaid/i.test(tk.info || "")) {
        // v0.3.24：mermaid 块渲染为 PNG 嵌入（此前走 fence 代码文本，Word 里丢图——
        // 编辑器里好看、交付物里没有，正是用户报的缺口）。失败降级保源码文本不阻断导出。
        const png = await renderMermaidPng(tk.content || "", blocks.length);
        if (png) {
          // v0.3.24：宽高双向约束（A4 可用 550×933px@96dpi，与 pickExportMermaidSvg 同基准）——
          // TB 竖排重排后的图可能超页高，只限宽会溢出页底
          const scale = Math.min(550 / png.w, 933 / png.h, 1);
          blocks.push(new Paragraph({
            children: [new docx.ImageRun({ type: "png", data: png.data, transformation: { width: Math.round(png.w * scale), height: Math.round(png.h * scale) } })],
            alignment: AlignmentType.CENTER,
            spacing: { before: 120, after: 120 },
          }));
        } else {
          const lines = (tk.content || "").split("\n");
          blocks.push(new Paragraph({
            children: lines.map((ln: string, k: number) => new TextRun({ text: (k ? "\n" : "") + ln, font: MONO, size: 18, color: "333333", shading: { type: "clear", fill: "F5F5F5" } })),
            spacing: { before: 80, after: 80 },
          }));
        }
      } else if (tk.type === "fence" || tk.type === "code_block") {
        const lines = (tk.content || "").split("\n");
        blocks.push(new Paragraph({
          children: lines.map((ln: string, k: number) => new TextRun({ text: (k ? "\n" : "") + ln, font: MONO, size: 18, color: "333333", shading: { type: "clear", fill: "F5F5F5" } })),
          spacing: { before: 80, after: 80 },
        }));
      } else if (tk.type === "hr") {
        blocks.push(new Paragraph({ text: "", border: { bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: "CCCCCC" } }, spacing: { after: 120 } }));
      } else if (tk.type === "table_open") {
        // v0.3.24 宽表修复：旧实现 cell 宽 = 9000/(已闭合格数+1) 是行内累积——同行
        // 9000/4500/3000/2250 递减，整行总宽 18750 DXA≈33cm >> A4 竖版可用 ~9026，
        // 右列被推出页面（用户导出"表格看不全"根因）；且未写 columnWidths，tblGrid 全 100 假值。
        // 新法：先预扫全表拿列数 + 每列最长单元格的视觉宽度权重，按比例分 9000 DXA
        // （单列最小 7% 防压扁），FIXED 布局 + columnWidths 写实 tblGrid，长文本在格内换行。
        let j = i + 1;
        const rowCells: { inline: any[]; isHead: boolean }[][] = [];
        const colWeight: number[] = [];
        let curRow: { inline: any[]; isHead: boolean }[] = []; let curInline: any[] = [];
        let nCols = 0;
        for (; j < tokens.length && tokens[j].type !== "table_close"; j++) {
          const tt = tokens[j];
          if (tt.type === "tr_open") { curRow = []; }
          else if (tt.type === "th_open" || tt.type === "td_open") { curInline = []; }
          else if (tt.type === "inline") curInline = tt.children || [];
          else if (tt.type === "th_close" || tt.type === "td_close") {
            const isHead = tt.type === "th_close";
            curRow.push({ inline: curInline, isHead });
            const wgt = curInline.reduce((s, c) => s + visualLen(String(c.content || "")), 0);
            const ci = curRow.length - 1;
            colWeight[ci] = Math.max(colWeight[ci] || 0, wgt, 1);
          } else if (tt.type === "tr_close") { rowCells.push(curRow); nCols = Math.max(nCols, curRow.length); }
        }
        const widths = allocColWidths(colWeight.slice(0, nCols), 9000);
        const rows = rowCells.map((r) => r.map((cell, ci) => new TableCell({
          width: { size: widths[Math.min(ci, nCols - 1)], type: WidthType.DXA },
          shading: cell.isHead ? { type: "clear", fill: "EEEEEE" } : undefined,
          children: [new Paragraph({ children: inlineRuns(cell.inline, { bold: cell.isHead }) })],
        }))).map((cells, ri) => new TableRow({ children: cells, ...(ri === 0 ? { tableHeader: true } : {}) }));
        // ^ v0.3.24：首行 tableHeader——跨页续表自动重复表头（PDF 侧 Chrome 断页自带 thead
        // 重复，Word 必须显式声明；视觉终验发现漏配则 Word 续表裸行无列名）
        blocks.push(new Table({ width: { size: 9000, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, rows }));
        blocks.push(new Paragraph({ text: "" }));
        i = j;
      } else if (tk.type === "inline") {
        // 顶层图片段落（paragraph 已覆盖；此处兜底顶层 inline）
      }
    }
    if (overlay) (document.getElementById("export-pct") as HTMLElement).style.width = "80%";
    const d = new docx.Document({
      ...(Object.keys(footnotesMap).length ? { footnotes: footnotesMap } : {}),
      ...(numberingConfigs.length ? { numbering: { config: numberingConfigs } } : {}),
      sections: [{ children: blocks }],
    });
    const blob = await docx.Packer.toBlob(d);
    const b64 = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve((fr.result as string).split(",")[1]);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
    await invoke("save_binary_file", { path, dataB64: b64 });
    if (overlay) (document.getElementById("export-pct") as HTMLElement).style.width = "100%";
    showToast(t("exportDone") + path, "success");
  } catch (e) {
    showToast(t("exportFail") + e, "danger");
  } finally {
    if (overlay) overlay.hidden = true;
  }
}

// v0.4.0 文件/视图菜单：Word/Typora 式编排（低频进菜单、高频直出）。
// 转发原则——菜单项 click → 既有按钮 click / 既有函数，本函数零业务逻辑。
function bindFileViewMenus(): void {
  const closeBoth = () => {
    document.getElementById("file-menu")!.hidden = true;
    document.getElementById("view-menu")!.hidden = true;
  };
  // 两个菜单头：互斥开关
  for (const [btnId, menuId, wrapId] of [
    ["btn-file-menu", "file-menu", "file-wrap"],
    ["btn-view-menu", "view-menu", "view-wrap"],
  ] as const) {
    document.getElementById(btnId)!.addEventListener("click", (e) => {
      e.stopPropagation();
      closeBoth();
      const m = document.getElementById(menuId)!;
      m.hidden = false;
      void wrapId; // 结构对称保留（定位由 CSS 完成）
    });
  }
  // 点外部关闭
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Element | null;
    if (!t?.closest?.("#file-wrap, #view-wrap")) closeBoth();
  });
  // 选中即关（冒泡到容器统一收起，转发 handler 先行）
  for (const mid of ["file-menu", "view-menu"]) {
    document.getElementById(mid)?.addEventListener("click", () => {
      document.getElementById(mid)!.hidden = true;
    });
  }
  // —— 文件菜单：全部转发既有按钮 ——
  const fwd = (id: string, targetId: string) => {
    document.getElementById(id)?.addEventListener("click", () => {
      (document.getElementById(targetId) as HTMLButtonElement | null)?.click();
    });
  };
  fwd("fm-open", "btn-open"); fwd("fm-save", "btn-save"); fwd("fm-history", "btn-history");
  fwd("fm-print", "btn-print"); fwd("fm-diag", "btn-diag");
  const fwdSel = (id: string, sel: string) => {
    document.getElementById(id)?.addEventListener("click", () => {
      (document.querySelector(sel) as HTMLButtonElement | null)?.click();
    });
  };
  fwdSel("fm-export-pdf", '#export-menu button[data-export="pdf"]');
  fwdSel("fm-export-html", '#export-menu button[data-export="html"]');
  fwdSel("fm-export-html-plain", '#export-menu button[data-export="html-plain"]');
  fwdSel("fm-export-image", '#export-menu button[data-export="image"]');
  fwdSel("fm-export-docx", '#export-menu button[data-export="docx"]');
  // —— 视图菜单：转发按钮 + 直调开关函数 ——
  fwd("vm-focus", "btn-focus-mode");
  fwd("vm-mode", "btn-mode");
  document.getElementById("vm-reading")?.addEventListener("click", () => setReadingFocus(!readingFocusOn));
  document.getElementById("vm-side")?.addEventListener("click", () => setSideCollapsed(!sideCollapsed));
  document.getElementById("vm-cmdk")?.addEventListener("click", () => toggleCmdk());
  document.getElementById("vm-qopen")?.addEventListener("click", () => openQuickOpen());
}

function bindExportMenu(): void {
  const btn = document.getElementById("btn-export")!;
  const menu = document.getElementById("export-menu")!;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  menu.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest("button[data-export]") as HTMLButtonElement | null;
    if (!item || item.disabled) return;
    menu.hidden = true;
    // v0.3.8（P2 修复）：空文档导出前确认——原行为静默产出空白 PDF，用户可能误发空文件。
    // 欢迎文档/清空未写状态都是空；确认后才继续（e2e dialog handler accept 同样覆盖）。
    const curVal = vditor?.getValue()?.trim();
    if (!curVal && !confirm(t("exportEmptyConfirm"))) return;
    const kind = item.dataset.export;
    if (kind === "pdf") exportPdf();
    else if (kind === "html") exportHtml(true);
    else if (kind === "html-plain") exportHtml(false);
    else if (kind === "image") exportImagePng();
    else if (kind === "docx") exportDocx();
  });
  // v0.3.21 打印独立成工具栏按钮（用户反馈：放"导出"菜单里语义怪——导出=生成文件，打印=送打印机）
  document.getElementById("btn-print")!.addEventListener("click", () => {
    // 与导出菜单项同款守卫：空文档先确认（防误打白纸），重入锁在 printCurrentDoc 内部 exporting
    const curVal = vditor?.getValue()?.trim();
    if (!curVal && !confirm(t("exportEmptyConfirm"))) return;
    printCurrentDoc();
  });
  // 点外部收起（capture，与查找条同模式；排除导出按钮自身）；Esc 同关（浮层统一交互）
  document.addEventListener("pointerdown", (e) => {
    if (menu.hidden) return;
    if (e.target instanceof Node && (menu.contains(e.target) || btn.contains(e.target))) return;
    menu.hidden = true;
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) { e.preventDefault(); menu.hidden = true; }
  });
}

// 导出当前文档为 PDF：取 Vditor 渲染 HTML → 解析相对图片 → 包装完整文档 → 交 Rust 端
// msedge --headless --print-to-pdf 生成矢量 PDF（文本可选可搜、Chromium 原生分页、无 canvas 上限）。
// 取代旧的 html2pdf.js（离屏容器 left:-99999px 致 html2canvas 渲染空白=白纸，且 ~32767px canvas 上限截断长文）。
async function exportPdf() {
  if (!vditor || exporting) return;   // 重入锁：导出进行中(msedge 打印 1-3s)的 Ctrl+P/重复点击直接忽略
  const doc = activeDoc();
  if (!doc) { showToast(t("exportNoDoc"), "info"); return; }
  // 先把当前编辑器实时内容回写 doc（与保存一致，getValue 空读守卫：空值不覆盖）
  const v = mdValue();
  if (v !== "" || doc.content === "") doc.content = v;

  // 取渲染后 HTML 片段（getHTML 在某些异常态可能抛错，try/catch 兜底）；v0.3.8 起含 math/mermaid 渲染
  const fragHtml = await exportFragment("html");
  if (!fragHtml) return;
  const fullHtml = wrapExportHtml(fragHtml);

  // 选保存路径（默认文件名 = 文档名.pdf）。重入锁覆盖 saveDialog→导出完成全程：saveDialog
  // 关闭到设锁之间存在极小时间窗，连点导出可能在窗口内二次进入，提前上锁闭合。exporting 的
  // 释放统一在 finally（取消/成功/异常三路必经 finally），杜绝锁泄漏。finally 引用的
  // overlay/unlisten/est 必须先于 try 声明——取消分支会在赋值前 return（此时 unlisten=null、
  // overlay=hidden、est=null），故均按 null-safe 处理。

  // 进度遮罩：Rust 在可观测步骤(page/printing/saving)推真百分比；引擎打印为黑盒子段，
  // 由前端估算曲线平滑逼近 90%（永不超 90），真完成 invoke resolve 时才跳 100%——诚实，不伪造完成。
  const overlay = document.getElementById("export-overlay");
  const exportMsg = document.getElementById("export-msg");
  const bar = document.getElementById("export-progress-bar");
  const pctEl = document.getElementById("export-pct");
  const setPct = (p: number) => {
    if (bar) (bar as HTMLElement).style.width = p + "%";
    if (pctEl) pctEl.textContent = Math.round(p) + "%";
  };

  // 估算曲线：仅 printing 黑盒段启用，每 120ms 按 cur += (90-cur)*0.12 指数衰减逼近 90。
  let est: number | null = null;
  let cur = 0;
  const stopEst = () => { if (est !== null) { clearInterval(est); est = null; } };
  const startEst = (from: number) => {
    stopEst();
    cur = from;
    est = window.setInterval(() => { cur += (90 - cur) * 0.12; setPct(cur); }, 120);
  };

  let unlisten: (() => void) | null = null;
  let done = false; // 完成标志：invoke resolve 后置 true，阻止迟到的 saving 事件把 100% 倒退回 95%
  let resultMsg = "";
  let resultOk = true;
  try {
    exporting = true;
    // 统一走 pickExportPath：生产弹原生保存对话框；e2e（--export-selftest）直拼路径。
    // 旧实现直接 saveDialog——无头 e2e 环境对话框无人点击，await 永不返回，PDF 项根本测不到。
    const savePath = await pickExportPath(".pdf", "PDF");
    if (!savePath) { return; } // 用户取消：exporting 由 finally 释放（overlay 仍 hidden、unlisten 仍 null）

    if (overlay) overlay.hidden = false;
    setPct(5);
    if (exportMsg) exportMsg.textContent = t("exportStagePage");

    unlisten = await listen<[string, number]>("export-pdf-progress", (e) => {
      if (done) return; // 已完成：忽略迟到的 saving 事件，避免 100→95 倒退
      const [stage, pct] = e.payload;
      stopEst();
      setPct(pct);
      if (stage === "printing") {
        if (exportMsg) exportMsg.textContent = t("exportStagePrint");
        startEst(pct);                     // 黑盒段：估算逼近 90，真完成由 resolve 接管
      } else if (stage === "page") {
        if (exportMsg) exportMsg.textContent = t("exportStagePage");
      } else if (stage === "saving") {
        if (exportMsg) exportMsg.textContent = t("exportStageSave");
      }
    });
    await invoke("export_pdf", { html: fullHtml, path: savePath });
    done = true;
    // P1 关联源：把当前 md 源复制到 PDF 同目录同名 .md，使以后打开此 PDF 时 find_pdf_source 能命中回到源
    if (doc.path) {
      const pdfDir = savePath.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
      const stem = (doc.name || t("untitled")).replace(/\.[^.]+$/, "");
      const srcCopy = pdfDir + "/" + stem + ".md";
      const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
      if (norm(doc.path) !== norm(srcCopy) && doc.content) {
        try { await invoke("save_file", { path: srcCopy, content: doc.content }); }
        catch { /* 关联源副本失败不阻断导出（目标可能被占用等） */ }
      }
    }
    stopEst();
    setPct(100);
    if (exportMsg) exportMsg.textContent = currentLang === "en" ? "Exported." : currentLang === "zh-TW" ? "匯出完成。" : "导出完成。";
    await new Promise<void>(r => setTimeout(r, 350)); // 让 100% 短暂停留再收尾，避免进度条一闪而过
    const doneLabel = currentLang === "en" ? "Exported: " : currentLang === "zh-TW" ? "匯出完成：" : "导出完成：";
    resultMsg = "✅ " + doneLabel + savePath;
  } catch (e) {
    resultOk = false;
    resultMsg = t("exportFail") + e;
  } finally {
    stopEst();
    if (unlisten) unlisten();              // 移除事件监听，防止泄漏（成功/异常/取消三路都执行）
    exporting = false;                     // 释放重入锁（统一释放点，杜绝锁泄漏）
    if (overlay) overlay.hidden = true;    // 先关遮罩再弹结果，避免进度条与结果框并存
  }
  showToast(resultMsg, resultOk ? "success" : "danger");
}

async function boot() {
  try {
    const sf = await invoke<string | null>("get_startup_file");
    if (sf) pendingFile = sf;
  } catch {
    // 非 tauri 环境忽略
  }
  // v0.3.26 会话恢复前置：ui-state 必须在 initVditor 之前就绪（after 首次初始化分支要用
  // session 数据决定"恢复会话还是欢迎页"，then 异步会输给 Vditor 构造）。Rust 读一个小
  // JSON <5ms，不拖启动感知。uiStateLoaded 同步置真，原 then 时序问题（memRecent 合并）不复存在。
  try {
    uiStateAll = (await invoke<Record<string, unknown> | null>("load_ui_state")) || {};
  } catch {
    uiStateAll = {};
  }
  uiStateLoaded = true;

  // 模式切换：顶部「所见即所得」按钮 + Ctrl+Alt+M 快捷键
  document.getElementById("btn-mode")!.addEventListener("click", () => {
    switchMode(currentMode === "wysiwyg" ? "ir" : "wysiwyg");
  });
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "m" || e.key === "M")) {
      e.preventDefault();
      switchMode(currentMode === "wysiwyg" ? "ir" : "wysiwyg");
    }
  });
  // 撤销/重做快捷键接管：Vditor 工具栏配了 undo/redo 按钮后，其内部 keydown 会在
  // `!toolbar.elements.undo`(恒 false) 时跳过 Ctrl+Z(vditor index.js:8915)，把它交给浏览器原生
  // contenteditable undo——而原生 undo 在 Vditor 复杂渲染 DOM 上频繁失效("Ctrl+Z 有时没反应")。
  // 此处 capture 阶段直接调 Vditor undo 栈并 preventDefault，与工具栏按钮、Ctrl+Alt+M 互不冲突。
  window.addEventListener("keydown", (e) => {
    if (!vditor) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return; // 仅 Ctrl/Meta，避开 Ctrl+Alt+M
    // 焦点必须在编辑区内，避免劫持对话框/输入框的原生撤销
    const editorEl = document.querySelector("#editor .vditor-wysiwyg, #editor .vditor-ir, #editor .vditor-sv");
    const ae = document.activeElement;
    if (!editorEl || !ae || !editorEl.contains(ae)) return;
    const k = e.key.toLowerCase();
    // stopImmediatePropagation：阻止事件继续传到编辑区 pre 元素上 Vditor 自带的 Ctrl+Z handler
    // （vditor 会模拟点击 undo 按钮再 undo 一次），否则与 doUndo 叠加导致一次按键撤销两步。
    if (k === "z" && e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); doRedo(); }       // Ctrl+Shift+Z = 重做
    else if (k === "z") { e.preventDefault(); e.stopImmediatePropagation(); doUndo(); }                // Ctrl+Z = 撤销
    else if (k === "y") { e.preventDefault(); e.stopImmediatePropagation(); doRedo(); }                // Ctrl+Y = 重做
  }, true);
  // 阻断浏览器原生 contenteditable undo/redo：上面的 keydown listener 已通过 doUndo 接管
  // （走 Vditor undo 栈）。但 keydown 的 preventDefault 拦不住 Chromium 的原生 undo——它经
  // beforeinput(inputType=historyUndo) 通道执行，会与 Vditor 栈不同步，表现为一次 Ctrl+Z
  // 撤销两步。capture 阶段拦截 historyUndo/historyRedo 并 preventDefault，确保只有 Vditor 栈响应。
  document.addEventListener("beforeinput", (e: Event) => {
    const it = (e as InputEvent).inputType;
    if (it === "historyUndo" || it === "historyRedo") {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
  updateModeUI();
  applyAllText(); // 初始化静态文案到当前语言
  const langSel = document.getElementById("lang-select") as HTMLSelectElement | null;
  if (langSel) langSel.addEventListener("change", () => setLang(langSel.value as Lang));
  // 编辑区字号（基于选区）：先在编辑区框选文字，再点下拉选字号 → 选区文字被包进内联 <span style="font-size:Npx">。
  // 点下拉会抢走 contenteditable 焦点并使选区折叠：在 mousedown(capture) 先快照选区，change 时再对快照应用。
  const fssInit = document.getElementById("font-size-select") as HTMLInputElement | null;
  if (fssInit) {
    fssInit.value = String(loadFontSize()); // 仅恢复"上次用过"的字号值，不应用于全文
    fssInit.title = t("fontSizeTip");
    // mousedown(capture) + preventDefault：阻止 input 默认抢焦折叠编辑区选区，先把选区快照(savedRange)存下；
    // 但异步 focus(input) 仍会让 contenteditable 失焦——Chromium 下失焦选区高亮默认透明（不似 textarea 变灰可见），
    // 故 focus 前 paintFontSelHl() 用 savedRange 矩形覆盖一层半透明蓝，模拟框选全程可见(需求3)。程序化 focus 不折叠选区，Range 保留作 apply 兜底。
    fssInit.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault();
      fontInputInteracting = true;        // 冻结光标字号同步，避免回写覆盖用户即将输入的数值
      captureFontSizeSelection();         // 抢焦前快照选区（兜底，防 selection 变化）
      paintFontSelHl();                   // input 获焦将致 contenteditable 失焦(高亮透明)→ 先绘自定义高亮层保框选可见
      setTimeout(() => fssInit.focus({ preventScroll: true }), 0);
    }, true);
    fssInit.addEventListener("blur", () => { fontInputInteracting = false; clearFontSelHl(); });
    fssInit.addEventListener("change", () => {
      // change 提交语义（而非 input）：避免逐字符把"12"拆成 px=1 再 px=12 反复套用
      let px = parseInt(fssInit.value, 10);
      if (isNaN(px)) {
        // 空值/非法输入：回写上次用的字号，给用户明确反馈而非静默无反应
        fssInit.value = String(loadFontSize());
        return;
      }
      if (px < 8) px = 8;   // 钳制到合法区间并回写，超界输入直接纠正显示
      if (px > 72) px = 72;
      fssInit.value = String(px);
      applyFontSizeToSelection(px);
      clearFontSelHl();                   // apply 后真实选区已重选恢复高亮(富文本) → 移除自定义层
      try { localStorage.setItem(FONT_SIZE_KEY, String(px)); } catch { /* 存储禁用，仅本次会话生效 */ }
    });
    // 光标定位到某文字时，把工具栏字号显示同步为该文字实际渲染字号（仅显示，绝不触发 apply）。
    // 仅富文本模式（contenteditable）：源码模式 textarea 是原始文本、无内联字号概念，跳过。
    document.addEventListener("selectionchange", () => {
      if (fontInputInteracting) return;                  // 用户正操作字号框：不回写，避免覆盖其输入
      if (activeSourceTextarea()) return;                // 源码模式不同步
      const editable = activeEditableArea();
      if (!editable) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const node = sel.anchorNode;
      if (!node || !editable.contains(node)) return;     // 选区不在编辑区：不动
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
      if (!el) return;
      const px = parseInt(getComputedStyle(el).fontSize, 10);
      if (px >= 8 && px <= 72) fssInit.value = String(px); // 仅更新显示，不触发 applyFontSizeToSelection
    });
    // 高亮层固定于视口(fixed)：编辑区滚动/窗口缩放使 savedRange 矩形位移 → 重绘防错位（仅交互期间，开销可控）
    const repaintHl = () => { if (fontInputInteracting) paintFontSelHl(); };
    document.addEventListener("scroll", repaintHl, true); // 捕获：scroll 不冒泡，捕获阶段接住 vditor 内部滚动容器
    window.addEventListener("resize", repaintHl);
  }
  bindTablePopoverVisibility(); // WYSIWYG 表格浮层显示（补 Vditor 重建后不自动触发的缺陷）
  bindTableInputConfirm(); // 表格行列数字框：确认（回车/失焦）后才增删，避免逐字符删数据

  initVditor();

  // 单实例：已运行时再次双击 .md → 新标签
  await listen<string>("open-file", (e) => loadFile(e.payload));

  // 关闭窗口前确认：有未保存修改时让用户选择 保存并关闭 / 不保存关闭 / 取消
  try {
    const win = getCurrentWindow();
    await win.onCloseRequested(async (e) => {
      saveSession(); // v0.3.26 会话：无论走哪条关闭路径都先落会话（防抖定时器等不到下次 tick）
      if (!docs.some((d) => d.dirty)) return; // 无未保存修改，正常关闭
      e.preventDefault();
      const action = await showCloseConfirm();
      if (action === "cancel") return; // 取消：不关闭
      if (action === "save") await saveAllDirty(); // 保存并关闭：先保存有路径的文档
      saveSession(); // saveAllDirty 改了内容/结构：再落一次
      try {
        await win.destroy();
      } catch (e) {
        showToast(t("closeFail") + e, "danger");
      }
    });
  } catch {
    // 非 tauri 环境忽略
  }
  // 拖拽打开：Windows/WebView2 上 wry 原生拖放存在时序竞态（注册早于 WebView2 子窗口 drop target
  // 就绪 → 拦截失败 → 不产生 tauri://drag-drop 事件，实测完全无反应）。
  // 改用 HTML5 拖放：dragDropEnabled:false 后 WebView2 原生 HTML5 drop 可靠触发。
  // 代价：HTML5 拿不到原始路径（浏览器安全限制）→ PDF 经 IPC 读字节写临时文件再交 PDF4QT；
  // md/txt 直接读文本进编辑器。需原路径/源文件联动时用「打开」按钮（已可用）。
  try {
    const DRAG_PDF_MAX = 5 * 1024 * 1024; // IPC 传字节，限 5MB，更大请用「打开」按钮
    window.addEventListener("dragover", (e) => {
      e.preventDefault(); // 不阻止则 drop 不触发
    });
    window.addEventListener("drop", async (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      if (/\.pdf$/i.test(f.name)) {
        if (f.size > DRAG_PDF_MAX) {
          showToast(currentLang === "en" ? "PDF > 5MB, please use the Open button." : "PDF 超过 5MB，请改用「打开」按钮选择文件。", "danger");
          return;
        }
        try {
          const buf = new Uint8Array(await f.arrayBuffer());
          await invoke("open_dropped_pdf", { content: Array.from(buf), name: f.name });
        } catch (err) {
          showToast((currentLang === "en" ? "Open failed: " : "打开失败：") + err, "danger");
        }
      } else if (/\.(md|markdown|mdown|txt)$/i.test(f.name)) {
        const text = await f.text();
        openDoc(null, text, f.name, "UTF-8");
      }
    });
    // 自测：--dnd-selftest 启动时合成一次 drop，验证 HTML5 拖放→IPC→临时文件全链路（常驻、正常启动不触发）
    if (await invoke<boolean>("dnd_selftest_enabled").catch(() => false)) {
      const blob = new Blob(["%PDF-1.4\n%selftest\n"], { type: "application/pdf" });
      const file = new File([blob], "__dnd_selftest__.pdf", { type: "application/pdf" });
      const dt = new DataTransfer();
      dt.items.add(file);
      window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
  } catch {
    // 非 tauri 环境忽略
  }

  document.getElementById("btn-open")!.addEventListener("click", async () => {
    const p = await openDialog({
      multiple: false,
      filters: [
        { name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] },
        { name: "PDF", extensions: ["pdf"] },
      ],
    });
    if (!p) return;
    const ps = p as string;
    if (/\.pdf$/i.test(ps)) handleOpenPdf(ps);
    else loadFile(ps);
  });

  document.getElementById("btn-save")!.addEventListener("click", async () => {
    if (!vditor) return;
    const doc = activeDoc();
    if (!doc) return;
    const v = mdValue();
    if (v !== "" || doc.content === "") doc.content = v; // 守卫：空值不覆盖
    let path = doc.path;
    if (!path) {
      const sp = await saveDialog({ filters: [{ name: "Markdown", extensions: ["md"] }] });
      if (!sp) return;
      path = sp as string;
      doc.path = path;
      doc.name = path.split(/[\\/]/).pop()!;
    }
    try {
      await invoke("save_file", { path, content: doc.content });
      doc.dirty = false;
      doc.encoding = "UTF-8"; // 统一写 UTF-8 无 BOM，刷新标记避免与原编码矛盾
      updateTitle();
      renderTabs();
    } catch (e) {
      showToast(t("saveFail") + e, "danger");
    }
  });

  // 导出中心下拉菜单（PDF/HTML/图片/Word/打印）。Ctrl+P=打印，在上方 capture 阶段统一拦截
  bindExportMenu();

  // v0.4.0 文件/视图菜单（工具栏收敛）：菜单项一律转发既有按钮 click——
  // 旧按钮已退役为 #legacy-btns 隐藏锚点（绑定零动），与命令面板同一零复制原则
  bindFileViewMenus();

  // Ctrl+S 保存（编辑器标配；此前只有保存按钮+30s 自动保存，真实用户测试发现的缺口）
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      const doc = activeDoc();
      if (doc) void saveDoc(doc);
    }
  });

  startAutosave();
  bindFocusTypewriter();
  bindFindBar();
  bindHistory(); // v0.3.11 版本历史（工具栏 🕘 按钮）
  initOutlineResize(); // v0.3.12 大纲侧栏拖宽（Word 式近缘拖动+持久化）
  // 版本号：优先 Tauri 运行时真实版本（与构建产物一致），失败回落 index.html 硬编码
  try {
    const v = await getVersion();
    if (v) document.getElementById("app-version")!.textContent = "v" + v;
  } catch { /* dev 浏览器态无 Tauri，保回落值 */ }
  // 恢复上次会话的专注状态（打字机模式已按用户要求移除，遗留键清理）
  try {
    if (localStorage.getItem(FOCUS_KEY) === "1") setFocusMode(true);
    localStorage.removeItem("md-editor-typewriter");
  } catch { /* 存储禁用 */ }
  // v0.3.14 侧栏文件页（文件树/最近/跨文件搜索）+ 快开 + 主题；v0.3.15 标签右键菜单
  initSidePanels();
  initTabMenu();
  initFtreeMenu();
  initNoticeBars(); // v0.3.26 外改检测/大文档提示条按钮
  initReadingTrace(); // v0.4.0 阅读轨迹：scrollspy + 顶部进度线
  initCodeBlocks(); // v0.4.0 代码块语言徽标 + 复制按钮
  initCmdk(); // v0.4.0 命令面板（Ctrl+K）
  switchSidePane("outline"); // v0.3.21 默认显示大纲页（用户 2026-08-30 定调；文件页点页签可达）
  // Word 式显示比例：Ctrl+滚轮 / Ctrl+加减 / Ctrl+0 复位 / 右下角拉杆——只缩正文内容区
  // （.vditor-content），格式工具条(.vditor-toolbar)/应用工具栏/大纲/标签页都不缩。
  // 实现=挂载点 CSS 变量 --doc-zoom（Vditor 模式/语言重建子树不丢）；zoom 参与布局，
  // rect/选区/查找高亮层坐标自洽，文档内容不变。范围 0.5~2.0、10% 档。
  // 持久化=Rust 侧 ui-state.json（%APPDATA%）：localStorage 磁盘刷盘异步，强杀即丢。
  let zoomLevel = 1.0;
  const persistZoom = () => { saveUiStateKey("zoom", zoomLevel); };
  const applyZoom = () => {
    document.getElementById("editor")?.style.setProperty("--doc-zoom", String(zoomLevel));
    const zb = document.getElementById("zoom-badge");
    if (zb) zb.textContent = Math.round(zoomLevel * 100) + "%";
    const sz = document.getElementById("sb-zoom");
    if (sz) sz.textContent = Math.round(zoomLevel * 100) + "%";
    const zs = document.getElementById("zoom-slider") as HTMLInputElement | null;
    if (zs) zs.value = String(Math.round(zoomLevel * 100));
    persistZoom();
  };
  // v0.4.0 状态栏比例徽标：点击复位 100%（与 Ctrl+0 同路径）
  document.getElementById("sb-zoom")?.addEventListener("click", () => {
    zoomLevel = 1.0; applyZoom(); revealZoomBar();
  });
  // v0.3.26：ui-state 已在 boot 开头同步 await 就绪，这里直接用（原 then 时序的 memRecent
  // 合并不再需要——load 先于任何 pushRecent 完成）
  initTheme();
  if (uiStateAll.sideCollapsed === true) setSideCollapsed(true, false); // v0.4.0 恢复侧栏折叠态（不回写）
  renderRecent();
  renderFindHistory(); // v0.3.26 查找历史 datalist
  const diskZoom = typeof uiStateAll.zoom === "number" ? (uiStateAll.zoom as number) : NaN;
  if (diskZoom >= 0.5 && diskZoom <= 2.0) zoomLevel = diskZoom;
  // v0.3.26 状态栏：选区变化更新"已选 N 字"（与字号同步的 selectionchange 分开挂，职责不同）
  document.addEventListener("selectionchange", trackSelectionStatus);
  // v0.3.26 外改检测：窗口重获焦点即核当前文档（外部程序改动最常见的感知时机）
  window.addEventListener("focus", () => {
    const d = activeDoc();
    if (d) void checkExternalMod(d);
  });
  // v0.3.26 会话兜底：崩溃/强杀等不经 onCloseRequested 的退出路径
  window.addEventListener("beforeunload", saveSession);
  // v0.3.27 缩放拉杆默认隐藏：仅缩放操作（滚轮/加减/0/滑杆/按钮）时自动浮现 3s，
  // 悬停/拖动期间不消失（拖动连续触发 input 不断重置定时器）；平时右下角不占位。
  let zoomHideTimer = 0;
  const revealZoomBar = () => {
    const bar = document.getElementById("zoom-bar");
    if (!bar) return;
    bar.classList.add("zoom-show");
    window.clearTimeout(zoomHideTimer);
    zoomHideTimer = window.setTimeout(() => bar.classList.remove("zoom-show"), 3000);
  };
  const zoomBy = (d: number) => {
    zoomLevel = Math.min(2.0, Math.max(0.5, Math.round((zoomLevel + d) * 100) / 100));
    applyZoom();
    revealZoomBar();
  };
  document.getElementById("zoom-slider")?.addEventListener("input", (e) => {
    const v = parseInt((e.target as HTMLInputElement).value, 10) / 100;
    if (v >= 0.5 && v <= 2.0) { zoomLevel = v; applyZoom(); revealZoomBar(); }
  });
  document.getElementById("zoom-out")?.addEventListener("click", () => zoomBy(-0.1));
  document.getElementById("zoom-in")?.addEventListener("click", () => zoomBy(0.1));
  let lastWheelZoom = 0;
  window.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastWheelZoom < 90) return; // 触控板捏合连续 delta 合并为 10% 档
    lastWheelZoom = now;
    zoomBy(e.deltaY < 0 ? 0.1 : -0.1);
  }, { passive: false });
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(0.1); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(-0.1); }
    else if (e.key === "0") { e.preventDefault(); zoomLevel = 1.0; applyZoom(); revealZoomBar(); }
  });
  // 悬停拉杆期间不自动隐藏（拖完停 3s 再淡出）
  const zbEl = document.getElementById("zoom-bar");
  zbEl?.addEventListener("mouseenter", () => window.clearTimeout(zoomHideTimer));
  zbEl?.addEventListener("mouseleave", revealZoomBar);
  applyZoom();
}

window.addEventListener("DOMContentLoaded", boot);
