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
// 本地中文 i18n（从 vditor zh_CN.js 转成 ESM 值导入）：作为 options.i18n 注入，
// Vditor 走 else 分支直接使用，不再从 unpkg CDN 动态加载 zh_CN.js（国内 404），且符合 CSP
import zhCNI18n from "./i18n-zh-CN";
import zhTWI18n from "./i18n-zh-TW";
import enI18n from "./i18n-en";

let vditor: Vditor | null = null;
let outlineTimer: number | null = null;
let suppressInput = false; // setValue 时抑制 input 回调（避免切换/联动标签误标 dirty）
let currentMode: "ir" | "wysiwyg" = "wysiwyg"; // 当前编辑模式（默认所见即所得，可直接编辑表格；可切回即时渲染）
let vditorInited = false; // Vditor 是否已完成首次初始化（模式切换重建时不重跑 openDoc/pendingFile）
let switchInFlight = false; // 模式切换重建中（destroy→after 之间），抑制重入避免并发销毁/重复实例/内容丢失

// ---- i18n 国际化（简中 / 繁中 / 英文）----
type Lang = "zh-CN" | "zh-TW" | "en";
const VDITOR_I18N: Record<Lang, typeof zhCNI18n> = { "zh-CN": zhCNI18n, "zh-TW": zhTWI18n, "en": enI18n };
const VDITOR_LANG: Record<Lang, "zh_CN" | "zh_TW" | "en_US"> = { "zh-CN": "zh_CN", "zh-TW": "zh_TW", "en": "en_US" };

const UI_TEXT: Record<Lang, Record<string, string>> = {
  "zh-CN": {
    open: "📂 打开", save: "💾 保存", welcomeName: "欢迎", untitled: "未命名", noDoc: "（无）",
    emptyHint: "📋 点击顶部「📂 打开」，或把 .md 文件拖入窗口，开始编辑",
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
    export: "💾 导出 ▾", exportNoDoc: "（请先打开或新建文档再导出）", exportFail: "导出失败：", exporting: "正在导出 PDF，请稍候…",
    exportDone: "导出完成：", pandocMissing: "Pandoc 未就绪：把 pandoc.exe 放到 md-editor.exe 同目录即解锁（免安装）", pandocReady: "Pandoc 已就绪",
    exportImageSlices: "文档较长，已分片导出多张 PNG：", pasteImgUntitledHint: "（提示：文档尚未保存，截图存到了应用目录，保存文档后建议用「另存为」整理）",
    exportStagePage: "正在生成页面…", exportStagePrint: "正在打印为 PDF…", exportStageSave: "正在保存文件…",
    fontSizeTip: "字号：先框选文字，再选字号",
    selectFirstTip: "请先在编辑区框选要改字号的文字，再选字号",
    wordCount: "字",
    focusMode: "🎯 专注", findBtn: "🔍 查找",
    focusTip: "专注模式（F8）：淡化非当前段落",
    findTip: "查找替换（Ctrl+F / Ctrl+H）",
    findPlaceholder: "查找…", replacePlaceholder: "替换为…",
    replaceOne: "替换", replaceAll: "全部替换",
    replaceManyConfirm: "匹配超过 500 处，仍要全部替换吗？",
    appName: "MD 编辑器",
  },
  "zh-TW": {
    open: "📂 開啟", save: "💾 儲存", welcomeName: "歡迎", untitled: "未命名", noDoc: "（無）",
    emptyHint: "📋 點擊頂部「📂 開啟」，或把 .md 檔案拖入視窗，開始編輯",
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
    export: "💾 匯出 ▾", exportNoDoc: "（請先開啟或新增文件再匯出）", exportFail: "匯出失敗：", exporting: "正在匯出 PDF，請稍候…",
    exportDone: "匯出完成：", pandocMissing: "Pandoc 未就緒：把 pandoc.exe 放到 md-editor.exe 同目錄即解鎖（免安裝）", pandocReady: "Pandoc 已就緒",
    exportImageSlices: "文件較長，已分片匯出多張 PNG：", pasteImgUntitledHint: "（提示：文件尚未儲存，截圖存到了應用目錄，儲存文件後建議整理）",
    exportStagePage: "正在產生頁面…", exportStagePrint: "正在列印為 PDF…", exportStageSave: "正在儲存檔案…",
    fontSizeTip: "字號：先框選文字，再選字號",
    selectFirstTip: "請先在編輯區框選要改字號的文字，再選字號",
    wordCount: "字",
    focusMode: "🎯 專注", findBtn: "🔍 尋找",
    focusTip: "專注模式（F8）：淡化非當前段落",
    findTip: "尋找替換（Ctrl+F / Ctrl+H）",
    findPlaceholder: "尋找…", replacePlaceholder: "替換為…",
    replaceOne: "替換", replaceAll: "全部替換",
    replaceManyConfirm: "符合超過 500 處，仍要全部替換嗎？",
    appName: "MD 編輯器",
  },
  "en": {
    open: "📂 Open", save: "💾 Save", welcomeName: "Welcome", untitled: "Untitled", noDoc: "(none)",
    emptyHint: '📋 Click "Open" above, or drag a .md file into the window to start editing',
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
    export: "💾 Export ▾", exportNoDoc: "(Open or create a document first)", exportFail: "Export failed: ", exporting: "Exporting PDF, please wait…",
    exportDone: "Exported: ", pandocMissing: "Pandoc not found: drop pandoc.exe next to md-editor.exe to unlock (no install needed)", pandocReady: "Pandoc ready",
    exportImageSlices: "Long document, exported as multiple PNG slices: ", pasteImgUntitledHint: "(Tip: document not saved yet; screenshot stored in app folder)",
    exportStagePage: "Generating pages…", exportStagePrint: "Printing to PDF…", exportStageSave: "Saving file…",
    fontSizeTip: "Font size: select text first, then pick a size",
    selectFirstTip: "Select the text in the editor first, then pick a size",
    wordCount: "words",
    focusMode: "🎯 Focus", findBtn: "🔍 Find",
    focusTip: "Focus mode (F8): dim other paragraphs",
    findTip: "Find & replace (Ctrl+F / Ctrl+H)",
    findPlaceholder: "Find…", replacePlaceholder: "Replace with…",
    replaceOne: "Replace", replaceAll: "Replace all",
    replaceManyConfirm: "More than 500 matches. Replace all anyway?",
    appName: "MD Editor",
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
    if (savedStart === savedEnd) { alert(t("selectFirstTip")); return; }
    const selTxt = savedTa.value.substring(savedStart, savedEnd);
    const wrapped = `<span style="font-size:${px}px">${selTxt}</span>`;
    savedTa.focus();
    savedTa.setRangeText(wrapped, savedStart, savedEnd, "end"); // 光标移到插入后末尾
    savedTa.dispatchEvent(new Event("input", { bubbles: true })); // 让 Vditor 同步 doc.content/dirty/大纲
    return;
  }
  // 富文本模式：contenteditable 选区
  if (!savedRange || savedRange.collapsed) { alert(t("selectFirstTip")); return; }
  const editable = activeEditableArea();
  if (!editable) { alert(t("selectFirstTip")); return; }
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
}
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
  const secs = parseSections(doc ? doc.content : vditor.getValue());
  const ul = document.getElementById("outline")!;
  ul.innerHTML = "";
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
}

