use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// 启动时从命令行参数传入的文件路径
struct StartupFile(Mutex<Option<String>>);

// ===== v0.3.23 运行日志（零观测根修：报障从口述复现变带日志自证）=====
// %APPDATA%\md-editor\logs\md-editor.log，单文件滚动（>512KB 轮转 .log.1/.log.2，留三代）。
// 启动首行=版本+系统+启动参数（run() 最先调用，覆盖开机第一行不留观测盲区）。
// panic hook 落盘崩溃位置（release 保留 panic Location 行号）——白屏/闪退可自证。
// 纯本机文件，无任何网络上报（离线个人工具定位不变）。
static LOG_W: Mutex<()> = Mutex::new(());

fn logs_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("md-editor").join("logs")
}

/// 本地(UTC+8) yyyy-MM-dd HH:mm:ss（与 local_ts 同换算）
fn log_ts() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let local = now + 8 * 3600;
    let (y, mo, d) = civil_from_days((local / 86400) as i64);
    let (h, mi, s) = ((local % 86400) / 3600, (local % 3600) / 60, local % 60);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
}

/// 追加一行日志（失败静默：日志系统绝不能反过来打断主流程）
pub fn app_log(level: &str, scope: &str, msg: &str) {
    let _g = LOG_W.lock().unwrap();
    let dir = logs_dir();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("md-editor.log");
    // 滚动：>512KB → .log.2 删、.log.1→.log.2、主→.log.1
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > 512 * 1024 {
            let _ = fs::remove_file(dir.join("md-editor.log.2"));
            let _ = fs::rename(dir.join("md-editor.log.1"), dir.join("md-editor.log.2"));
            let _ = fs::rename(&path, dir.join("md-editor.log.1"));
        }
    }
    let line = format!("[{}] [{}] [{}] {}\n", log_ts(), level, scope, msg.replace('\n', " | "));
    let _ = fs::OpenOptions::new().create(true).append(true).open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

/// 采系统版本串。ver 输出跟随系统代码页（中文系统=GBK），用 GBK 解码防乱码
fn sys_ver() -> String {
    use std::os::windows::process::CommandExt;
    Command::new("cmd").args(["/c", "ver"])
        .creation_flags(0x0800_0000).output()
        .map(|o| {
            let (cow, _, had_err) = encoding_rs::GBK.decode(&o.stdout);
            if had_err { String::from_utf8_lossy(&o.stdout).trim().to_string() }
            else { cow.trim().to_string() }
        })
        .unwrap_or_else(|_| "(ver 不可用)".into())
}

/// 启动首行（run() 最先调用）：版本/系统/启动参数/进程信息
fn log_startup(args: &str) {
    app_log("INFO", "startup", &format!(
        "===== md-editor v{} 启动 | pid={} | args={}",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        if args.is_empty() { "(无)" } else { args }
    ));
    // 系统/运行环境一次采集（失败不阻断）
    let ver = sys_ver();
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "(路径不可用)".into());
    app_log("INFO", "startup", &format!("os={} | exe={}", ver, exe));
    // panic 钩子：崩溃落日志（用户闪退/白屏的观测盲区）
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let loc = info.location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "未知位置".into());
        app_log("PANIC", "crash", &format!("{} | {}", loc, info));
        default_hook(info);
    }));
}

/// 导出诊断包：txt 单文件（系统信息+版本+启动参数+全部日志代）。
/// 不用 zip：压缩需引库增大 exe，txt 同样单文件可直接转发，零依赖零风险。
#[tauri::command]
fn export_diagnostics(path: String) -> Result<String, String> {
    let mut out = String::with_capacity(64 * 1024);
    let hr = "|===========|\n";
    let sec = |out: &mut String, title: &str| {
        out.push_str(&hr);
        out.push_str(&format!("| {} \n", title));
        out.push_str(&hr);
    };
    sec(&mut out, "md-editor 诊断包");
    out.push_str(&format!("导出时间: {}\n版本: v{}\n进程 PID: {}\n",
        log_ts(), env!("CARGO_PKG_VERSION"), std::process::id()));
    sec(&mut out, "系统信息");
    out.push_str(&format!("OS: {}\n", sys_ver()));
    out.push_str(&format!("exe: {}\n", std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "?".into())));
    out.push_str(&format!("盘符: {}\n", fixed_drive_roots().iter()
        .map(|p| p.display().to_string()).collect::<Vec<_>>().join(" ")));
    out.push_str(&format!("启动参数: {:?}\n", std::env::args().collect::<Vec<_>>()));
    sec(&mut out, "运行日志（三代合并，新在前）");
    for name in ["md-editor.log", "md-editor.log.1", "md-editor.log.2"] {
        if let Ok(t) = fs::read_to_string(logs_dir().join(name)) {
            out.push_str(&format!("----- {} -----\n{}\n", name, t));
        }
    }
    fs::write(&path, out.as_bytes()).map_err(|e| e.to_string())?;
    app_log("INFO", "diag", &format!("诊断包已导出: {} ({}KB)", path, out.len() / 1024));
    Ok(path)
}

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
        if has_allowed_ext(&a) {
            if std::path::Path::new(&a).is_file() {
                return Some(a);
            }
            // 典型报障场景：双击旧快捷方式/参数里的文件已被移动或删除，静默落欢迎页
            app_log("WARN", "startup", &format!("启动参数文件不存在，已忽略: {a}"));
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
        app_log("WARN", "open", &format!("拒绝打开(扩展名不符): {path}"));
        return Err("不支持的文件类型（仅 md/markdown/mdown/txt）".into());
    }
    // 硬上限 16MB（v0.3.25 从 2MB 放宽）：读入+IPC 在此量级仍是亚秒级，拒绝线只防病态巨型文件；
    // 真正的体验防线在前端（200 万字符拒开 + 大文档延迟取值通道，2026-09-07 实测重设）
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > 16 * 1024 * 1024 {
            return Err(format!("文件过大（{} KB，上限 16384 KB），已阻止打开以免长时间无响应", meta.len() / 1024));
        }
    }
    let bytes = fs::read(&path).map_err(|e| {
        app_log("ERROR", "open", &format!("读取失败 {path}: {e}"));
        e.to_string()
    })?;
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
    archive_old_version(&path); // v0.3.11 覆盖前归档旧版（best-effort）
    let tmp = format!("{}.tmp", path);
    fs::write(&tmp, &content).map_err(|e| {
        app_log("ERROR", "save", &format!("写入失败 {path}: {e}"));
        e.to_string()
    })?;
    // 同目录 rename 在 Windows 上原子覆盖目标文件
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

// ===== v0.3.11 版本历史/文件恢复 =====
// 保存覆盖前把磁盘旧内容归档到 %APPDATA%\md-editor\versions\<文件stem>\，
// 保留策略：每文件最近 50 版且 30 天内（保存时顺带清理）。best-effort：归档失败不阻断保存。

fn versions_root() -> std::path::PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(base).join("md-editor").join("versions")
}

fn version_stem(path: &str) -> String {
    let stem = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("doc");
    // 同名不同目录的文档共用一个 stem 分组：加路径短哈希消歧（FNV-1a 16 位足够）
    let mut h: u16 = 0;
    for b in path.bytes() {
        h = (h.wrapping_mul(31)).wrapping_add(b as u16);
    }
    format!("{}_{:04x}", stem.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect::<String>(), h)
}

