use std::fs;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

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

/// 取启动时命令行传入的文件路径（前端启动后 invoke 兜底读取）
#[tauri::command]
fn get_startup_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.lock().ok()?.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        .invoke_handler(tauri::generate_handler![open_file, save_file, get_startup_file])
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
}