function scheduleOutline() {
  if (outlineTimer !== null) window.clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(() => {
    outlineTimer = null;
    rebuildOutline();
  }, 400);
}

function scrollToHeading(idx: number) {
  const doc = activeDoc();
  const secs = parseSections(doc ? doc.content : vditor ? vditor.getValue() : "");
  const target = secs[idx];
  if (!target) return;
  const heads = Array.from(
    document.querySelectorAll<HTMLElement>(
      "#editor h1, #editor h2, #editor h3, #editor h4, #editor h5, #editor h6"
    )
  );
  // 优先按标题纯文本定位（同名计数），可跳过 Setext 等未进大纲标题的重名干扰；
  // 命中失败再回退 DOM 索引（无 Setext 时与原行为等价）
  const sameBefore = secs.slice(0, idx).filter((s) => s.title === target.title).length;
  let seen = 0;
  for (const h of heads) {
    if ((h.textContent || "").trim() === target.title) {
      if (seen === sameBefore) {
        h.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      seen++;
    }
  }
  if (heads[idx]) heads[idx].scrollIntoView({ behavior: "smooth", block: "start" });
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
function renderTabs() {
  const bar = document.getElementById("tabs")!;
  bar.innerHTML = "";
  docs.forEach((doc) => {
    const tab = document.createElement("div");
    tab.className = "tab" + (doc.id === activeId ? " active" : "");
    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = (doc.dirty ? "● " : "") + doc.name;
    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "✕";
    close.title = t("closeTab");
    tab.appendChild(name);
    tab.appendChild(close);
    tab.addEventListener("click", () => switchDoc(doc.id));
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeDoc(doc.id);
    });
    bar.appendChild(tab);
  });
}