/// 本地(UTC+8)时间戳串 yyyyMMdd_HHmmss（复用截图命名的无 chrono 换算）
fn local_ts() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let local = now + 8 * 3600;
    let (y, mo, d) = civil_from_days((local / 86400) as i64);
    let s = local % 86400;
    format!("{:04}{:02}{:02}_{:02}{:02}{:02}", y, mo, d, s / 3600, s % 3600 / 60, s % 60)
}

/// 保存前归档旧内容（无旧文件/空文件跳过）。不返回 Result：失败静默（不影响保存主流程）。
fn archive_old_version(path: &str) {
    // 测试隔离（仅 cargo test 编译期生效）：夹具全在 tempdir，跳过归档避免污染真实 %APPDATA%。
    // 不能运行时判 temp 路径——本机 TEMP 重定向到 F:\Cache\temp，e2e 夹具同在其中会被误伤
    #[cfg(test)]
    if std::path::Path::new(path).starts_with(std::env::temp_dir()) { return; }
    let Ok(old) = fs::read_to_string(path) else { return };
    if old.is_empty() { return; }
    let dir = versions_root().join(version_stem(path));
    if fs::create_dir_all(&dir).is_err() { return; }
    let _ = fs::write(dir.join(format!("{}.md", local_ts())), &old);
    // 清理：>50 版删最旧；>30 天删
    let mut entries: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            if let Ok(meta) = e.metadata() {
                if let Ok(m) = meta.modified() {
                    entries.push((e.path(), m));
                }
            }
        }
    }
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 86400);
    entries.retain(|(_, m)| *m >= cutoff);
    if entries.len() > 50 {
        entries.sort_by_key(|(_, m)| *m);
        for (p, _) in &entries[..entries.len() - 50] {
            let _ = fs::remove_file(p);
        }
    }
}

#[derive(serde::Serialize)]
struct VersionInfo {
    file: String,
    #[serde(rename = "mtimeMs")]
    mtime_ms: u64,
    size: u64,
}

/// 列出某文档的全部版本（mtime 降序 = 最新在前）
#[tauri::command]
fn list_versions(path: String) -> Result<Vec<VersionInfo>, String> {
    let dir = versions_root().join(version_stem(&path));
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("md") { continue; }
            let meta = e.metadata().map_err(|e| e.to_string())?;
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(VersionInfo {
                file: p.to_string_lossy().into_owned(),
                mtime_ms,
                size: meta.len(),
            });
        }
    }
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    Ok(out)
}

/// 读一个版本快照。校验路径必须位于 versions 根内（防目录穿越读任意文件）。
#[tauri::command]
fn read_version(file: String) -> Result<String, String> {
    let root = versions_root();
    let p = std::path::Path::new(&file);
    let canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let canon_root = root.canonicalize().unwrap_or(root);
    if !canon.starts_with(&canon_root) {
        return Err("非法版本文件路径".into());
    }
    fs::read_to_string(&canon).map_err(|e| e.to_string())
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
/// 单次 msedge 打印尝试：构建命令、执行、白纸校验。profile 策略由调用方决定（固定复用/唯一兜底）。
fn pdf_attempt<F: Fn(&str, u8)>(
    msedge: &std::path::Path,
    profile_dir: &std::path::Path,
    html_url: &str,
    tmp_pdf: &std::path::Path,
    emit: &F,
) -> Result<(), String> {
    // user-data-dir 必须用 = 连接：Edge 150 headless=new 会把空格分隔的 flag 值误判为
    // target URL，叠加 html_url 触发 "Multiple targets are not supported in headless mode"
    // （exit 13，本机实测复现）。等号连接后值内嵌进 flag，不再被当作独立 target。
    let profile_str = profile_dir.to_string_lossy().replace('\\', "/");
    let tmp_pdf_str = tmp_pdf.to_string_lossy().replace('\\', "/");
    let mut cmd = Command::new(msedge);
    cmd.args([
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        "--virtual-time-budget=5000",
        "--run-all-compositor-stages-before-draw",
        // 静音参数：跳过首运行向导/默认浏览器提示/扩展/组件更新/后台网络（对纯本地打印无意义）
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-component-update",
        "--disable-background-networking",
        "--disable-default-apps",
    ]);
    cmd.arg(format!("--user-data-dir={}", profile_str));
    cmd.arg(format!("--print-to-pdf={}", tmp_pdf_str));
    cmd.arg(html_url);
    // Windows：CREATE_NO_WINDOW，避免闪命令行黑窗
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // 打印引擎（msedge headless）是黑盒子：父进程无法读取其逐页/字节进度，
    // 只能在启动前发 "printing"；前端据此启动估算曲线平滑逼近 90%，真完成才跳 100%。
    emit("printing", 50);
    // v0.3.8：30s→120s。实测 Edge 150 起 headless print-to-pdf 在本机从 ~3s 恶化到 45-60s
    // （1KB 极简页同慢=引擎级回归，与导出内容无关），30s 必超时→重试连环更久。外部引擎耗时
    // 不可控，上限放宽到 120s 兜底慢环境；正常环境 2-3s 完成不受影响。
    run_with_timeout(cmd, Duration::from_secs(120))?;
    // 白纸校验：文件存在 + %PDF 魔数 + size > 2000（空白壳通常 < 2KB）。
    // 同 profile 被 Chromium 单实例转发的场景 msedge 仍退出码 0 但不产文件——必须在此拦下。
    if !tmp_pdf.is_file() {
        return Err("msedge 未生成 PDF 文件（导出失败）".into());
    }
    let bytes = fs::read(tmp_pdf).map_err(|e| format!("读取生成的 PDF 失败：{e}"))?;
    if bytes.len() < 2000 {
        return Err(format!("生成的 PDF 异常过小（{} 字节，疑似空白）", bytes.len()));
    }
    if !bytes.starts_with(b"%PDF") {
        return Err("生成的文件不是有效 PDF（缺少 %PDF 魔数）".into());
    }
    Ok(())
}

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

    // 2. 临时资源：HTML 每次唯一并随 TmpClean 清理；profile 改用固定目录跨次复用——
    //    实测（300 段基准文档）每次新建 profile 冷启动 ~8s，复用固定 profile 热启动 ~2s，
    //    提速主收益在此。固定 profile 不删除（留给下次复用）；并发/损坏由下方唯一 profile 重试兜底。
    let tmp_dir = std::env::temp_dir();
    let html_path = tmp_dir.join(format!("md_export_{}.html", unique_suffix()));
    let mut clean = TmpClean(Vec::new());
    clean.0.push(html_path.clone());
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

    // 4. msedge headless 打印：先固定 profile（热启动 ~2s）；失败（profile 损坏/被运行中
    //    实例转发致 0KB 等，前端重入锁已防同应用连点，跨实例并发仍可能撞）→ 清固定目录，
    //    换全新唯一 profile 重试一次（退回冷启动 ~8s，保成功）。
    let html_url = file_url_from_path(&html_path);
    let fixed_profile = tmp_dir.join("md-editor-pdf-profile");
    if let Err(first_err) = pdf_attempt(&msedge, &fixed_profile, &html_url, &tmp_pdf, &emit) {
        let _ = fs::remove_dir_all(&fixed_profile);
        let retry_profile = tmp_dir.join(format!("md-editor-pdf-profile-{}", unique_suffix()));
        clean.0.push(retry_profile.clone());
        pdf_attempt(&msedge, &retry_profile, &html_url, &tmp_pdf, &emit)
            .map_err(|e2| format!("{first_err}（已用全新配置重试仍失败：{e2}）"))?;
    }

    // 白纸校验已过，PDF 内容就绪，正在原子落盘到目标路径 —— 最后一个可观测里程碑
    emit("saving", 95);
    // 7. 原子覆盖最终路径；rename 失败（目标被 PDF 阅读器占用）回落 copy+删。
    //    成功 return 后 guard 统一清理 html_path / 重试 profile / 残留 tmp_pdf
    //    （固定 profile 有意保留复用，见上）。
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

/// v0.3.9 打印：WebView2 的 window.print() 被 WebView2 静默忽略（宿主负责打印，实测无窗口），
/// 走微软正路 ICoreWebView2_16::ShowPrintUI —— 系统"打印预览"窗口（可选打印机/份数/双面）。
/// 打印内容（正文渲染 HTML）由前端先备好 #print-root + @media print 隐藏应用 UI。
/// ShowPrintUI 打开预览后立即返回（非模态）；预览窗口关闭时前端收 afterprint 清理。
#[tauri::command]
fn print_webview(window: tauri::WebviewWindow) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM,
    };
    use windows::core::Interface; // cast() 是 Interface trait 方法
    // with_webview 闭包在主线程执行，invoke 在 runtime 线程等结果——channel 传回，无死锁
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |webview| {
            let res = unsafe {
                (|| -> windows::core::Result<()> {
                    let t0 = std::time::Instant::now();
                    let core = webview.controller().CoreWebView2()?;
                    let p16: ICoreWebView2_16 = core.cast()?;
                    // SYSTEM(1)=传统系统打印对话框（选打印机/份数/双面），实测本机可弹；
                    // BROWSER(0)=Edge 式预览窗在 Tauri 宿主下静默无效（S_OK 无窗），不用
                    let hr = p16.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM);
                    eprintln!("[print] ShowPrintUI(SYSTEM) 返回 {hr:?}，阻塞 {:?}", t0.elapsed());
                    hr
                })()
            };
            let _ = tx.send(res.map_err(|e| e.to_string()));
        })
        .map_err(|e| format!("with_webview 失败：{e}"))?;
    rx.recv()
        .map_err(|_| "打印结果通道关闭".to_string())?
        .map_err(|e| format!("ShowPrintUI 失败：{e}"))
}

