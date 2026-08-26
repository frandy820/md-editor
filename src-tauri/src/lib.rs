use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// 启动时从命令行参数传入的文件路径
struct StartupFile(Mutex<Option<String>>);

/// 允许打开/保存的扩展名（与前端 dialog/拖拽过滤口径一致）
const ALLOWED_EXTS: &[&str] = &["md", "markdown", "mdown", "txt"];

/// 路径扩展名是否在允许范围内（大小写不敏感）
fn has_allowed_ext(path: &str) -> bool {
    match std::path::Path::new(path).extension().and_then(|e| e.to_str()) {
        Some(ext) => ALLOWED_EXTS.iter().any(|a| a.eq_ignore_ascii_case(ext)),
        None => false,
    }
}

/// 从一组命令行参数中提取首个「扩展名合法且文件存在」的 markdown 路径。
/// 双击 .md 时 Windows 把路径作为参数传入；单实例二次启动转发时复用同一逻辑。
fn extract_md_from_args(mut args: impl Iterator<Item = String>) -> Option<String> {
    args.next(); // 跳过程序自身路径
    for a in args {
        if has_allowed_ext(&a) && std::path::Path::new(&a).is_file() {
            return Some(a);
        }
    }
    None
}

/// 取本进程启动参数中的文件路径（前端 invoke 兜底读取用）
fn extract_md_arg() -> Option<String> {
    extract_md_from_args(std::env::args())
}

/// 读取文件，自动探测编码：UTF-8 BOM / UTF-8 / 回落 GBK。返回 (内容, 编码名)
#[tauri::command]
fn open_file(path: String) -> Result<(String, String), String> {
    if !has_allowed_ext(&path) {
        return Err("不支持的文件类型（仅 md/markdown/mdown/txt）".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let (content, enc) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (
            String::from_utf8_lossy(&bytes[3..]).to_string(),
            "UTF-8(BOM)".to_string(),
        )
    } else {
        match std::str::from_utf8(&bytes) {
            Ok(s) => (s.to_string(), "UTF-8".to_string()),
            Err(_) => {
                let (cow, _, _) = encoding_rs::GBK.decode(&bytes);
                (cow.to_string(), "GBK".to_string())
            }
        }
    };
    Ok((content, enc))
}

/// 写文件，统一 UTF-8 无 BOM；临时文件 + rename 原子写，避免写入中断损坏原文件
#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    if !has_allowed_ext(&path) {
        return Err("不支持的保存路径（仅 md/markdown/mdown/txt）".into());
    }
    // 防护：拒绝用空内容覆盖非空文件（Vditor IR 模式 getValue 在 lute/异步未就绪时可能返回空串，
    // 避免空写把原文件清零）。新文件（不存在）或原本就空的文件允许写空。
    if content.is_empty() {
        if let Ok(existing) = fs::read(&path) {
            if !existing.is_empty() {
                return Err("拒绝写入空内容（原文件非空，疑似编辑器取值异常）".into());
            }
        }
    }
    let tmp = format!("{}.tmp", path);
    fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    // 同目录 rename 在 Windows 上原子覆盖目标文件
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

// ===== PDF 导出：调系统 msedge --headless --print-to-pdf =====
// 矢量（文本可选可搜）、Chromium 原生分页（任意长度、无 canvas 上限）、无对话框、零额外依赖。
// WebView2 runtime 是 Tauri 运行前提，任何能跑该 exe 的机器必有 msedge.exe。
// 导出 HTML 由独立 msedge 进程从 file:/// 加载，不经过 Tauri webview，
// 应用 CSP (script-src 'self') 不适用 → 内联样式/属性/file:// 资源不受限。

/// 唯一后缀：pid + 纳秒，保证并发/快速连点不撞名（与 tempdir() 测试辅助一致）
fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}_{}", std::process::id(), nanos)
}

/// 逐段数值比较版本号 a > b（长度不等时缺失段视为 0；不靠字符串比较，避免 "99" > "131"）
fn version_gt(a: &[u64], b: &[u64]) -> bool {
    let n = a.len().max(b.len());
    for i in 0..n {
        let av = a.get(i).copied().unwrap_or(0);
        let bv = b.get(i).copied().unwrap_or(0);
        if av != bv {
            return av > bv;
        }
    }
    false
}

/// 在 base 目录下扫描语义版本号子目录（如 150.0.4078.105），返回版本最大者下的 msedge.exe。
/// 非版本号目录（Installer / Application 等）忽略；子目录无 msedge.exe 忽略。
fn pick_versioned_msedge(base: &PathBuf) -> Option<PathBuf> {
    let entries = fs::read_dir(base).ok()?;
    let mut best: Option<(Vec<u64>, PathBuf)> = None;
    for e in entries.flatten() {
        let parts: Vec<u64> = e
            .file_name()
            .to_string_lossy()
            .split('.')
            .filter_map(|p| p.parse::<u64>().ok())
            .collect();
        if parts.is_empty() {
            continue; // 非纯数字点分（Installer 等）
        }
        let exe = e.path().join("msedge.exe");
        if !exe.is_file() {
            continue;
        }
        match &best {
            None => best = Some((parts, exe)),
            Some((bp, _)) => {
                if version_gt(&parts, bp) {
                    best = Some((parts, exe));
                }
            }
        }
    }
    best.map(|(_, exe)| exe)
}