function switchDoc(id: string) {
  hideEmptyState(); // 切到有内容的文档，隐藏空状态
  // 保存当前文档内容到其 Doc（getValue 守卫：空值不覆盖）
  if (vditor) {
    const cur = activeDoc();
    if (cur) {
      const v = vditor.getValue();
      if (v !== "" || cur.content === "") cur.content = v;
    }
  }
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  activeId = id;
  if (vditor) {
    // 切换文档时清空 undo/redo 栈并以新文档为唯一基线：Vditor 栈是 per-instance(非 per-doc)，
    // 不清栈会让新旧文档全文 diff 污染栈，导致一次 undo 回退整篇内容（"撤销一次撤多步"根因）。
    suppressInput = true;
    vditor.setValue(doc.content, true);
    suppressInput = false;
  }
  rebuildOutline();
  renderTabs();
  updateTitle();
}

// 全部标签关闭后的空状态（允许关闭欢迎页）：遮住编辑区，提示打开文件
function showEmptyState() {
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
}

function openDoc(path: string | null, content: string, name?: string, encoding?: string) {
  hideEmptyState(); // 打开文档时隐藏空状态
  closeFind(); // 文档切换后旧匹配节点失效，收起查找条
  // 同路径已打开 → 直接切换过去，不重复开
  if (path) {
    const existing = docs.find((d) => d.path === path);
    if (existing) {
      switchDoc(existing.id);
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
  };
  docs.push(doc);
  switchDoc(doc.id);
}

function updateTitle() {
  const doc = activeDoc();
  const el = document.getElementById("file-title")!;
  el.textContent = doc ? (doc.dirty ? "● " : "") + doc.name : t("noDoc");
  document.getElementById("encoding-badge")!.textContent = doc && doc.encoding ? ` ${doc.encoding}` : "";
}

async function loadFile(path: string) {
  try {
    const [content, enc] = await invoke<[string, string]>("open_file", { path });
    openDoc(path, content, undefined, enc);
  } catch (e) {
    alert(t("openFail") + e);
  }
}

// 打开 PDF：智能分流。不走 open_file（白名单只读文本类，PDF 会被拒）。
// find_pdf_source 查同名 .md/.html 源：有源 → 打开源编辑（改完可重导出覆盖 PDF）；
// 无源 → open_pdf_external 调 PDF4QT，探测不到（PDF4QT_NOT_FOUND）回落系统默认 PDF 程序。
async function handleOpenPdf(pdfPath: string) {
  let src: string | null = null;
  try {
    src = await invoke<string | null>("find_pdf_source", { pdfPath });
  } catch (e) {
    alert(t("openFail") + e);
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
        alert(t("openFail") + e2);
      }
    } else {
      alert(t("openFail") + e);
    }
  }
}

let pendingFile: string | null = null;