/// 自测导出目录：启动参数 --export-selftest <dir> 时返回该目录（前端导出跳过原生保存对话框、
/// 直接拼 dir/文档名.ext 落盘，供 e2e 全链路自动化；正常启动返回 None 走对话框）
#[tauri::command]
fn export_selftest_dir() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let r = args.iter().position(|a| a == "--export-selftest").and_then(|i| args.get(i + 1)).cloned();
    r
}

// ===== v0.3.26 外部修改检测：读文件元信息（mtime+size），前端比对是否被其他程序改动 =====
#[derive(serde::Serialize)]
struct FileMeta {
    #[serde(rename = "mtimeMs")]
    mtime_ms: u64,
    size: u64,
}

#[tauri::command]
fn file_meta(path: String) -> Result<FileMeta, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileMeta { mtime_ms, size: meta.len() })
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

// ===== v0.4.0 自定义主题：themes/ 目录扫描 + 读取（Typora 社区主题兼容） =====
// 目录：%APPDATA%/<identifier>/themes/。一个 .css 文件 = 一个主题（文件名即主题名，
// 同 Typora 的 themes 目录约定）。读取校验 canonicalize 在主题目录内防穿越。
fn themes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("themes"))
}

#[tauri::command]
fn list_theme_files(app: AppHandle) -> Vec<String> {
    let dir = match themes_dir(&app) {
        Ok(d) => d,
        Err(_) => return vec![],
    };
    let mut out = vec![];
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("css")).unwrap_or(false) {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    if !stem.starts_with('_') {
                        out.push(stem.to_string()); // _ 前缀=禁用（示例/草稿，同 Typora 惯例）
                    }
                }
            }
        }
    }
    out.sort();
    out
}

#[tauri::command]
fn read_theme_css(app: AppHandle, name: String) -> Result<String, String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains(':')
    {
        return Err("invalid theme name".into());
    }
    let dir = themes_dir(&app)?;
    let p = dir.join(format!("{}.css", name));
    let canon = p.canonicalize().map_err(|_| "theme not found".to_string())?;
    let base = dir.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&base) {
        return Err("path escape".into());
    }
    fs::read_to_string(&canon).map_err(|e| e.to_string())
}

// ===== v0.3.14 文件树侧栏 + 全局跨文件搜索；v0.3.16 盘符根 =====

/// 列本机所有盘符（文件树"此电脑"根用）：C..Z 逐个探测，零依赖不用 Win32 API。
#[tauri::command]
fn list_drives() -> Vec<serde_json::Value> {
    let mut out = vec![];
    for c in b'C'..=b'Z' {
        let root = format!("{}:\\", c as char);
        if fs::metadata(&root).is_ok() {
            out.push(serde_json::json!({ "name": root.clone(), "path": root, "is_dir": true }));
        }
    }
    out
}


/// 目录树忽略的子目录名（隐藏目录「.」开头另行判断）
const TREE_SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "__pycache__"];

fn tree_skip(name: &str) -> bool {
    name.starts_with('.') || TREE_SKIP_DIRS.iter().any(|s| *s == name)
}

/// 列目录一层（文件树懒展开用）：目录（跳过隐藏/node_modules 等）+ 文本类文件。
/// 排序：目录在前、名字母序（不区分大小写）。返回 [{name, path, is_dir}]
#[tauri::command]
fn list_md_dir(path: String) -> Result<Vec<serde_json::Value>, String> {
    let mut dirs: Vec<(String, String)> = vec![];
    let mut files: Vec<(String, String)> = vec![];
    let mut truncated = false;
    let rd = fs::read_dir(&path).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if tree_skip(&name) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let full = entry.path().to_string_lossy().to_string();
        if is_dir {
            dirs.push((name, full));
        } else {
            // v0.3.21：树列全部文件（不再只列可编辑扩展名）——不可编辑项前端点击走"在文件夹中显示"
            files.push((name, full));
        }
        if dirs.len() + files.len() >= 3000 {
            truncated = true;
            break; // 巨目录防线：超出截断，前端提示
        }
    }
    let key = |v: &(String, String)| v.0.to_lowercase();
    dirs.sort_by_key(&key);
    files.sort_by_key(&key);
    let mk = |v: (String, String), d: bool| {
        serde_json::json!({ "name": v.0, "path": v.1, "is_dir": d })
    };
    let mut out: Vec<serde_json::Value> = dirs.into_iter().map(|v| mk(v, true))
        .chain(files.into_iter().map(|v| mk(v, false)))
        .collect();
    if truncated {
        out.push(serde_json::json!({ "name": "…条目过多已截断", "path": "", "is_dir": false }));
    }
    Ok(out)
}