/// 定位系统 Edge / WebView2 runtime 的 msedge.exe（多级回退，返回首个存在）。
/// 优先级：env → 系统 Edge(x86/x64) → WebView2 runtime。
/// 系统 Edge 优先于 WebView2 runtime：实测 WebView2 runtime 的 msedge.exe 不支持
/// --headless --print-to-pdf（退出码 13、无输出），而系统 Edge 正常生成矢量 PDF。
/// Win10/11 几乎必带系统 Edge；WebView2 runtime 仅作系统 Edge 缺席时的兜底。
fn locate_msedge() -> Result<PathBuf, String> {
    // 1. env WEBVIEW2_BROWSER_EXECUTABLE_FOLDER（部署方显式指定）
    if let Ok(dir) = std::env::var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER") {
        let exe = PathBuf::from(&dir).join("msedge.exe");
        if exe.is_file() {
            return Ok(exe);
        }
    }
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        bases.push(PathBuf::from(&pf86));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        bases.push(PathBuf::from(&pf));
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        bases.push(PathBuf::from(&la));
    }
    // 2. 系统 Edge：x86 → x64（headless print-to-pdf 实测可用，优先）
    for base in &bases {
        let exe = base.join("Microsoft").join("Edge").join("Application").join("msedge.exe");
        if exe.is_file() {
            return Ok(exe);
        }
    }
    // 3. WebView2 runtime：per-machine 与 per-user 都扫，各取最大版本号子目录（兜底）
    for base in &bases {
        let app_dir = base.join("Microsoft").join("EdgeWebView").join("Application");
        if let Some(exe) = pick_versioned_msedge(&app_dir) {
            return Ok(exe);
        }
    }
    Err("未找到支持 PDF 导出的 Edge 浏览器（msedge.exe）。请确认已安装 Microsoft Edge 浏览器后重试（WebView2 runtime 不支持 PDF 导出）。".into())
}

/// 本地路径转 file:// URL（Windows：反斜杠→正斜杠；非 ASCII/特殊字符 percent-encode，
/// 避免 temp 目录含中文/空格时 msedge 无法加载）
fn file_url_from_path(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file:///");
    for c in s.chars() {
        match c {
            c if c.is_ascii_alphanumeric() || matches!(c, ':' | '/' | '-' | '.' | '_' | '~') => {
                out.push(c)
            }
            _ => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).as_bytes() {
                    out.push_str(&format!("%{:02X}", b));
                }
            }
        }
    }
    out
}

/// 带超时执行子进程：spawn 后每 100ms 轮询 try_wait，超时则 kill。避免 msedge headless 卡死。
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<(), String> {
    let mut child = cmd.spawn().map_err(|e| format!("启动 msedge 失败：{e}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!("msedge 退出码非 0：{status}"))
                };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "msedge headless 导出超时（{}s），已终止",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("等待 msedge 退出失败：{e}")),
        }
    }
}

/// 自测用固定 HTML：中文标题 + 长文撑 2 页 + 28px span + 代码块 + 表格。
/// 供 --self-test-pdf 在无 GUI 下端到端验证 msedge 管线（部署机预检）。
fn self_test_html() -> String {
    let head = r#"<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
@page { size: A4; margin: 15mm; }
html,body{margin:0;padding:0;background:#fff;color:#000;
  font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",system-ui,sans-serif;
  font-size:14px;line-height:1.75;}
pre{white-space:pre-wrap;word-break:break-word;}
pre,table,tr{break-inside:avoid;}
table{border-collapse:collapse;} th,td{border:1px solid #888;padding:4px 8px;}
code{background:#f4f4f4;padding:2px 4px;border-radius:3px;}
</style></head><body>
<h1>导出 PDF 自测中文标题</h1>
<p>这是一段中文正文，用于验证 msedge headless 矢量打印管线是否正常工作。
<span style="font-size:28px">这是被放大到 28px 的文字。</span></p>
<h2>代码块测试</h2>
<pre><code>fn main() {
    println!("Hello, 世界");
}</code></pre>
<h2>表格测试</h2>
<table><thead><tr><th>项目</th><th>数值</th></tr></thead>
<tbody><tr><td>行一</td><td>100</td></tr><tr><td>行二</td><td>200</td></tr></tbody></table>
<h2>分页测试（撑满第二页）</h2>
"#;
    let body = "这是一行重复的长文本，用于把内容撑到第二页以验证 Chromium 分页是否正常。".repeat(120);
    format!("{}{}</body></html>", head, body)
}

/// RAII 临时资源清理守卫：注册的临时文件/目录在 Drop 时 best-effort 删除，
/// 覆盖 export_pdf 所有退出路径（含错误 return / panic），避免 temp 残留。
/// 对同一路径先后尝试 remove_file 与 remove_dir_all：是文件则前者生效，是目录则后者生效，互不干扰。
struct TmpClean(Vec<PathBuf>);
impl Drop for TmpClean {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = fs::remove_file(p);
            let _ = fs::remove_dir_all(p);
        }
    }
}

