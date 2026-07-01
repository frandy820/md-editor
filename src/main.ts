import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog, confirm } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Vditor from "vditor";
import "vditor/dist/index.css";
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
    suppressInput = true;
    vditor.setValue(doc.content);
    suppressInput = false;
  }
  rebuildOutline();
  renderTabs();
  updateTitle();
}

// 全部标签关闭后的空状态（允许关闭欢迎页）：遮住编辑区，提示打开文件
function showEmptyState() {
  document.getElementById("empty-state")!.hidden = false;
  if (vditor) { suppressInput = true; vditor.setValue(""); suppressInput = false; }
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
    preview: { hljs: { lineNumber: false, style: "github" } },
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
          suppressInput = true;
          vditor.setValue(doc.content);
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
}

// 切换编辑模式：Vditor 3.11.2 没有运行时 changeMode，唯一可靠方式 = 销毁实例 + 以目标 mode 重建。
// IR 模式表格是源码态（管道符），不可视化编辑；WYSIWYG 模式表格可点击单元格编辑，
// 且光标进入表格会浮出工具栏：上下插行 / 左右插列 / 删行删列 / 对齐 / 删表。
function switchMode(mode: "ir" | "wysiwyg") {
  // 重入锁：destroy→after 回调之间 vditor 处于重建中间态，连点按钮/狂按 Ctrl+Alt+M 可能在
  // vditor=null 窗口期二次进入，并发触发 destroy/new 导致 DOM 残留、重复实例或内容丢失。重建中直接忽略。
  if (!vditor || currentMode === mode || switchInFlight) return;
  switchInFlight = true;
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
  const pt = document.getElementById("panel-title"); if (pt) pt.textContent = t("panelTitle");
  const eh = document.getElementById("empty-hint"); if (eh) eh.textContent = t("emptyHint");
  const cmsg = document.getElementById("cc-msg"); if (cmsg) cmsg.textContent = t("closeSaveMsg");
  const csave = document.getElementById("cc-save"); if (csave) csave.textContent = t("closeSave");
  const cdisc = document.getElementById("cc-discard"); if (cdisc) cdisc.textContent = t("closeDiscard");
  const ccan = document.getElementById("cc-cancel"); if (ccan) ccan.textContent = t("closeCancel");
  const sel = document.getElementById("lang-select") as HTMLSelectElement | null;
  if (sel) sel.value = currentLang;
  document.documentElement.lang = currentLang; // a11y：屏幕阅读器发音/CSS :lang/繁体字体回退随语言
  document.title = t("appName"); // 浏览器标签/Tauri 窗口/任务栏标题随语言
  updateModeUI();
}

// 切换界面语言：持久化(localStorage) + Vditor 重建(注入新语言 i18n) + 静态文案更新
function setLang(lang: Lang) {
  // 重入锁：模式切换(switchMode)重建中(switchInFlight)不重入，避免并发 destroy/new 致双实例/DOM 残留/内容丢失
  if (lang === currentLang || switchInFlight) return;
  currentLang = lang;
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

async function boot() {
  // md-editor 是 Markdown 编辑器，不需要麦克风；Vditor 自带 RecordMedia 录音模块会调
  // getUserMedia({audio:true}) 触发系统麦克风权限弹窗。启动即禁用，杜绝无谓的麦克风请求。
  if (navigator.mediaDevices) {
    (navigator.mediaDevices as unknown as { getUserMedia: unknown }).getUserMedia = () =>
      Promise.reject(new DOMException("microphone disabled in md-editor", "NotAllowedError"));
  }

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
  updateModeUI();
  applyAllText(); // 初始化静态文案到当前语言
  const langSel = document.getElementById("lang-select") as HTMLSelectElement | null;
  if (langSel) langSel.addEventListener("change", () => setLang(langSel.value as Lang));
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
  // 拖拽打开：用 Tauri 原生拖放事件（dragDropEnabled=true 时 OS 文件拖放由 Tauri 拦截，
  // HTML5 drop 拿不到文件 → 实测无反应）。原生事件能拿到真实路径，用 open_file 读取，保留路径可直存。
  try {
    await getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "drop" && event.payload.paths && event.payload.paths.length > 0) {
        const p = event.payload.paths[0];
        if (/\.(md|markdown|mdown|txt)$/i.test(p)) loadFile(p);
      }
    });
  } catch {
    // 非 tauri 环境忽略
  }

  document.getElementById("btn-open")!.addEventListener("click", async () => {
    const p = await openDialog({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] }],
    });
    if (p) loadFile(p as string);
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
}

window.addEventListener("DOMContentLoaded", boot);