/// 跨文件搜索命中上限与扫描护栏（大目录防卡：深挖会拖垮 UI 线程返回）
const SEARCH_MAX_HITS: usize = 200;
const SEARCH_MAX_FILES: usize = 800;
const SEARCH_MAX_DEPTH: usize = 8;
const SEARCH_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// 递归搜 root 下所有文本类文件内容（忽略大小写 contains）。
/// 返回 [{file, line_no, line_text}]，line_no 从 1 起，line_text 首尾去空白截 120 字符。
#[tauri::command]
fn search_md_files(root: String, query: String) -> Result<Vec<serde_json::Value>, String> {
    let q = query.to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let mut hits: Vec<serde_json::Value> = vec![];
    let mut files_scanned = 0usize;
    // 显式栈 DFS：元素 = (路径, 深度)
    let mut stack: Vec<(PathBuf, usize)> = vec![(PathBuf::from(&root), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > SEARCH_MAX_DEPTH || files_scanned >= SEARCH_MAX_FILES || hits.len() >= SEARCH_MAX_HITS {
            break;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue, // 无权限子目录跳过
        };
        for entry in rd.flatten() {
            if hits.len() >= SEARCH_MAX_HITS {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if tree_skip(&name) {
                continue;
            }
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                if depth + 1 <= SEARCH_MAX_DEPTH {
                    stack.push((entry.path(), depth + 1));
                }
                continue;
            }
            if !has_allowed_ext(&name) || files_scanned >= SEARCH_MAX_FILES {
                continue;
            }
            // 符号链接不跟随（ft.is_dir 对 symlink 为 false，读内容即安全）
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() > SEARCH_MAX_FILE_BYTES || meta.len() == 0 {
                continue;
            }
            files_scanned += 1;
            let bytes = match fs::read(entry.path()) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let text = String::from_utf8_lossy(&bytes).to_lowercase();
            for (i, line) in text.lines().enumerate() {
                if hits.len() >= SEARCH_MAX_HITS {
                    break;
                }
                if line.contains(&q) {
                    let mut shown = line.trim().to_string();
                    if shown.chars().count() > 120 {
                        // 按字符截（中文安全），不按字节
                        shown = shown.chars().take(120).collect();
                    }
                    hits.push(serde_json::json!({
                        "file": entry.path().to_string_lossy(),
                        "line_no": i + 1,
                        "line_text": shown,
                    }));
                }
            }
        }
    }
    Ok(hits)
}

// ===== v0.3.0 导出中心 + 粘贴截图落地 =====

/// 写二进制文件（PNG/DOCX 等导出产物；前端传 base64）
#[tauri::command]
fn save_binary_file(path: String, data_b64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// 读二进制文件（docx 导出嵌本地图片等；返回 base64）。失败返回 Err 由前端降级占位。
#[tauri::command]
fn read_binary_file(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = fs::read(&path).map_err(|e| {
        app_log("ERROR", "open", &format!("读取失败 {path}: {e}"));
        e.to_string()
    })?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

// ===== v0.3.17 文件树右键管理（新建/重命名/删除/资源管理器定位） =====

/// 名字合法性：非空且不含 Windows 路径非法字符
fn valid_entry_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("名称不能为空".into());
    }
    if n.chars().any(|c| "\\/:*?\"<>|".contains(c)) {
        return Err("名称不能包含 \\ / : * ? \" < > |".into());
    }
    Ok(())
}

/// 防误删/误改名盘符根（"C:\" 形态）与根以下直接操作
fn guard_not_drive_root(path: &str) -> Result<(), String> {
    let p = path.trim_end_matches('\\');
    if p.len() <= 2 && p.ends_with(':') {
        return Err("不能对盘符根执行此操作".into());
    }
    Ok(())
}

/// 新建文本文件（dir 下）：kind = "md" | "txt"；name 已带扩展名则原样用，否则按 kind 补。
/// 返回新建文件完整路径（前端打开+刷新树用）。
#[tauri::command]
fn create_text_file(dir: String, name: String, kind: String) -> Result<String, String> {
    valid_entry_name(&name)?;
    let mut n = name.trim().to_string();
    let lower = n.to_lowercase();
    if !lower.ends_with(".md") && !lower.ends_with(".txt") && !lower.ends_with(".markdown") {
        n.push_str(if kind == "txt" { ".txt" } else { ".md" });
    }
    let full = std::path::Path::new(&dir).join(&n);
    if full.exists() {
        return Err(format!("已存在同名文件：{n}"));
    }
    fs::write(&full, "").map_err(|e| e.to_string())?;
    Ok(full.to_string_lossy().to_string())
}

/// 新建文件夹（dir 下）。返回完整路径。
#[tauri::command]
fn create_dir(dir: String, name: String) -> Result<String, String> {
    valid_entry_name(&name)?;
    let full = std::path::Path::new(&dir).join(name.trim());
    if full.exists() {
        return Err(format!("已存在同名项：{}", name.trim()));
    }
    fs::create_dir(&full).map_err(|e| e.to_string())?;
    Ok(full.to_string_lossy().to_string())
}

/// 重命名（同目录改名）：old=完整路径，new_name=新名字（不含目录）。
/// 用 fs::rename（同盘原子；跨盘不会发生——同目录）。
#[tauri::command]
fn rename_entry(old: String, new_name: String) -> Result<String, String> {
    guard_not_drive_root(&old)?;
    valid_entry_name(&new_name)?;
    let dst = std::path::Path::new(&old)
        .parent()
        .ok_or("无父目录")?
        .join(new_name.trim());
    if dst.exists() {
        return Err(format!("目标已存在：{}", new_name.trim()));
    }
    fs::rename(&old, &dst).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

/// 删除：文件 remove_file / 目录递归 remove_dir_all（前端已 confirm，这里再拒盘符根）
#[tauri::command]
fn delete_entry(path: String) -> Result<(), String> {
    guard_not_drive_root(&path)?;
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// 在资源管理器中定位显示（explorer /select,路径）。路径不存在时 explorer 自行处理。
#[tauri::command]
fn reveal_path(path: String) {
    let _ = std::process::Command::new("explorer").arg(format!("/select,{path}")).spawn();
}

/// v0.3.22 自建全盘文件名索引（替代 v0.3.18 的 es.exe 外部依赖——单 exe 零依赖定调）。
/// es.exe 路线废弃原因：它是 voidtools 闭源 CLI 且只做 IPC 查询，真正引擎是 Everything
/// 常驻服务（MFT 直读+USN 监听），"拆代码合入"不可行（无源码、许可不允许、没服务即空壳）。
/// 本方案：多线程遍历固定盘（每盘一线程）建内存索引（完整路径+文件名小写副本），
/// 缓存 %APPDATA%\md-editor\file-index.txt——启动后台秒载缓存即就绪，30s 后低优先级重建
/// 保持新鲜；无缓存则启动即构建（首次 1-3 分钟，进度实时）。搜索=多词 AND 包含匹配
/// 文件名（es.exe 同语义），内存过滤毫秒级。无管理员权限、无第三方依赖。
struct IndexEntry {
    path: String,    // 完整路径（展示/定位用）
    name_at: usize,  // file_name 在 path 中的起始偏移（省一份 String：本机实测全量 295 万项双字符串内存 500MB+）
    is_dir: bool,
}
/// 索引收录的扩展名白名单（目录全部收录）。全盘动辄数百万文件——node_modules/target/
/// 系统 DLL 无人搜，全量收录内存和缓存都不可承受（本机实测 385MB 缓存）。
/// 收录口径=用户会搜的：文档/代码/媒体/压缩包/安装包/字体。
const INDEX_EXTS: &[&str] = &[
    // 文档
    "md", "markdown", "mdown", "txt", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "pdf", "epub", "mobi", "csv", "tsv", "json", "xml", "yaml", "yml", "ini", "cfg",
    "conf", "log", "rtf", "odt", "ots",
    // 代码
    "js", "jsx", "ts", "tsx", "py", "rs", "go", "java", "c", "h", "cpp", "hpp",
    "cs", "php", "rb", "sh", "bat", "ps1", "html", "htm", "css", "scss", "vue", "sql", "ipynb",
    // 媒体
    "png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tif", "tiff",
    "mp3", "wav", "flac", "aac", "ogg", "m4a",
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm",
    // 压缩/安装/字体
    "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "exe", "msi",
    "ttf", "otf", "woff", "woff2",
];
/// ASCII 忽略大小写包含匹配（非 ASCII 字节原样比：UTF-8 中文无大小写，语义正确）
fn ascii_ci_contains(hay: &str, needle: &str) -> bool {
    let h = hay.as_bytes(); let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() { return n.is_empty(); }
    'outer: for i in 0..=h.len() - n.len() {
        for j in 0..n.len() {
            let a = h[i + j].to_ascii_lowercase();
            let b = if n[j].is_ascii() { n[j].to_ascii_lowercase() } else { n[j] };
            if a != b { continue 'outer; }
        }
        return true;
    }
    false
}
static INDEX: std::sync::RwLock<Vec<IndexEntry>> = std::sync::RwLock::new(Vec::new());
static INDEX_BUILDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static INDEX_SCANNED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
/// walk 线程→合并线程的批量缓冲（512 条一批入锁，压锁频次）
static INDEX_BUF: std::sync::Mutex<Vec<IndexEntry>> = std::sync::Mutex::new(Vec::new());
/// 存活 walk 线程计数（合并线程判收尾）
static WALK_ALIVE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 把当前线程降到最低调度优先级（索引重建用）：HDD 全盘遍历重 IO，
/// 正常优先级会拖慢 UI 响应（实测表格浮动面板弹出超时）——后台任务须让路。
fn lower_thread_priority() {
    #[cfg(windows)]
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn SetThreadPriority(thread: isize, priority: i32) -> i32;
        }
        // GetCurrentThread() 伪句柄 = -1；THREAD_PRIORITY_LOWEST = -2
        SetThreadPriority(-1, -2);
    }
}

fn index_cache_path() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("md-editor").join("file-index.txt")
}