/// 导出 PDF 核心：调系统 msedge --headless --print-to-pdf 把 HTML 渲染成矢量 PDF。
/// 在三个可观测里程碑(page/printing/saving)调用 emit 回调推送真百分比：
/// 命令版 export_pdf 注入 AppHandle 发 Tauri 事件，self-test 版注入空回调（无 GUI，事件丢弃）。
fn render_pdf<F: Fn(&str, u8)>(html: String, path: String, emit: F) -> Result<(), String> {
    // 1. 校验扩展名与内容
    match std::path::Path::new(&path).extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("pdf") => {}
        _ => return Err("不支持的保存路径（仅 .pdf）".into()),
    }
    if html.trim().is_empty() {
        return Err("导出内容为空".into());
    }

    let msedge = locate_msedge()?;

    // 2. 临时资源：profile 每次用唯一目录（快速连点导出不撞 SingletonLock）；
    //    全部注册到 TmpClean，函数任意退出路径统一清理，temp 不残留。
    let tmp_dir = std::env::temp_dir();
    let profile_dir = tmp_dir.join(format!("md-editor-pdf-profile-{}", unique_suffix()));
    let html_path = tmp_dir.join(format!("md_export_{}.html", unique_suffix()));
    let mut clean = TmpClean(Vec::new());
    clean.0.push(html_path.clone());
    clean.0.push(profile_dir.clone());
    fs::write(&html_path, html.as_bytes())
        .map_err(|e| format!("写临时 HTML 失败：{e}"))?;
    // HTML 已组装落盘，即将启动打印引擎 —— 第一个可观测里程碑
    emit("page", 30);

    // 3. 临时 PDF：写到最终路径同目录（同目录 rename 才原子；跨卷会退化为复制）
    let final_dir = std::path::Path::new(&path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let tmp_pdf = final_dir.join(format!(".md_export_{}.pdf.tmp", unique_suffix()));
    clean.0.push(tmp_pdf.clone());
    let tmp_pdf_str = tmp_pdf.to_string_lossy().replace('\\', "/");

    // 4. msedge headless 打印
    let html_url = file_url_from_path(&html_path);
    // user-data-dir 必须用 = 连接：Edge 150 headless=new 会把空格分隔的 flag 值误判为
    // target URL，叠加 html_url 触发 "Multiple targets are not supported in headless mode"
    // （exit 13，本机实测复现）。等号连接后值内嵌进 flag，不再被当作独立 target。
    let profile_str = profile_dir.to_string_lossy().replace('\\', "/");
    let mut cmd = Command::new(&msedge);
    cmd.args([
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        "--virtual-time-budget=5000",
        "--run-all-compositor-stages-before-draw",
    ]);
    cmd.arg(format!("--user-data-dir={}", profile_str));
    cmd.arg(format!("--print-to-pdf={}", tmp_pdf_str));
    cmd.arg(&html_url);
    // Windows：CREATE_NO_WINDOW，避免闪命令行黑窗
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // 5. 带超时执行（失败/超时由 ? 提前 return，guard 兜底清理）
    //    打印引擎（msedge headless）是黑盒子：父进程无法读取其逐页/字节进度，
    //    只能在启动前发 "printing"；前端据此启动估算曲线平滑逼近 90%，真完成才跳 100%。
    emit("printing", 50);
    run_with_timeout(cmd, Duration::from_secs(30))?;

    // 6. 白纸校验：文件存在 + %PDF 魔数 + size > 2000（空白壳通常 < 2KB）
    if !tmp_pdf.is_file() {
        return Err("msedge 未生成 PDF 文件（导出失败）".into());
    }
    let bytes = fs::read(&tmp_pdf).map_err(|e| format!("读取生成的 PDF 失败：{e}"))?;
    if bytes.len() < 2000 {
        return Err(format!("生成的 PDF 异常过小（{} 字节，疑似空白）", bytes.len()));
    }
    if !bytes.starts_with(b"%PDF") {
        return Err("生成的文件不是有效 PDF（缺少 %PDF 魔数）".into());
    }

    // 白纸校验已过，PDF 内容就绪，正在原子落盘到目标路径 —— 最后一个可观测里程碑
    emit("saving", 95);
    // 7. 原子覆盖最终路径；rename 失败（目标被 PDF 阅读器占用）回落 copy+删。
    //    成功 return 后 guard 统一清理 html_path / profile_dir / 残留 tmp_pdf。
    if let Err(e) = fs::rename(&tmp_pdf, &path) {
        if let Err(e2) = fs::copy(&tmp_pdf, &path) {
            return Err(format!(
                "写入目标 PDF 失败：{e}（重试复制也失败：{e2}，目标文件可能正被 PDF 阅读器占用）"
            ));
        }
    }
    Ok(())
}