// 构造 Vditor options：toolbar/input/after 统一在此，mode 由参数决定（销毁重建切换模式时复用）
type VditorOptions = NonNullable<ConstructorParameters<typeof Vditor>[1]>;
function vditorOptions(mode: "ir" | "wysiwyg"): VditorOptions {
  return {
    mode,
    lang: VDITOR_LANG[currentLang],
    i18n: VDITOR_I18N[currentLang], // 注入本地 i18n（当前语言），工具栏 tooltip 自动走 i18n
    cdn: "/vditor-assets", // lute(markdown 引擎)/icons/method 等本地加载，符合 CSP，不依赖 unpkg
    height: "100%",
    cache: { enable: false },
    // 字数统计（type text = 按渲染后文本统计，符合中文字数直觉；after 补三语单位，样式由 styles.css 钉右下角）
    counter: {
      enable: true, type: "text",
      after: (len: number) => {
        const el = document.querySelector<HTMLElement>(".vditor-counter");
        if (el) el.innerText = `${len} ${t("wordCount")}`;
      },
    },
    // :emoji: 补全的表情图片走本地资源（默认 unpkg CDN，CSP 禁外联且离线不可用）
    hint: { emojiPath: "/vditor-assets/dist/images/emoji" },
    preview: {
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
      "undo", "redo", "|",
      "edit-mode", "fullscreen",
    ],
    input: () => {
      if (suppressInput) return;
      const doc = activeDoc();
      if (doc && vditor) {
        const v = vditor.getValue();
        if (v !== "" || doc.content === "") doc.content = v; // 守卫：空值不覆盖
        doc.dirty = true;
      }
      updateTitle();
      renderTabs();
      scheduleOutline();
    },
    after: () => {
      fixToolbarTooltipDirection();
      closeFind(); // 模式/语言切换销毁重建：旧匹配节点全部失效
      if (!vditorInited) {
        // 首次初始化：打开欢迎文档、处理命令行传入的文件
        vditorInited = true;
        openDoc(null, welcomeMd(), t("welcomeName"));
        if (pendingFile) {
          const f = pendingFile;
          pendingFile = null;
          loadFile(f);
        }
      } else {
        // 模式切换后重建：把当前文档内容恢复进新编辑器
        const doc = activeDoc();
        if (doc && vditor) {
          // 模式/语言切换销毁重建实例后同样清栈建基线（与 switchDoc 一致，防 diff 串台）
          suppressInput = true;
          vditor.setValue(doc.content, true);
          suppressInput = false;
        }
        rebuildOutline();
        renderTabs();
        updateTitle();
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
    const v = vditor.getValue();
    if (v !== "" || cur.content === "") cur.content = v;
  }
  currentMode = mode;
  vditor.destroy();
  vditor = null;
  vditor = new Vditor("editor", vditorOptions(mode));
  updateModeUI(); // after 回调就绪后还会再更新一次
}

// 更新顶部模式切换按钮文字 + 当前模式徽标
function updateModeUI() {
  const btn = document.getElementById("btn-mode");
  const badge = document.getElementById("mode-badge");
  if (currentMode === "wysiwyg") {
    if (btn) {
      btn.textContent = t("switchToIR");
      btn.title = t("switchToIRTip");
    }
    if (badge) {
      badge.textContent = t("modeWYSIWYG");
      badge.title = t("modeWYSIWYGTip");
      badge.className = "mode-badge wysiwyg";
    }
  } else {
    if (btn) {
      btn.textContent = t("switchToWYSIWYG");
      btn.title = t("switchToWYSIWYGTip");
    }
    if (badge) {
      badge.textContent = t("modeIR");
      badge.title = t("modeIRTip");
      badge.className = "mode-badge ir";
    }
  }
}

// 把所有静态 DOM 文案更新到当前语言（语言切换 / 初始化时调用）
function applyAllText() {
  document.getElementById("btn-open")!.textContent = t("open");
  document.getElementById("btn-save")!.textContent = t("save");
  document.getElementById("btn-export")!.textContent = t("export");
  const bfw = document.getElementById("btn-focus-mode"); if (bfw) { bfw.textContent = t("focusMode"); bfw.title = t("focusTip"); }
  const bfd = document.getElementById("btn-find"); if (bfd) { bfd.textContent = t("findBtn"); bfd.title = t("findTip"); }
  const fi = document.getElementById("find-input") as HTMLInputElement | null; if (fi) fi.placeholder = t("findPlaceholder");
  const ri = document.getElementById("replace-input") as HTMLInputElement | null; if (ri) ri.placeholder = t("replacePlaceholder");
  const ro = document.getElementById("replace-one"); if (ro) ro.textContent = t("replaceOne");
  const ra = document.getElementById("replace-all"); if (ra) ra.textContent = t("replaceAll");
  const pt = document.getElementById("panel-title"); if (pt) pt.textContent = t("panelTitle");
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
      const v = vditor.getValue();
      if (v !== "" || cur.content === "") cur.content = v;
      // 欢迎页(无 path)随语言切换更新欢迎内容；用户文档(有 path)保留原内容不动
      if (!cur.path) { cur.content = welcomeMd(); cur.name = t("welcomeName"); cur.dirty = false; }
    }
    vditor.destroy();
    vditor = null;
    vditor = new Vditor("editor", vditorOptions(currentMode));
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
    const v = vditor.getValue();
    if (v !== "" || doc.content === "") doc.content = v;
  }
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
    alert(seq + doc.name + t("saveEmptySuf"));
    return false;
  }
  try {
    await invoke("save_file", { path, content: doc.content });
    doc.dirty = false;
    return true;
  } catch (e) {
    alert(t("saveFail") + doc.name + " — " + e);
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
  for (const doc of docs) {
    if (!doc.dirty || !doc.path) continue;
    if (activeDoc()?.id === doc.id) {
      const v = vditor.getValue();
      if (v !== "" || doc.content === "") doc.content = v; // 守卫：空值不覆盖（同 saveDoc）
    }
    if (doc.content === "") continue;
    try {
      await invoke("save_file", { path: doc.path, content: doc.content });
      doc.dirty = false;
      doc.encoding = "UTF-8"; // 统一写 UTF-8 无 BOM（同手动保存）
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
  if (Math.abs(delta) > 28) sc.scrollTo({ top: sc.scrollTop + delta, behavior: "smooth" });
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
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
}

// ---- 查找替换（第二批）：overlay 高亮层方案 ----
// 高亮画在 fixed 覆盖层（不进 contenteditable DOM → 不污染 md 源码/undo 栈）；
// 替换单个走 execCommand（键入管线，undo 完整）；全部替换走源码级（快照节点会被 Vditor 重渲染失效，源码级绝对可靠）
interface FindMatch { node: Text; start: number; end: number; }
let findMatches: FindMatch[] = [];
let findIndex = -1;

function scanMatches(query: string): FindMatch[] {
  const out: FindMatch[] = [];
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset");
  if (!root || !query) return out;
  const q = query.toLowerCase();
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
    const hay = t.data.toLowerCase();
    let i = hay.indexOf(q);
    while (i !== -1) {
      out.push({ node: t, start: i, end: i + q.length });
      i = hay.indexOf(q, i + q.length);
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
    if (rect.top < 90 || rect.bottom > innerHeight - 60) m.node.parentElement?.scrollIntoView({ block: "center" });
  } catch { /* 同上 */ }
  renderFindOverlay();
}

function refreshFind(resetIndex: boolean) {
  if (document.getElementById("find-bar")?.hidden) return;
  const q = (document.getElementById("find-input") as HTMLInputElement).value;
  findMatches = scanMatches(q);
  if (resetIndex || findIndex >= findMatches.length) findIndex = findMatches.length > 0 ? 0 : -1;
  renderFindOverlay();
}

function openFind(withReplace: boolean) {
  const bar = document.getElementById("find-bar")!;
  bar.hidden = false;
  if (withReplace) document.getElementById("replace-row")!.hidden = false;
  const inp = document.getElementById("find-input") as HTMLInputElement;
  // 选区文本预填（≤200 字符），无选区保留上次关键词
  const selText = getSelection()?.toString() ?? "";
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
  const rep = (document.getElementById("replace-input") as HTMLInputElement).value;
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

// 全部替换：源码级（getValue→字面替换→setValue）。
// 不用 DOM 快照逐个替换：每次 execCommand 后 Vditor 重渲染会使快照节点失效（部分替换中断）。
// 语义注记：单个替换作用于渲染文本，全部替换作用于 md 源码——含 md 标记的关键词在两路径下命中可能不同，可靠优先。
function replaceAllMatches() {
  if (!vditor) return;
  const q = (document.getElementById("find-input") as HTMLInputElement).value;
  if (!q) return;
  const rep = (document.getElementById("replace-input") as HTMLInputElement).value;
  const src = vditor.getValue();
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const newSrc = src.replace(re, rep);
  if (newSrc === src) return;
  const doc = activeDoc();
  if (doc) {
    suppressInput = true;
    vditor.setValue(newSrc, true);
    suppressInput = false;
    doc.content = newSrc;
    doc.dirty = true;
    scheduleOutline();
    updateTitle();
  }
  refreshFind(true);
}

let findInputDebounce: number | undefined;
function bindFindBar() {
  const inp = document.getElementById("find-input") as HTMLInputElement;
  inp.addEventListener("input", () => {
    window.clearTimeout(findInputDebounce);
    findInputDebounce = window.setTimeout(() => refreshFind(true), 250);
  });
  inp.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // IME 组合态的 Enter/Esc 交给输入法
    if (e.key === "Enter") { e.preventDefault(); gotoMatch(e.shiftKey ? findIndex - 1 : findIndex + 1); }
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
  // ✕ 用 pointerdown 而非 click：click 需 down+up 落在同一元素，任何扰动（微小拖动、
  // 浮层闪现、IME 状态切换）都会吃掉事件且无任何报错——用户两次报告"点✕无反应"。
  // pointerdown 按下即触发；closeFind 幂等（bar.hidden 直接 return），后续 click 重入无害。
  document.getElementById("find-close")!.addEventListener("pointerdown", (e) => { e.preventDefault(); closeFind(); });
  // ⇄"展开/收起替换"按钮已按用户要求移除：替换行只由 Ctrl+H 控制
  onDown("replace-one", replaceCurrent);
  onDown("replace-all", () => {
    if (findMatches.length > 500 && !confirm(t("replaceManyConfirm"))) return;
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
  // 点击查找条外部 → 收起（VSCode/Typora 惯例，兼作关闭路径兜底）。
  // 🔍按钮例外：它的 click 做 toggle（关了再点=重开），若此处先收起会被 click 立即重开，toggle 失效
  document.addEventListener("pointerdown", (e) => {
    const bar = document.getElementById("find-bar");
    if (!bar || bar.hidden) return;
    if (e.target instanceof Node && (bar.contains(e.target) || document.getElementById("btn-find")?.contains(e.target))) return;
    closeFind();
  }, true);
  // 🔍查找按钮 toggle：开→关（用户预期：再点一次消失）。Ctrl+F/H 仍只开（编辑中快捷键不反关）
  document.getElementById("btn-find")!.addEventListener("click", () => {
    const bar = document.getElementById("find-bar")!;
    if (!bar.hidden) closeFind(); else openFind(false);
  });
  // Ctrl+F / Ctrl+H（WebView2 无原生查找 UI）。必须用捕获阶段 + stopPropagation：
  // Vditor 内置 toolbar headings 按钮的 hotkey 是 ⌘H（Ctrl+H 弹"一级~六级标题"下拉），
  // 其 keydown 绑在编辑器元素上，先于 window 冒泡 handler 执行——不拦截就会替换框+标题菜单双弹。
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault(); e.stopPropagation(); openFind(false);
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "h" || e.key === "H")) {
      e.preventDefault(); e.stopPropagation(); openFind(true);
    }
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
    const src = img.getAttribute("src");
    if (!src) return;
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
function wrapExportHtml(fragmentHtml: string): string {
  const langAttr = currentLang === "en" ? "en" : currentLang === "zh-TW" ? "zh-TW" : "zh-CN";
  return `<!DOCTYPE html>
<html lang="${langAttr}">
<head>
<meta charset="UTF-8">
<style>
${vditorCssText}
@page { size: A4; margin: 15mm; }
html, body {
  margin: 0; padding: 0; background: #fff; color: #000;
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", "Segoe UI", system-ui, sans-serif;
  font-size: 14px; line-height: 1.75;
}
.vditor-reset { max-width: none; margin: 0; padding: 0; }
pre { white-space: pre-wrap; word-break: break-word; }
pre, table, tr, blockquote, img { break-inside: avoid; }
img { max-width: 100%; }
table { border-collapse: collapse; }
</style>
</head>
<body class="vditor-reset"><div class="vditor-reset">${fragmentHtml}</div></body>
</html>`;
}

// ===== v0.3.0 导出中心：HTML 两档 / 图片长图 / DOCX / Pandoc 桥（v0.3.2 移除"复制富文本"）=====
// Typora 二分法：零依赖格式内置，长尾格式（EPUB/LaTeX/RTF）检测到用户自备 pandoc.exe 才点亮。

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

let pandocPath: string | null = null;

async function refreshPandocMenu(): Promise<void> {
  try { pandocPath = await invoke<string | null>("detect_pandoc"); } catch { pandocPath = null; }
  const label = document.getElementById("pandoc-label");
  if (label) label.textContent = pandocPath ? t("pandocReady") : t("pandocMissing");
  document.querySelectorAll<HTMLButtonElement>("#export-menu button[data-pandoc]").forEach((b) => {
    b.disabled = !pandocPath;
  });
}

/** 导出片段（与 PDF 同管线：getHTML + 相对图片解析），失败返回 null */
function exportFragment(): string | null {
  const doc = activeDoc();
  if (!doc || !vditor) { alert(t("exportNoDoc")); return null; }
  let fragmentHtml = "";
  try { fragmentHtml = vditor.getHTML(); } catch (e) { alert(t("exportFail") + e); return null; }
  if (!fragmentHtml) { alert(t("exportNoDoc")); return null; }
  const tmp = document.createElement("div");
  tmp.innerHTML = fragmentHtml;
  resolveImageSources(tmp, doc.path);
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

/** HTML 导出：带样式档=完整排版（与 PDF 同模板）；纯净档=裸 fragment 无 CSS */
async function exportHtml(styled: boolean): Promise<void> {
  const frag = exportFragment();
  if (!frag) return;
  const path = await pickExportPath(".html", "HTML");
  if (!path) return;
  const langAttr = currentLang === "en" ? "en" : currentLang === "zh-TW" ? "zh-TW" : "zh-CN";
  const html = styled ? wrapExportHtml(frag)
    : `<!DOCTYPE html>\n<html lang="${langAttr}">\n<head><meta charset="UTF-8"></head>\n<body>\n${frag}\n</body>\n</html>\n`;
  try {
    await invoke("write_export_file", { path, content: html });
    alert(t("exportDone") + path);
  } catch (e) { alert(t("exportFail") + e); }
}

/** 图片长图：离屏容器渲染 → html2canvas → PNG。超 canvas 上限自动分片（Typora 官方做不到的差异化点） */
async function exportImagePng(): Promise<void> {
  const frag = exportFragment();
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
    alert(slices.length === 1 ? t("exportDone") + path : t("exportImageSlices") + slices.length + " 张");
  } catch (e) {
    alert(t("exportFail") + e);
  } finally {
    if (overlay) overlay.hidden = true;
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

/** markdown-it token → docx 元素转换（覆盖：标题/段落/行内样式/链接/嵌套列表(原生numbering)/引用(含嵌套与内嵌列表)/代码块/表格/图片(真嵌入)/脚注/分隔线） */
async function exportDocx(): Promise<void> {
  const doc = activeDoc();
  if (!doc || !vditor) { alert(t("exportNoDoc")); return; }
  const md = await rescueFootnoteDefs(vditor.getValue(), doc.path);
  if (!md) { alert(t("exportNoDoc")); return; }
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

    const { Paragraph, TextRun, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType } = docx;
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
        if (!src || /^(https?:|asset:|data:)/i.test(src) || imgCache.has(src)) continue;
        const abs = /^[a-zA-Z]:[\\/]/.test(src) ? src : (docDir ? docDir + "/" + src : "");
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
      } else if (tk.type === "fence" || tk.type === "code_block") {
        const lines = (tk.content || "").split("\n");
        blocks.push(new Paragraph({
          children: lines.map((ln: string, k: number) => new TextRun({ text: (k ? "\n" : "") + ln, font: MONO, size: 18, color: "333333", shading: { type: "clear", fill: "F5F5F5" } })),
          spacing: { before: 80, after: 80 },
        }));
      } else if (tk.type === "hr") {
        blocks.push(new Paragraph({ text: "", border: { bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: "CCCCCC" } }, spacing: { after: 120 } }));
      } else if (tk.type === "table_open") {
        // 收集到 table_close：thead/tbody 行
        let j = i + 1;
        const rows: any[] = []; let curCells: any[] = []; let curInline: any[] = [];
        for (; j < tokens.length && tokens[j].type !== "table_close"; j++) {
          const tt = tokens[j];
          if (tt.type === "tr_open") { curCells = []; }
          else if (tt.type === "th_open" || tt.type === "td_open") { curInline = []; }
          else if (tt.type === "inline") curInline = tt.children || [];
          else if (tt.type === "th_close" || tt.type === "td_close") {
            curCells.push(new TableCell({
              width: { size: Math.floor(9000 / Math.max(1, curCells.length + 1)), type: WidthType.DXA },
              shading: tt.type === "th_close" ? { type: "clear", fill: "EEEEEE" } : undefined,
              children: [new Paragraph({ children: inlineRuns(curInline, { bold: tt.type === "th_close" }) })],
            }));
          } else if (tt.type === "tr_close") rows.push(new TableRow({ children: curCells }));
        }
        blocks.push(new Table({ width: { size: 9000, type: WidthType.DXA }, rows }));
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
    alert(t("exportDone") + path);
  } catch (e) {
    alert(t("exportFail") + e);
  } finally {
    if (overlay) overlay.hidden = true;
  }
}

/** Pandoc 桥导出（EPUB/LaTeX/RTF） */
async function exportViaPandoc(fmt: string, ext: string, filterName: string): Promise<void> {
  if (!pandocPath) { alert(t("pandocMissing")); return; }
  const doc = activeDoc();
  if (!doc || !vditor) { alert(t("exportNoDoc")); return; }
  const md = await rescueFootnoteDefs(vditor.getValue(), doc.path);
  const path = await pickExportPath(ext, filterName);
  if (!path) return;
  // 相对路径图片按文档目录解析（temp md 在 %TEMP%，不传 resource-path 时 pandoc 静默缺图）
  const docDir = doc.path ? doc.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "") : null;
  try {
    await invoke("pandoc_export", { pandoc: pandocPath, md, outPath: path, fmt, docDir });
    alert(t("exportDone") + path);
  } catch (e) { alert(t("exportFail") + e); }
}

function bindExportMenu(): void {
  const btn = document.getElementById("btn-export")!;
  const menu = document.getElementById("export-menu")!;
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (menu.hidden) { await refreshPandocMenu(); menu.hidden = false; }
    else menu.hidden = true;
  });
  menu.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest("button[data-export]") as HTMLButtonElement | null;
    if (!item || item.disabled) return;
    menu.hidden = true;
    const kind = item.dataset.export;
    if (kind === "pdf") exportPdf();
    else if (kind === "html") exportHtml(true);
    else if (kind === "html-plain") exportHtml(false);
    else if (kind === "image") exportImagePng();
    else if (kind === "docx") exportDocx();
    else if (kind === "epub") exportViaPandoc("epub", ".epub", "EPUB");
    else if (kind === "latex") exportViaPandoc("latex", ".tex", "LaTeX");
    else if (kind === "rtf") exportViaPandoc("rtf", ".rtf", "RTF");
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
  if (!doc) { alert(t("exportNoDoc")); return; }
  // 先把当前编辑器实时内容回写 doc（与保存一致，getValue 空读守卫：空值不覆盖）
  const v = vditor.getValue();
  if (v !== "" || doc.content === "") doc.content = v;

  // 取渲染后 HTML 片段（getHTML 在某些异常态可能抛错，try/catch 兜底）
  let fragmentHtml = "";
  try { fragmentHtml = vditor.getHTML(); } catch (e) { alert(t("exportFail") + e); return; }
  if (!fragmentHtml) { alert(t("exportNoDoc")); return; }

  // 在临时容器里解析片段为 DOM，解析相对图片后再序列化回 HTML 字符串
  const tmp = document.createElement("div");
  tmp.innerHTML = fragmentHtml;
  resolveImageSources(tmp, doc.path);
  const fullHtml = wrapExportHtml(tmp.innerHTML);

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
    const doneLabel = currentLang === "en" ? "Exported:\n" : currentLang === "zh-TW" ? "匯出完成：\n" : "导出完成：\n";
    resultMsg = "✅ " + doneLabel + savePath;
  } catch (e) {
    resultMsg = t("exportFail") + e;
  } finally {
    stopEst();
    if (unlisten) unlisten();              // 移除事件监听，防止泄漏（成功/异常/取消三路都执行）
    exporting = false;                     // 释放重入锁（统一释放点，杜绝锁泄漏）
    if (overlay) overlay.hidden = true;    // 先关遮罩再弹结果，避免进度条与结果框并存
  }
  alert(resultMsg);
}