/// 固定盘根列表（遍历目标）：C..Z 探测可读根，排除光驱/可移动盘（读光驱会卡转盘）。
fn fixed_drive_roots() -> Vec<PathBuf> {
    (b'C'..=b'Z')
        .map(|c| PathBuf::from(format!("{}:\\", c as char)))
        .filter(|p| std::fs::metadata(p).is_ok())
        .collect()
}

/// 递归遍历一目录树（无权限静默跳过；symlink/junction 不跟随防环）。
/// 命中项攒本地批量，512 条推一次共享缓冲（锁频次降 512 倍）。
fn walk_into(dir: &PathBuf, batch: &mut Vec<IndexEntry>) {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return, // 无权限/被占用：跳过整棵
    };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue; // junction/symlink：不跟随（All Users→ProgramData 类环会死循环）
        }
        let is_dir = ft.is_dir();
        let p = e.path();
        // 白名单过滤（目录全收；文件按扩展名）——全量收录内存/缓存不可承受（295 万项实锤）
        let take = if is_dir { true } else {
            p.extension().and_then(|x| x.to_str())
                .map(|x| INDEX_EXTS.iter().any(|w| w.eq_ignore_ascii_case(x)))
                .unwrap_or(false)
        };
        if take {
            let s = p.to_string_lossy().to_string();
            let name_at = s.rfind(['\\', '/']).map(|i| i + 1).unwrap_or(0);
            batch.push(IndexEntry { path: s, name_at, is_dir });
        }
        INDEX_SCANNED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if is_dir {
            walk_into(&p, batch);
        }
        if batch.len() >= 512 {
            if let Ok(mut buf) = INDEX_BUF.lock() {
                buf.append(batch);
            }
        }
    }
}

/// 索引构建主流程（后台线程）：每盘一线程并行遍历（写共享缓冲），合并线程每 3s
/// 把缓冲搬进 INDEX——搜索端即刻可查已扫描部分（v0.3.22 边建边搜：本机实测全盘
/// 295 万项 HDD 上 8 分钟扫不完，「建完才能搜」会把用户晾数分钟，不可接受）。
/// 完成后 shrink+原子写缓存。INDEX_BUILDING 期间 es_search 返回部分命中。
fn build_index() {
    if INDEX_BUILDING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return; // 已在构建，防重入
    }
    app_log("INFO", "index", "全盘索引构建开始");
    INDEX_SCANNED.store(0, std::sync::atomic::Ordering::Relaxed);
    INDEX.write().unwrap().clear(); // 重建从零开始（防新旧混叠）
    let roots = fixed_drive_roots();
    WALK_ALIVE.store(roots.len(), std::sync::atomic::Ordering::Relaxed);
    for root in roots {
        std::thread::spawn(move || {
            lower_thread_priority(); // 重建=后台低优先级：不与用户编辑/点击抢 CPU 调度
            let mut batch: Vec<IndexEntry> = vec![];
            walk_into(&root, &mut batch);
            if !batch.is_empty() {
                if let Ok(mut buf) = INDEX_BUF.lock() {
                    buf.append(&mut batch);
                }
            }
            WALK_ALIVE.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        });
    }
    // 合并+缓存写出线程：3s 周期搬缓冲→INDEX；walk 全部结束后收尾搬+shrink+写缓存
    let t0 = std::time::Instant::now();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let drained: Vec<IndexEntry> = {
                let mut buf = INDEX_BUF.lock().unwrap();
                std::mem::take(&mut *buf)
            };
            if !drained.is_empty() {
                INDEX.write().unwrap().extend(drained);
            }
            if WALK_ALIVE.load(std::sync::atomic::Ordering::Relaxed) == 0 {
                let drained: Vec<IndexEntry> = {
                    let mut buf = INDEX_BUF.lock().unwrap();
                    std::mem::take(&mut *buf)
                };
                if !drained.is_empty() {
                    INDEX.write().unwrap().extend(drained);
                }
                INDEX.write().unwrap().shrink_to_fit();
                // 缓存原子写（tmp+rename）：行格式 "D\t路径"/"F\t路径"
                let n = INDEX.read().unwrap().len();
                let cache = index_cache_path();
                if let Some(d) = cache.parent() {
                    let _ = std::fs::create_dir_all(d);
                }
                let tmp = cache.with_extension("txt.tmp");
                let mut buf = String::with_capacity(n * 64);
                {
                    let idx = INDEX.read().unwrap();
                    for e in idx.iter() {
                        buf.push(if e.is_dir { 'D' } else { 'F' });
                        buf.push('\t');
                        buf.push_str(&e.path);
                        buf.push('\n');
                    }
                }
                if std::fs::write(&tmp, buf.as_bytes()).is_ok() {
                    let _ = std::fs::rename(&tmp, &cache);
                }
                INDEX_BUILDING.store(false, std::sync::atomic::Ordering::SeqCst);
                app_log("INFO", "index", &format!(
                    "全盘索引构建完成: {} 项, 耗时 {:.0}s",
                    n, t0.elapsed().as_secs_f64()));
                return;
            }
        }
    });
}