/// Tauri 命令版：前端 invoke 入口。注入 AppHandle，在里程碑点向前端 emit ("stage", pct) 真百分比。
#[tauri::command]
fn export_pdf(app: AppHandle, html: String, path: String) -> Result<(), String> {
    render_pdf(html, path, |stage, pct| {
        let _ = app.emit("export-pdf-progress", (stage, pct));
    })
}

/// 取启动时命令行传入的文件路径（前端启动后 invoke 兜底读取）
#[tauri::command]
fn get_startup_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.lock().ok()?.clone()
}

// ===== PDF 处理统一入口：打开 PDF 时智能分流（有源回源 / 无源调 PDF4QT）=====

/// 探测 PDF4QT 主编辑器可执行文件路径。PDF4QT 是组件式，无 PDF4QT.exe，PDF 编辑器组件是
/// Pdf4QtEditor.exe（同目录另有 Viewer/PageMaster/Diff/LaunchPad 等组件）。
/// 探测顺序：env PDF4QT_PATH → F:\software\PDF4QT（本机便携安装位）→ F:\PDF4QT →
/// ProgramFiles / ProgramFiles(x86) / LOCALAPPDATA 下 PDF4QT 子目录。
/// 探测不到返回 None → 前端回落 plugin-opener 用系统默认 PDF 程序打开。
fn locate_pdf4qt() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("PDF4QT_PATH") {
        let exe = PathBuf::from(&dir).join("Pdf4QtEditor.exe");
        if exe.is_file() {
            return Some(exe);
        }
    }
    let mut bases = Vec::new();
    bases.push(PathBuf::from("F:\\software"));
    bases.push(PathBuf::from("F:\\"));
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        bases.push(PathBuf::from(&pf86));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        bases.push(PathBuf::from(&pf));
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        bases.push(PathBuf::from(&la));
    }
    for base in &bases {
        let exe = base.join("PDF4QT").join("Pdf4QtEditor.exe");
        if exe.is_file() {
            return Some(exe);
        }
    }
    None
}

/// 查找 PDF 的同名源文件（.md/.markdown/.html/.htm）：取 PDF 所在目录 + 去扩展名 basename，
/// 依次探测同名各扩展名，返回首个存在的源路径。无源返回 None。
/// 供前端"打开 PDF → 有源则打开源编辑、改完重导出覆盖 PDF"的闭环使用。
#[tauri::command]
fn find_pdf_source(pdf_path: String) -> Option<String> {
    let p = std::path::Path::new(&pdf_path);
    let dir = p.parent().unwrap_or_else(|| std::path::Path::new(""));
    let stem = match p.file_stem().and_then(|s| s.to_str()) {
        Some(s) => s,
        None => return None,
    };
    for ext in &["md", "markdown", "html", "htm"] {
        let candidate = dir.join(format!("{}.{}", stem, ext));
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

/// 用外部 PDF4QT 打开无源 PDF 进行编辑。探测不到 PDF4QT 时返回 "PDF4QT_NOT_FOUND"，
/// 前端据此回落 plugin-opener（系统默认 PDF 程序）。GUI 程序 spawn 后立即返回，不 wait、不加 CREATE_NO_WINDOW。
#[tauri::command]
fn open_pdf_external(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    match p.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("pdf") => {}
        _ => return Err("仅支持打开 .pdf 文件".into()),
    }
    if !p.is_file() {
        return Err(format!("文件不存在：{}", path));
    }
    match locate_pdf4qt() {
        Some(exe) => {
            Command::new(&exe)
                .arg(&path)
                .spawn()
                .map_err(|e| format!("启动 PDF4QT 失败：{e}"))?;
            Ok(())
        }
        None => Err("PDF4QT_NOT_FOUND".into()),
    }
}

/// HTML5 拖放打开 PDF：前端读不到原始路径（WebView2 安全限制），把字节写临时文件再交 PDF4QT。
/// 复用 open_pdf_external 的探测/启动逻辑。仅 .pdf，限 5MB（更大文件应走「打开」按钮拿原路径）。
#[tauri::command]
fn open_dropped_pdf(content: Vec<u8>, name: String) -> Result<(), String> {
    if !name.to_lowercase().ends_with(".pdf") {
        return Err("仅支持 .pdf".into());
    }
    if content.len() > 5 * 1024 * 1024 {
        return Err("PDF 超过 5MB，请改用「打开」按钮选择文件".into());
    }
    // 名字不可信：只取 file_name，防路径穿越
    let safe_name = std::path::Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("dropped.pdf");
    let dir = std::env::temp_dir().join("md-editor-drag");
    fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    let tmp = dir.join(safe_name);
    fs::write(&tmp, &content).map_err(|e| format!("写入临时文件失败：{e}"))?;
    if safe_name == "__dnd_selftest__.pdf" {
        return Ok(()); // 自测哨兵：只验证临时文件已写入，不拉起 PDF4QT
    }
    open_pdf_external(tmp.to_string_lossy().into_owned())
}

/// 自测开关：启动参数含 --dnd-selftest 时为 true（供前端合成 drop 事件验证 HTML5 拖放全链路；常驻无害）
#[tauri::command]
fn dnd_selftest_enabled() -> bool {
    std::env::args().any(|a| a == "--dnd-selftest")
}

// ===== UI 状态持久化（显示比例等）：写 %APPDATA%/<identifier>/ui-state.json =====
// 不用 localStorage：WebView2 的 localStorage 磁盘刷盘异步，进程被强杀/崩溃即丢
// （e2e 里 taskkill //F 复现），文件写入是同步可靠的。
fn ui_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("ui-state.json"))
}