async function boot() {
  try {
    const sf = await invoke<string | null>("get_startup_file");
    if (sf) pendingFile = sf;
  } catch {
    // 非 tauri 环境忽略
  }

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
      if (!docs.some((d) => d.dirty)) return; // 无未保存修改，正常关闭
      e.preventDefault();
      const action = await showCloseConfirm();
      if (action === "cancel") return; // 取消：不关闭
      if (action === "save") await saveAllDirty(); // 保存并关闭：先保存有路径的文档
      try {
        await win.destroy();
      } catch (e) {
        alert(t("closeFail") + e);
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
          alert(currentLang === "en" ? "PDF > 5MB, please use the Open button." : "PDF 超过 5MB，请改用「打开」按钮选择文件。");
          return;
        }
        try {
          const buf = new Uint8Array(await f.arrayBuffer());
          await invoke("open_dropped_pdf", { content: Array.from(buf), name: f.name });
        } catch (err) {
          alert((currentLang === "en" ? "Open failed: " : "打开失败：") + err);
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
    const v = vditor.getValue();
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
      alert(t("saveFail") + e);
    }
  });

  // 导出 PDF：点击按钮 或 Ctrl+P（拦截浏览器原生打印，改为打印渲染后的纯内容，排除工具栏/大纲）
  bindExportMenu(); // 导出中心下拉菜单（Ctrl+P 仍直达 PDF）
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      exportPdf();
    }
  });

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
  // Word 式显示比例：Ctrl+滚轮 / Ctrl+加减 / Ctrl+0 复位 / 右下角拉杆——只缩正文内容区
  // （.vditor-content），格式工具条(.vditor-toolbar)/应用工具栏/大纲/标签页都不缩。
  // 实现=挂载点 CSS 变量 --doc-zoom（Vditor 模式/语言重建子树不丢）；zoom 参与布局，
  // rect/选区/查找高亮层坐标自洽，文档内容不变。范围 0.5~2.0、10% 档。
  // 持久化=Rust 侧 ui-state.json（%APPDATA%）：localStorage 磁盘刷盘异步，强杀即丢。
  let zoomLevel = 1.0;
  let zoomSaveTimer = 0;
  const persistZoom = () => {
    window.clearTimeout(zoomSaveTimer);
    zoomSaveTimer = window.setTimeout(() => {
      invoke("save_ui_state", { v: { zoom: zoomLevel } }).catch(() => { /* 保存失败不阻塞 UI */ });
    }, 150);
  };
  const applyZoom = () => {
    document.getElementById("editor")?.style.setProperty("--doc-zoom", String(zoomLevel));
    const zb = document.getElementById("zoom-badge");
    if (zb) zb.textContent = Math.round(zoomLevel * 100) + "%";
    const zs = document.getElementById("zoom-slider") as HTMLInputElement | null;
    if (zs) zs.value = String(Math.round(zoomLevel * 100));
    persistZoom();
  };
  invoke<Record<string, unknown> | null>("load_ui_state").then((s) => {
    const z = s && typeof s.zoom === "number" ? s.zoom : NaN;
    if (z >= 0.5 && z <= 2.0) { zoomLevel = z; applyZoom(); }
  }).catch(() => { /* 读失败默认 100% */ });
  const zoomBy = (d: number) => {
    zoomLevel = Math.min(2.0, Math.max(0.5, Math.round((zoomLevel + d) * 100) / 100));
    applyZoom();
  };
  document.getElementById("zoom-slider")?.addEventListener("input", (e) => {
    const v = parseInt((e.target as HTMLInputElement).value, 10) / 100;
    if (v >= 0.5 && v <= 2.0) { zoomLevel = v; applyZoom(); }
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
    else if (e.key === "0") { e.preventDefault(); zoomLevel = 1.0; applyZoom(); }
  });
  applyZoom();
}

window.addEventListener("DOMContentLoaded", boot);