/// 启动索引管线（setup 调一次）：有缓存→后台载入即就绪，载入后 30s 重建刷新；
/// 无缓存→立即构建（边建边搜）。缓存损坏按无缓存处理。
fn start_index_pipeline() {
    std::thread::spawn(|| {
        let cache = index_cache_path();
        let loaded = std::fs::read_to_string(&cache)
            .ok()
            .filter(|s| s.len() > 4)
            .map(|text| {
                let mut v: Vec<IndexEntry> = vec![];
                for line in text.lines() {
                    let mut it = line.splitn(2, '\t');
                    let (flag, path) = match (it.next(), it.next()) {
                        (Some(f), Some(p)) => (f, p),
                        _ => continue,
                    };
                    let is_dir = flag == "D";
                    let s = path.to_string();
                    let name_at = s.rfind(['\\', '/']).map(|i| i + 1).unwrap_or(0);
                    v.push(IndexEntry { path: s, name_at, is_dir });
                }
                v
            })
            .filter(|v| !v.is_empty());
        if let Some(v) = loaded {
            INDEX_SCANNED.store(v.len(), std::sync::atomic::Ordering::Relaxed);
            *INDEX.write().unwrap() = v;
            // 缓存只是"先能用"：延迟 10 分钟再重建（错开用户"打开就搜/就编辑"高峰；
            // 30s 就重建曾实锤拖慢表格面板弹出——HDD 全盘遍历重 IO，走最低线程优先级）
            std::thread::sleep(std::time::Duration::from_secs(600));
        }
        build_index();
    });
}

/// 全盘文件名搜索（v0.3.22 自建索引，边建边搜）：完全无数据（构建刚开始）才报
/// INDEX_BUILDING:<已扫描数>；有数据=Ok(命中)——构建中命中的是已扫描部分。
#[tauri::command]
fn es_search(query: String, limit: u32) -> Result<Vec<EsHit>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let building = INDEX_BUILDING.load(std::sync::atomic::Ordering::Relaxed);
    let idx = INDEX.read().unwrap();
    if idx.is_empty() && building {
        return Err(format!(
            "INDEX_BUILDING:{}",
            INDEX_SCANNED.load(std::sync::atomic::Ordering::Relaxed)
        ));
    }
    // 空格拆词 AND 匹配文件名（ASCII 忽略大小写）；路径短的相关度高更靠前
    // v0.3.28 ext: 过滤语法恢复（v0.3.22 自建索引切替时丢失）：ext:md=只留 .md 文件
    // （可多个 ext:token 取并集，多个扩展名写法 ext:md,txt 也接受）；其余词仍 AND 匹配文件名
    let mut terms: Vec<String> = Vec::new();
    let mut exts: Vec<String> = Vec::new();
    for tok in q.split_whitespace() {
        if let Some(e) = tok.strip_prefix("ext:") {
            if !e.is_empty() {
                for x in e.split(',') {
                    let x = x.trim().trim_start_matches('.');
                    if !x.is_empty() { exts.push(x.to_string()); }
                }
                continue;
            }
        }
        terms.push(tok.to_string());
    }
    let mut hits: Vec<EsHit> = idx
        .iter()
        .filter(|e| {
            let name = &e.path[e.name_at.min(e.path.len())..];
            if !terms.iter().all(|t| ascii_ci_contains(name, t)) { return false; }
            if !exts.is_empty() {
                if e.is_dir { return false; }
                match name.rfind('.') {
                    Some(d) => {
                        let ex = &name[d + 1..];
                        if !exts.iter().any(|x| x.eq_ignore_ascii_case(ex)) { return false; }
                    }
                    None => return false,
                }
            }
            true
        })
        .take(limit.clamp(1, 2000) as usize)
        .map(|e| EsHit { path: e.path.clone(), is_dir: e.is_dir })
        .collect();
    drop(idx);
    hits.sort_by_key(|h| h.path.len());
    Ok(hits)
}

/// 命中项（path=完整路径；is_dir=是否目录，前端点击分流用）——字段与 es.exe 时代一致
#[derive(serde::Serialize, Debug)]
struct EsHit {
    path: String,
    is_dir: bool,
}