#[tauri::command]
fn load_ui_state(app: AppHandle) -> Option<serde_json::Value> {
    fs::read_to_string(ui_state_path(&app).ok()?).ok().and_then(|s| serde_json::from_str(&s).ok())
}

#[tauri::command]
fn save_ui_state(app: AppHandle, v: serde_json::Value) -> Result<(), String> {
    let p = ui_state_path(&app)?;
    fs::create_dir_all(p.parent().ok_or("no parent")?).map_err(|e| e.to_string())?;
    fs::write(&p, serde_json::to_string(&v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // --self-test-pdf <out.pdf>：无 GUI 端到端验证 msedge 管线（部署机预检 / 自动化测试）
    // 命中即用固定 HTML 走完整 export_pdf 管线后退出，不启动 GUI。
    let args_vec: Vec<String> = std::env::args().collect();
    if let Some(pos) = args_vec.iter().position(|a| a == "--self-test-pdf") {
        match args_vec.get(pos + 1) {
            Some(out) => match render_pdf(self_test_html(), out.clone(), |_, _| {}) {
                Ok(()) => {
                    println!("SELF_TEST_OK path={}", out);
                    std::process::exit(0);
                }
                Err(e) => {
                    eprintln!("SELF_TEST_ERR {}", e);
                    std::process::exit(1);
                }
            },
            None => {
                eprintln!("SELF_TEST_ERR --self-test-pdf 需要一个输出路径参数");
                std::process::exit(1);
            }
        }
    }

    let startup = extract_md_arg();

    tauri::Builder::default()
        // 单实例必须第一个注册：程序已运行时再次双击 .md，把文件路径转发给已运行实例
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let file = extract_md_from_args(argv.iter().cloned());
            if let Some(f) = file {
                let _ = app.emit("open-file", f);
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(StartupFile(Mutex::new(startup)))
        .invoke_handler(tauri::generate_handler![
            open_file,
            save_file,
            export_pdf,
            get_startup_file,
            find_pdf_source,
            open_pdf_external,
            open_dropped_pdf,
            load_ui_state,
            save_ui_state,
            dnd_selftest_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    // 测试产品代码本身（非镜像副本）：use super::* 直访私有函数，零可见性改动
    use super::*;
    use std::fs;

    #[test]
    fn ext_whitelist_normal() {
        for e in ["a.md", "a.markdown", "a.mdown", "a.txt"] {
            assert!(has_allowed_ext(e), "{e} 应通过");
        }
    }
    #[test]
    fn ext_uppercase_case_insensitive() {
        assert!(has_allowed_ext("README.MD"));
        assert!(has_allowed_ext("C:\\dir\\X.TXT"));
        assert!(has_allowed_ext("a.MdOwN"));
    }
    #[test]
    fn ext_no_extension_rejected() {
        assert!(!has_allowed_ext("README"));
        assert!(!has_allowed_ext(""));
    }
    #[test]
    fn ext_double_extension_rejected() {
        assert!(!has_allowed_ext("evil.md.exe"));
        assert!(!has_allowed_ext("evil.txt.bat"));
    }
    #[test]
    fn ext_dot_only_rejected() {
        assert!(!has_allowed_ext("."));
        assert!(!has_allowed_ext("file."));
    }
    #[test]
    fn ext_non_whitelisted_rejected() {
        assert!(!has_allowed_ext("a.docx"));
        assert!(!has_allowed_ext("a.html"));
        assert!(!has_allowed_ext("a.exe"));
    }
    #[test]
    fn ext_traversal_passes_ext_check() {
        // 路径穿越防护不在扩展名校验层（由前端正则+OS+用户选择兜底），此处仅验末段合法即通过
        assert!(has_allowed_ext("../evil.md"));
        assert!(!has_allowed_ext("../evil.exe"));
    }

    #[test]
    fn extract_picks_first_existing_md() {
        // 跳过程序名，取首个存在且扩展名合法的路径
        let dir = std::env::temp_dir().join("md_verify_extract");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let md = dir.join("real.md");
        fs::write(&md, "x").unwrap();
        let md_str = md.to_str().unwrap().to_string();
        let args = vec!["prog.exe".to_string(), "notexist.md".to_string(), md_str.clone()];
        assert_eq!(extract_md_from_args(args.into_iter()), Some(md_str));
        assert_eq!(extract_md_from_args(vec!["prog.exe".to_string()].into_iter()), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_atomic_overwrite_md() {
        let dir = std::env::temp_dir().join("md_verify_save1");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.md");
        fs::write(&p, "原内容").unwrap();
        save_file(p.to_str().unwrap().to_string(), "新内容".into()).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "新内容");
        assert!(!dir.join("a.md.tmp").exists(), "临时文件应被清理");
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn save_refuses_non_whitelisted() {
        let dir = std::env::temp_dir().join("md_verify_save2");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("evil.exe");
        let err = save_file(p.to_str().unwrap().to_string(), "x".into()).unwrap_err();
        assert!(err.contains("不支持的保存路径"), "实际错误: {err}");
        assert!(!p.exists());
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn save_refuses_double_ext() {
        let dir = std::env::temp_dir().join("md_verify_save3");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("trap.md.exe");
        assert!(save_file(p.to_str().unwrap().to_string(), "x".into()).is_err());
        assert!(!p.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    // ===== PDF 导出相关测试（locate_msedge 之外的纯逻辑分支；不触 msedge）=====
    #[test]
    fn version_gt_compares_numerically() {
        assert!(version_gt(&[131, 0], &[100, 0]));
        assert!(!version_gt(&[100, 0], &[131, 0])); // 不靠字符串比较
        assert!(version_gt(&[150, 0, 4078, 105], &[150, 0, 4078, 99]));
        assert!(!version_gt(&[1, 2, 3], &[1, 2, 3]));
        assert!(version_gt(&[1, 2, 4], &[1, 2])); // 长度不等，缺失段视为 0
    }

    #[test]
    fn pick_versioned_msedge_picks_highest() {
        let dir = tempdir();
        // 三个版本号目录 + Installer/Application 干扰目录
        fs::create_dir_all(dir.join("100.0.0.0")).unwrap();
        fs::write(dir.join("100.0.0.0").join("msedge.exe"), "x").unwrap();
        fs::create_dir_all(dir.join("131.0.2903.86")).unwrap();
        fs::write(dir.join("131.0.2903.86").join("msedge.exe"), "x").unwrap();
        fs::create_dir_all(dir.join("99.0")).unwrap();
        fs::write(dir.join("99.0").join("msedge.exe"), "x").unwrap();
        fs::create_dir_all(dir.join("Installer")).unwrap(); // 非纯数字点分，忽略
        fs::write(dir.join("Installer").join("msedge.exe"), "x").unwrap();
        let got = pick_versioned_msedge(&dir).expect("应选到最大版本");
        assert!(
            got.to_string_lossy().contains("131.0.2903.86"),
            "应选最大版本 131.0.2903.86，实际: {}",
            got.display()
        );
    }

    #[test]
    fn pick_versioned_msedge_empty_or_nonversion_dir() {
        let dir = tempdir();
        // 空目录
        assert!(pick_versioned_msedge(&dir).is_none());
        // 仅有非版本号子目录（无 exe）
        fs::create_dir_all(dir.join("Installer")).unwrap();
        assert!(pick_versioned_msedge(&dir).is_none());
        // 版本号目录但无 msedge.exe，忽略
        fs::create_dir_all(dir.join("1.0.0.0")).unwrap();
        assert!(pick_versioned_msedge(&dir).is_none());
    }

    #[test]
    fn export_pdf_rejects_non_pdf_ext() {
        // 非法扩展名在校验阶段返回，不触 msedge。直接测 render_pdf 核心管线（export_pdf wrapper
        // 需 AppHandle，无 app context 无法在单测里构造）。
        let dir = tempdir();
        let p = dir.join("out.txt");
        let err = render_pdf("<p>x</p>".into(), p.to_str().unwrap().to_string(), |_, _| {}).unwrap_err();
        assert!(err.contains("仅 .pdf"), "实际错误: {err}");
        assert!(!p.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unique_suffix_format() {
        let a = unique_suffix();
        let parts: Vec<&str> = a.splitn(2, '_').collect();
        assert_eq!(parts.len(), 2, "格式应为 pid_nanos: {}", a);
        assert_eq!(parts[0].parse::<u32>().unwrap(), std::process::id());
        assert!(parts[1].parse::<u128>().is_ok(), "nanos 部分应为数字: {}", a);
        // M1 核心不变量：连续两次调用必须不同（消除快速连点 SingletonLock）。
        // 若改 SystemTime 来源或时钟精度退化（如旧系统 15ms 回退路径），此断言作回归守卫。
        let b = unique_suffix();
        assert_ne!(a, b, "连续两次调用必须返回不同后缀（否则 profile 撞名）");
    }

    #[test]
    fn file_url_encodes_chinese_keeps_ascii() {
        let p = std::path::PathBuf::from(r"C:\Users\张三\file.html");
        let url = file_url_from_path(&p);
        assert!(url.starts_with("file:///C:/Users/"), "盘符/斜杠应保留: {}", url);
        // "张三" UTF-8 = E5 BC A0 E4 B8 89
        assert!(
            url.contains("%E5%BC%A0%E4%B8%89"),
            "中文应被 percent-encode: {}",
            url
        );
        assert!(url.ends_with("/file.html"), "纯 ASCII 文件名应原样: {}", url);
    }

    // ===== 以下移植自原 tests/logic.rs（镜像副本），改为直测产品函数，单一来源 =====
    fn tempdir() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        let id = format!(
            "md_edit_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        p.push(id);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn ext_multi_dot_md_passes() {
        // 仅看最后一段扩展名：tar.md / notes.md 合法
        assert!(has_allowed_ext("archive.tar.md"));
        assert!(has_allowed_ext("my.notes.md"));
    }

    #[test]
    fn extract_skips_disallowed_and_nonexistent() {
        let dir = tempdir();
        let real = dir.join("real.md");
        fs::write(&real, "x").unwrap();
        let got = extract_md_from_args(
            vec![
                "prog.exe".into(),
                "F:/no/such.exe".into(),
                dir.join("noexist.md").to_str().unwrap().into(),
                real.to_str().unwrap().into(),
            ]
            .into_iter(),
        );
        assert_eq!(got.as_deref(), Some(real.to_str().unwrap()));
    }

    #[test]
    fn extract_none_when_all_illegal() {
        let got = extract_md_from_args(
            vec!["prog.exe".into(), "a.exe".into(), "b.html".into()].into_iter(),
        );
        assert!(got.is_none());
    }

    #[test]
    fn save_atomic_overwrite_existing() {
        let dir = tempdir();
        let p = dir.join("exist.md");
        let old: String = (0..100).map(|i| format!("OLD_LINE_{}\n", i)).collect();
        fs::write(&p, &old).unwrap();
        save_file(p.to_str().unwrap().to_string(), "NEW_CONTENT".into()).unwrap();
        let got = fs::read_to_string(&p).unwrap();
        assert_eq!(got, "NEW_CONTENT");
        assert!(!got.contains("OLD_LINE"));
        assert!(!dir.join("exist.md.tmp").exists());
    }

    #[test]
    fn save_atomic_no_bom_written() {
        let dir = tempdir();
        let p = dir.join("nobom.md");
        save_file(p.to_str().unwrap().to_string(), "中文".into()).unwrap();
        let bytes = fs::read(&p).unwrap();
        assert!(!bytes.starts_with(&[0xEF, 0xBB, 0xBF]), "不应写 BOM");
    }

    #[test]
    fn save_refuses_empty_overwrite_nonempty() {
        // P0-1：空内容不能覆盖非空文件
        let dir = tempdir();
        let p = dir.join("nonempty.md");
        fs::write(&p, "有内容").unwrap();
        let err = save_file(p.to_str().unwrap().to_string(), "".into()).unwrap_err();
        assert!(err.contains("拒绝写入空内容"), "实际错误: {err}");
        assert_eq!(fs::read_to_string(&p).unwrap(), "有内容"); // 原文件未被破坏
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_allows_empty_when_file_new() {
        // 新文件（不存在）允许写空
        let dir = tempdir();
        let p = dir.join("new.md");
        save_file(p.to_str().unwrap().to_string(), "".into()).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_utf8_no_bom() {
        let dir = tempdir();
        let p = dir.join("a.md");
        fs::write(&p, "# 标题\n中文内容").unwrap();
        let (c, enc) = open_file(p.to_str().unwrap().to_string()).unwrap();
        assert_eq!(enc, "UTF-8");
        assert_eq!(c, "# 标题\n中文内容");
    }

    #[test]
    fn open_utf8_bom_stripped() {
        let dir = tempdir();
        let p = dir.join("b.md");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("# 标题".as_bytes());
        fs::write(&p, &bytes).unwrap();
        let (c, enc) = open_file(p.to_str().unwrap().to_string()).unwrap();
        assert_eq!(enc, "UTF-8(BOM)");
        assert_eq!(c, "# 标题");
    }

    #[test]
    fn open_gbk_fallback() {
        let dir = tempdir();
        let p = dir.join("g.md");
        let (gbk, _, _) = encoding_rs::GBK.encode("中文");
        fs::write(&p, &*gbk).unwrap();
        let (c, enc) = open_file(p.to_str().unwrap().to_string()).unwrap();
        assert_eq!(enc, "GBK");
        assert_eq!(c, "中文");
    }

    #[test]
    fn open_empty_file_utf8() {
        let dir = tempdir();
        let p = dir.join("e.md");
        fs::write(&p, "").unwrap();
        let (c, enc) = open_file(p.to_str().unwrap().to_string()).unwrap();
        assert_eq!(enc, "UTF-8");
        assert_eq!(c, "");
    }

    // T7 保存核心：save_file 写盘逻辑客观验证
    #[test]
    fn save_file_writes_utf8_no_bom_and_overwrites() {
        let dir = tempdir();
        let p = dir.join("s.md");
        // 初次写中文内容（含编辑器产生的标记），读回应与写入完全一致
        save_file(p.to_str().unwrap().to_string(), "# 标题\n正文 EDIT-789".to_string()).unwrap();
        let bytes = fs::read(&p).unwrap();
        assert!(!bytes.starts_with(&[0xEF, 0xBB, 0xBF]), "必须 UTF-8 无 BOM");
        assert_eq!(String::from_utf8(bytes).unwrap(), "# 标题\n正文 EDIT-789");
        // 原子覆盖：旧内容被新内容完整替换
        save_file(p.to_str().unwrap().to_string(), "新内容覆盖".to_string()).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "新内容覆盖");
        // rename 成功后临时文件不应残留
        assert!(!dir.join("s.md.tmp").exists(), "tmp 不应残留");
    }

    #[test]
    fn save_file_rejects_empty_overwrite_of_nonempty() {
        let dir = tempdir();
        let p = dir.join("guard.md");
        fs::write(&p, "已有内容").unwrap();
        let err = save_file(p.to_str().unwrap().to_string(), "".to_string()).unwrap_err();
        assert!(err.contains("空内容"), "空写防护应拦截，实际 err={err}");
        // 原文件未被清零
        assert_eq!(fs::read_to_string(&p).unwrap(), "已有内容");
    }

    #[test]
    fn save_file_rejects_bad_extension() {
        let dir = tempdir();
        let p = dir.join("a.docx");
        let err = save_file(p.to_str().unwrap().to_string(), "x".to_string()).unwrap_err();
        assert!(err.contains("不支持"), "非白名单扩展名应拒绝，实际 err={err}");
    }

    // ===== PDF 分流相关测试（find_pdf_source 各分支 / open_pdf_external reject）=====
    #[test]
    fn find_pdf_source_finds_md() {
        let dir = tempdir();
        fs::write(dir.join("report.pdf"), "%PDF-fake").unwrap();
        fs::write(dir.join("report.md"), "# 源").unwrap();
        let pdf = dir.join("report.pdf").to_str().unwrap().to_string();
        let got = find_pdf_source(pdf).expect("应找到 report.md");
        assert!(got.ends_with("report.md"), "实际: {}", got);
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn find_pdf_source_finds_html_when_no_md() {
        let dir = tempdir();
        fs::write(dir.join("doc.pdf"), "%PDF").unwrap();
        fs::write(dir.join("doc.html"), "<html/>").unwrap();
        let got = find_pdf_source(dir.join("doc.pdf").to_str().unwrap().to_string()).unwrap();
        assert!(got.ends_with("doc.html"), "实际: {}", got);
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn find_pdf_source_none_when_no_source() {
        let dir = tempdir();
        fs::write(dir.join("lonely.pdf"), "%PDF").unwrap();
        assert!(find_pdf_source(dir.join("lonely.pdf").to_str().unwrap().to_string()).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn find_pdf_source_priority_md_over_html() {
        let dir = tempdir();
        fs::write(dir.join("x.pdf"), "%PDF").unwrap();
        fs::write(dir.join("x.md"), "md").unwrap();
        fs::write(dir.join("x.html"), "html").unwrap();
        let got = find_pdf_source(dir.join("x.pdf").to_str().unwrap().to_string()).unwrap();
        assert!(got.ends_with("x.md"), "md 应优先于 html，实际: {}", got);
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn open_pdf_external_rejects_non_pdf() {
        let dir = tempdir();
        let p = dir.join("a.txt");
        fs::write(&p, "x").unwrap();
        let err = open_pdf_external(p.to_str().unwrap().to_string()).unwrap_err();
        assert!(err.contains("仅支持打开 .pdf"), "实际 err: {}", err);
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn open_pdf_external_rejects_missing_file() {
        let dir = tempdir();
        let p = dir.join("nope.pdf");
        let err = open_pdf_external(p.to_str().unwrap().to_string()).unwrap_err();
        assert!(err.contains("文件不存在"), "不存在的 pdf 应在探测前返回，实际 err: {}", err);
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn locate_pdf4qt_finds_installed_on_this_machine() {
        // 本机验证：PDF4QT 便携版 v1.6 装在 F:\software\PDF4QT，locate_pdf4qt 应找到 Pdf4QtEditor.exe。
        // 非本机环境（CI/其他机器未装）跳过而非失败。
        let expected = PathBuf::from("F:\\software\\PDF4QT\\Pdf4QtEditor.exe");
        if !expected.is_file() {
            return;
        }
        let got = locate_pdf4qt();
        assert_eq!(got, Some(expected), "应探测到 F:\\software\\PDF4QT\\Pdf4QtEditor.exe，实际: {:?}", got);
    }

    #[test]
    fn open_dropped_pdf_rejects_non_pdf_and_writes_temp_for_sentinel() {
        // 非 pdf 拒绝（不写文件）
        assert!(open_dropped_pdf(vec![b'%', b'P', b'D', b'F'], "a.txt".into()).is_err());
        // 哨兵 pdf：写临时文件 + 内容正确 + 不拉起 PDF4QT（Ok）
        let r = open_dropped_pdf(vec![0x25, 0x50, 0x44, 0x46], "__dnd_selftest__.pdf".into());
        assert!(r.is_ok(), "哨兵 pdf 应写临时并 Ok，实际: {:?}", r);
        let tmp = std::env::temp_dir().join("md-editor-drag").join("__dnd_selftest__.pdf");
        assert!(tmp.is_file(), "临时文件应存在: {:?}", tmp);
        assert_eq!(fs::read(&tmp).unwrap(), vec![0x25, 0x50, 0x44, 0x46], "临时文件内容应一致");
    }
}