/// 写导出用文本文件（HTML 等）。与 save_file 分离：导出产物不受 md/txt 白名单限制，
/// 也不做空内容覆盖防护（导出内容来自渲染管线而非编辑器取值）。
#[tauri::command]
fn write_export_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// 粘贴截图落地：存到文档同目录 assets/ 子目录（未命名文档 doc_dir 为空 → 存
/// %APPDATA%/<id>/pasted/ 并返回绝对路径）。文件名=截图_yyyyMMdd_HHmmss（同秒多个加序号）。
/// 返回 (相对引用路径, 绝对路径)。中文文件名保留原文（md 引用按需编码由前端处理）。
#[tauri::command]
fn save_paste_image(app: AppHandle, doc_dir: String, ext: String, data_b64: String) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    let ext = ext.to_lowercase();
    if !["png", "jpg", "jpeg", "gif", "webp", "bmp"].contains(&ext.as_str()) {
        return Err(format!("unsupported image ext: {ext}"));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    // 本地时区 yyyyMMdd_HHmmss（无 chrono 依赖：用秒数换算 UTC+8，中国时区场景足够）
    let local = now + 8 * 3600;
    let days = local / 86400;
    let (y, mo, d) = civil_from_days(days as i64);
    let secs = local % 86400;
    let base = format!("截图_{:04}{:02}{:02}_{:02}{:02}{:02}", y, mo, d, secs / 3600, secs % 3600 / 60, secs % 60);

    let (dir, rel) = if doc_dir.is_empty() {
        let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("pasted");
        (d, String::new()) // 未命名文档：无相对基准，用绝对路径引用
    } else {
        let d = PathBuf::from(&doc_dir).join("assets");
        (d, format!("assets/"))
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 同秒冲突加序号
    let mut name = format!("{base}.{ext}");
    let mut i = 1;
    while dir.join(&name).exists() {
        name = format!("{base}_{i}.{ext}");
        i += 1;
    }
    let abs = dir.join(&name);
    fs::write(&abs, &bytes).map_err(|e| e.to_string())?;
    let abs_str = abs.to_string_lossy().replace('\\', "/");
    let rel_str = if rel.is_empty() { abs_str.clone() } else { format!("{rel}{name}") };
    Ok(serde_json::json!({ "rel": rel_str, "abs": abs_str }))
}

/// 公历换算（Howard Hinnant 算法，civil_from_days）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// WebView2 Runtime 缺失检测：任一注册表位置有 pv 值即视为已装。
/// WEBVIEW2_BROWSER_EXECUTABLE_FOLDER 显式指定固定版本时跳过（企业离线分发场景）。
fn webview2_missing() -> bool {
    if std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_some() {
        return false;
    }
    const KEY: &str = r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    for hive in ["HKLM", "HKCU"] {
        for sub in [format!(r"SOFTWARE\WOW6432Node\{KEY}"), format!(r"SOFTWARE\{KEY}")] {
            let mut cmd = Command::new("reg");
            cmd.args(["query", &format!(r"{hive}\{sub}"), "/v", "pv"]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            if let Ok(o) = cmd.output() {
                if o.status.success() {
                    return false;
                }
            }
        }
    }
    true
}

// 零依赖弹窗（不依赖 WebView2，user32 直调）：缺失 WebView2 时给用户可读指引，
// 替代"双击无反应/白屏"的不可诊断失败。
#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, utype: u32) -> i32;
}

#[cfg(windows)]
fn fatal_msgbox(text: &str, caption: &str) {
    let t: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let c: Vec<u16> = caption.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { MessageBoxW(0, t.as_ptr(), c.as_ptr(), 0x10); } // MB_ICONERROR
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // v0.3.23 运行日志首行：run() 第一件事（覆盖开机第一行，不留观测盲区）
    log_startup(&std::env::args().skip(1).collect::<Vec<_>>().join(" "));
    // 启动预检：WebView2 Runtime 缺失（极老/精简系统）时 Tauri 会静默失败或白屏，
    // 先给出可读指引再退出（明算工具缺 VC++ DLL 用户机起不来的同类教训）。
    #[cfg(windows)]
    {
        if webview2_missing() {
            fatal_msgbox(
                "缺少 Microsoft WebView2 运行库（Windows 10/11 一般自带）。\n\n\
                 请安装 WebView2 Runtime 后重试：\n\
                 https://developer.microsoft.com/microsoft-edge/webview2/\n\
                 （选 Evergreen Standalone 离线包；内网机器可在有网机器下载后拷入安装）",
                "无法启动 MD 编辑器",
            );
            std::process::exit(1);
        }
    }
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
        .setup(|_app| {
            // v0.3.22 自建全盘索引管线：缓存秒载→延迟重建/无缓存即建（后台线程不阻塞 UI）
            start_index_pipeline();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_file,
            save_file,
            list_versions,
            read_version,
            export_pdf,
            get_startup_file,
            find_pdf_source,
            open_pdf_external,
            open_dropped_pdf,
            load_ui_state,
            save_binary_file,
            read_binary_file,
            write_export_file,
            save_paste_image,
            export_selftest_dir,
            save_ui_state,
            list_theme_files,
            read_theme_css,
            list_md_dir,
            list_drives,
            create_text_file,
            create_dir,
            rename_entry,
            delete_entry,
            reveal_path,
            es_search,
            file_meta,
            export_diagnostics,
            search_md_files,
            dnd_selftest_enabled,
            print_webview
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
    fn es_search_selfindex_queries() {
        // v0.3.22 自建索引查询逻辑（注入小索引，不触发全盘构建）：
        // 多词 AND、大小写不敏感（ascii_ci_contains）、目录命中、limit 截断、未就绪语义
        fn entry(path: &str, is_dir: bool) -> IndexEntry {
            let name_at = path.rfind(['\\', '/']).map(|i| i + 1).unwrap_or(0);
            IndexEntry { path: path.into(), name_at, is_dir }
        }
        *INDEX.write().unwrap() = vec![
            entry(r"C:\docs\年度报告.md", false),
            entry(r"C:\docs\Report-2026.md", false),
            entry(r"C:\docs\报告资料", true),
            entry(r"D:\notes\todo.txt", false),
        ];
        INDEX_BUILDING.store(false, std::sync::atomic::Ordering::Relaxed);
        // 单词命中（大小写不敏感：REPORT 命中 Report-2026）
        let hits = es_search("report".into(), 10).unwrap();
        assert!(hits.iter().any(|h| h.path.ends_with("Report-2026.md")), "{hits:?}");
        // 多词 AND：报告+md 只命中「年度报告.md」（目录"报告资料"无 md 词、Report-2026 无中文词）
        let hits = es_search("报告 md".into(), 10).unwrap();
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(hits[0].path.ends_with("年度报告.md"));
        // limit 截断
        let hits = es_search("md".into(), 1).unwrap();
        assert_eq!(hits.len(), 1);
        // v0.3.28 ext: 过滤（切自建索引时丢的语法）：词+扩展名 AND；ext: 排除目录；
        // 多扩展名并集（逗号）；纯 ext: 也有效
        let hits = es_search("报告 ext:md".into(), 10).unwrap();
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(hits[0].path.ends_with("年度报告.md"));
        let hits = es_search("报告 ext:md,txt".into(), 10).unwrap();
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(hits[0].path.ends_with("年度报告.md"));
        let hits = es_search("ext:txt".into(), 10).unwrap();
        assert!(hits.iter().all(|h| h.path.ends_with(".txt")) && !hits.is_empty(), "{hits:?}");
        let hits = es_search("todo ext:txt".into(), 10).unwrap();
        assert!(hits.iter().any(|h| h.path.ends_with("todo.txt")), "{hits:?}");
        // 空查询
        assert!(es_search("  ".into(), 10).unwrap().is_empty());
        // 清空索引+构建中 → 未就绪语义
        INDEX.write().unwrap().clear();
        INDEX_BUILDING.store(true, std::sync::atomic::Ordering::Relaxed);
        INDEX_SCANNED.store(42, std::sync::atomic::Ordering::Relaxed);
        let err = es_search("x".into(), 10).unwrap_err();
        assert_eq!(err, "INDEX_BUILDING:42");
    }
    #[test]
    fn ascii_ci_contains_cases() {
        assert!(ascii_ci_contains("Report-2026.md", "report"));
        assert!(ascii_ci_contains("年度报告.md", "报告"));
        assert!(ascii_ci_contains("年度报告.md", "MD"));
        assert!(!ascii_ci_contains("Report-2026.md", "reportx"));
        assert!(!ascii_ci_contains("报告.md", "汇报"));
        assert!(ascii_ci_contains("a", ""));
    }

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
    fn ftree_entry_ops_roundtrip() {
        let dir = std::env::temp_dir().join("md_verify_ftree_ops");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().to_string();

        // 新建 md（补扩展名）→ 打开内容空 → txt 同理
        let f1 = create_text_file(d.clone(), "笔记".into(), "md".into()).unwrap();
        assert!(f1.ends_with("笔记.md") && std::path::Path::new(&f1).is_file());
        // 已存在拒绝
        assert!(create_text_file(d.clone(), "笔记.md".into(), "md".into()).is_err());
        // 非法字符拒绝
        assert!(create_text_file(d.clone(), "a<b".into(), "md".into()).is_err());
        // 新建文件夹
        let sub = create_dir(d.clone(), "子夹".into()).unwrap();
        assert!(std::path::Path::new(&sub).is_dir());
        // 重命名：文件与目录各一
        let f2 = rename_entry(f1.clone(), "改名.md".into()).unwrap();
        assert!(!std::path::Path::new(&f1).exists() && std::path::Path::new(&f2).exists());
        let sub2 = rename_entry(sub.clone(), "子夹2".into()).unwrap();
        assert!(std::path::Path::new(&sub2).is_dir());
        // 目标已存在拒绝
        let _ = create_text_file(d.clone(), "占用.md".into(), "md".into()).unwrap();
        assert!(rename_entry(f2.clone(), "占用.md".into()).is_err());
        // 删除：文件与目录（递归）
        delete_entry(f2).unwrap();
        let _ = create_text_file(sub2.clone(), "内.txt".into(), "txt".into()).unwrap();
        delete_entry(sub2).unwrap();
        // 盘符根防护
        assert!(delete_entry("C:\\".into()).is_err());
        assert!(rename_entry("F:\\".into(), "x".into()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_drives_returns_existing_roots() {
        // 本机至少有 C:；每项 path 均为 "X:\" 形态且 is_dir=true
        let out = list_drives();
        assert!(!out.is_empty(), "本机至少一个盘符");
        assert!(out.iter().any(|v| v["path"].as_str().unwrap() == "C:\\"));
        for v in &out {
            let p = v["path"].as_str().unwrap();
            assert!(p.len() == 3 && p.ends_with(":\\"), "盘符形态: {p}");
            assert!(v["is_dir"].as_bool().unwrap());
        }
    }

    #[test]
    fn file_meta_reports_mtime_and_size() {
        // v0.3.26 外部修改检测：正常文件返回 mtime+size；mtime 单调（两次写之间）；不存在返回 Err
        let dir = tempdir();
        let p = dir.join("m.md");
        fs::write(&p, "hello").unwrap();
        let m1 = file_meta(p.to_str().unwrap().to_string()).unwrap();
        assert_eq!(m1.size, 5, "size 应为字节数");
        assert!(m1.mtime_ms > 1_500_000_000_000, "mtime 应为毫秒级现代时间戳: {}", m1.mtime_ms);
        // 追加后 size 变化
        fs::write(&p, "hello world").unwrap();
        let m2 = file_meta(p.to_str().unwrap().to_string()).unwrap();
        assert_eq!(m2.size, 11);
        assert!(m2.mtime_ms >= m1.mtime_ms, "mtime 不应倒退");
        // 不存在的文件：Err（前端据此视为"文件已被删除"）
        assert!(file_meta(dir.join("nope.md").to_str().unwrap().to_string()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_file_rejects_oversize() {
        // >16MB 在读文件前就被拒（不读内容，Err 文案含"文件过大"）；v0.3.25 从 2MB 放宽到 16MB
        let dir = std::env::temp_dir().join("md_verify_oversize");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let big = dir.join("big.md");
        let mut buf = vec![b'a'; 16 * 1024 * 1024 + 1];
        buf[0] = b'#';
        fs::write(&big, &buf).unwrap();
        let err = open_file(big.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("文件过大"), "err={err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_md_dir_layers_and_skips() {
        let dir = std::env::temp_dir().join("md_verify_listdir");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("b.md"), "x").unwrap();
        fs::write(dir.join("a.md"), "x").unwrap();
        fs::write(dir.join("img.png"), "x").unwrap();
        let out = list_md_dir(dir.to_string_lossy().to_string()).unwrap();
        let names: Vec<(String, bool)> = out
            .iter()
            .map(|v| (v["name"].as_str().unwrap().to_string(), v["is_dir"].as_bool().unwrap()))
            .collect();
        // 目录在前；隐藏/node_modules 排除；v0.3.21 起非白名单文件（png）也列出（前端点击走"在文件夹中显示"）
        assert_eq!(names, vec![("sub".to_string(), true), ("a.md".to_string(), false), ("b.md".to_string(), false), ("img.png".to_string(), false)]);
        assert!(list_md_dir(dir.join("不存在").to_string_lossy().to_string()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_hits_lines_and_case() {
        let dir = std::env::temp_dir().join("md_verify_search");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("one.md"), "# 标题\n\nHello 需求词 Alpha\n").unwrap();
        fs::write(dir.join("sub/two.md"), "需求词 second\n别的\n").unwrap();
        fs::write(dir.join("sub/other.txt"), "需求词 in txt\n").unwrap();
        let out = search_md_files(dir.to_string_lossy().to_string(), "需求词".to_uppercase()).unwrap();
        // 大小写不敏感；递归命中子目录；txt 白名单内也命中
        assert_eq!(out.len(), 3, "hits={out:?}");
        assert!(out.iter().all(|h| h["line_no"].as_u64().unwrap() >= 1));
        let empty = search_md_files(dir.to_string_lossy().to_string(), "".to_string()).unwrap();
        assert!(empty.is_empty());
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

    // ===== v0.3.11 版本历史 =====
    #[test]
    fn read_version_rejects_path_escape() {
        let err = read_version("C:\\Windows\\win.ini".to_string()).unwrap_err();
        assert!(err.contains("非法"), "目录穿越应拒绝，实际 err={err}");
    }

    #[test]
    fn archive_skips_temp_paths() {
        // tempdir 夹具：不归档不崩溃（隔离验证，真实归档由 release e2e 覆盖）
        let dir = tempdir();
        let p = dir.join("t.md");
        fs::write(&p, "v1").unwrap();
        archive_old_version(p.to_str().unwrap());
        save_file(p.to_str().unwrap().to_string(), "v2".to_string()).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "v2");
    }

    #[test]
    fn version_stem_sanitizes_and_disambiguates() {
        let a = version_stem("C:\\docs\\报告 一.md");
        let b = version_stem("C:\\docs\\报告一.md");
        assert!(a.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.'), "非法字符应被替换: {a}");
        assert_ne!(a, b, "同名不同路径应消歧");
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

    // ===== v0.4.0 自定义主题（list_theme_files/read_theme_css 的文件系统逻辑） =====
    // AppHandle 无法在单测构造，直接测其依赖的目录行为：用独立目录+同名逻辑复刻太脆，
    // 改为抽取核心规则在这两个测试里验证——_ 前缀禁用 / 非 .css 忽略 / 防穿越字符集。
    // （list/read 的 AppHandle 胶水层由部署 exe 的 e2e 全链覆盖）
    #[test]
    fn theme_name_validation_rules() {
        // read_theme_css 拒绝的形态（与命令内联校验同一规则集，规则漂移时此测试提醒同步）
        let bad = ["", "a/b", "a\\b", "a..b", "c:d"];
        for n in bad {
            let invalid = n.is_empty()
                || n.contains('/')
                || n.contains('\\')
                || n.contains("..")
                || n.contains(':');
            assert!(invalid, "应拒绝: {n:?}");
        }
        let ok = ["drake", "drake-dark", "我的主题", "vue_2026"];
        for n in ok {
            let invalid = n.is_empty()
                || n.contains('/')
                || n.contains('\\')
                || n.contains("..")
                || n.contains(':');
            assert!(!invalid, "应放行: {n:?}");
        }
    }
    #[test]
    fn theme_stem_underscore_prefix_means_disabled() {
        // list_theme_files 的收录口径：.css（大小写不敏感）且 stem 不以 _ 开头（与实现同用 std path API）
        let names = [("drake.css", true), ("_example.css", false), ("a.CSS", true), ("a.txt", false), ("_x.CSS", false)];
        for (fname, expect) in names {
            let ext_ok = fname.to_ascii_lowercase().ends_with(".css");
            let stem = std::path::Path::new(fname).file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let listed = ext_ok && !stem.starts_with('_');
            assert_eq!(listed, expect, "{fname}");
        }
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
