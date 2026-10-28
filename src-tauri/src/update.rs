// «Проверить обновления».
//  • Папка программы — git-клон: git fetch → сколько новых коммитов → git pull --ff-only →
//    если изменились исходники и есть Rust (cargo) — пересборка и перезапуск.
//  • Готовая сборка (ZIP с GitHub): последний релиз GitHub → скачать архив → заменить программу → перезапуск.
use crate::{ff, paths};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const REPO: &str = "IsselSaizo/FFMontage";

fn s(p: &Path) -> String { p.to_string_lossy().to_string() }

fn which(name: &str) -> Option<PathBuf> {
    let exe = format!("{name}{}", if cfg!(windows) { ".exe" } else { "" });
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if name == "cargo" {
        if let Ok(h) = std::env::var("CARGO_HOME") { dirs.push(PathBuf::from(h).join("bin")); }
        if let Some(h) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) { dirs.push(PathBuf::from(h).join(".cargo").join("bin")); }
    }
    if name == "git" && cfg!(windows) {
        for d in ["C:\\Program Files\\Git\\cmd", "C:\\Program Files (x86)\\Git\\cmd"] { dirs.push(PathBuf::from(d)); }
    }
    dirs.into_iter().map(|d| d.join(&exe)).find(|p| p.is_file())
}

async fn git(args: &[&str]) -> Result<String, String> {
    let g = which("git").ok_or("Git не найден")?;
    let mut c = ff::command(&g);
    c.args(args).current_dir(&paths::get().app_dir).env("GIT_TERMINAL_PROMPT", "0");
    let out = tokio::time::timeout(Duration::from_secs(120), c.output()).await.map_err(|_| "git: нет ответа за 2 мин".to_string())?
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

fn is_git() -> bool { paths::get().app_dir.join(".git").exists() && which("git").is_some() }

fn version_tuple(v: &str) -> Vec<u64> {
    v.trim_start_matches(|c: char| !c.is_ascii_digit()).split(|c: char| !c.is_ascii_digit()).filter_map(|x| x.parse().ok()).take(3).collect()
}

async fn latest_release() -> Result<Value, String> {
    let curl = which("curl").ok_or("curl не найден")?;
    let mut c = ff::command(&curl);
    c.args(["-sL", "--max-time", "30", "-H", "Accept: application/vnd.github+json", "-H", "User-Agent: FF-Montage",
        &format!("https://api.github.com/repos/{REPO}/releases/latest")]);
    let out = c.output().await.map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| "GitHub не ответил".to_string())?;
    if v["tag_name"].is_null() { return Err(v["message"].as_str().unwrap_or("Релизов пока нет").to_string()); }
    Ok(v)
}

fn platform_asset(rel: &Value) -> Option<(String, String)> {
    let want = if cfg!(windows) { "win" } else { "linux" };
    rel["assets"].as_array()?.iter().find_map(|a| {
        let name = a["name"].as_str()?.to_lowercase();
        let ok = name.contains(want) && (name.ends_with(".zip") || name.ends_with(".tar.gz") || name.ends_with(".tar.xz")) && !name.contains("vendor");
        if ok { Some((a["name"].as_str()?.to_string(), a["browser_download_url"].as_str()?.to_string())) } else { None }
    })
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Value, String> {
    let current = app.package_info().version.to_string();
    if is_git() {
        git(&["fetch", "--quiet", "origin"]).await?;
        let branch = git(&["rev-parse", "--abbrev-ref", "HEAD"]).await?;
        let up = git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await.unwrap_or_else(|_| format!("origin/{branch}"));
        let behind: u64 = git(&["rev-list", "--count", &format!("HEAD..{up}")]).await?.parse().unwrap_or(0);
        let ahead: u64 = git(&["rev-list", "--count", &format!("{up}..HEAD")]).await?.parse().unwrap_or(0);
        let log = git(&["log", "--pretty=format:%h %s", "-n", "30", &format!("HEAD..{up}")]).await.unwrap_or_default();
        let dirty = !git(&["status", "--porcelain", "--untracked-files=no"]).await.unwrap_or_default().is_empty();
        let head = git(&["rev-parse", "--short", "HEAD"]).await.unwrap_or_default();
        return Ok(json!({
            "mode": "git", "current": current, "branch": branch, "upstream": up, "head": head,
            "behind": behind, "ahead": ahead, "dirty": dirty,
            "commits": log.lines().collect::<Vec<_>>(), "cargo": which("cargo").map(|p| s(&p)),
            "available": behind > 0,
        }));
    }
    let rel = latest_release().await?;
    let tag = rel["tag_name"].as_str().unwrap_or("").to_string();
    let newer = version_tuple(&tag) > version_tuple(&current);
    let asset = platform_asset(&rel);
    Ok(json!({
        "mode": "release", "current": current, "latest": tag, "available": newer && asset.is_some(), "newer": newer,
        "url": rel["html_url"], "notes": rel["body"], "asset": asset.map(|(n, u)| json!({ "name": n, "url": u })),
    }))
}

fn emit(app: &AppHandle, text: &str) { let _ = app.emit("update:log", json!({ "text": text })); }

/// Перезапуск: новая копия программы стартует, эта закрывается
pub fn relaunch(app: &AppHandle, exe: &Path) -> Result<(), String> {
    let mut c = std::process::Command::new(exe);
    // Новая копия подождёт, пока эта закроется (иначе сработает защита от второго экземпляра)
    c.current_dir(&paths::get().app_dir).env("FFM_RELAUNCH", "1");
    c.spawn().map_err(|e| format!("Не удалось запустить новую версию: {e}"))?;
    app.exit(0);
    Ok(())
}

/// Освободить файл запущенной программы (Windows не даёт перезаписать запущенный exe, но даёт переименовать)
fn move_running_exe(exe: &Path) -> Result<PathBuf, String> {
    let old = exe.with_extension("old.exe");
    let _ = std::fs::remove_file(&old);
    std::fs::rename(exe, &old).map_err(|e| format!("Не удалось освободить файл программы: {e}"))?;
    Ok(old)
}

/// Удалить остатки прошлого обновления
pub fn cleanup_old() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::remove_file(exe.with_extension("old.exe"));
    }
}

#[tauri::command]
pub async fn update_apply(app: AppHandle) -> Result<Value, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if is_git() {
        let before = git(&["rev-parse", "HEAD"]).await?;
        emit(&app, "git pull --ff-only…");
        let pulled = git(&["pull", "--ff-only"]).await?;
        emit(&app, &pulled);
        let after = git(&["rev-parse", "HEAD"]).await?;
        if before == after { return Ok(json!({ "updated": false, "message": "Уже последняя версия." })); }
        let changed = git(&["diff", "--name-only", &before, &after]).await.unwrap_or_default();
        let needs_build = changed.lines().any(|f| f.starts_with("src-tauri/") || f.starts_with("src/renderer/") || f.starts_with("mcp/"));
        if !needs_build {
            return Ok(json!({ "updated": true, "rebuilt": false, "message": "Обновлено. Изменения не затрагивают программу — перезапуск не нужен." }));
        }
        let Some(cargo) = which("cargo") else {
            return Ok(json!({ "updated": true, "rebuilt": false, "needsBuild": true,
                "message": "Исходники обновлены. Чтобы применить, запустите setup.cmd (пересборка) или скачайте готовую сборку из Releases." }));
        };
        emit(&app, "Пересборка (cargo build --release)… первый раз это несколько минут");
        let built = paths::get().app_dir.join("src-tauri").join("target").join("release").join(format!("ff-montage{}", if cfg!(windows) { ".exe" } else { "" }));
        let same = paths::normalize(&built).to_string_lossy().to_lowercase() == paths::normalize(&exe).to_string_lossy().to_lowercase();
        // Запущенный файл нельзя перезаписать, но можно переименовать
        let old = if same { Some(move_running_exe(&exe)?) } else { None };
        let mut c = ff::command(&cargo);
        c.args(["build", "--release"]).current_dir(paths::get().app_dir.join("src-tauri"));
        let out = c.output().await.map_err(|e| e.to_string());
        let ok = matches!(&out, Ok(o) if o.status.success()) && built.exists();
        if !ok {
            if let Some(o) = &old { let _ = std::fs::rename(o, &exe); }
            let err = match out { Ok(o) => String::from_utf8_lossy(&o.stderr).lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"), Err(e) => e };
            return Err(format!("Сборка не удалась:\n{err}"));
        }
        if !same {
            // «FF Montage.exe» в папке программы — копия сборки
            let o = move_running_exe(&exe)?;
            if let Err(e) = std::fs::copy(&built, &exe) {
                let _ = std::fs::rename(&o, &exe);
                return Err(format!("Не удалось заменить программу: {e}"));
            }
        }
        emit(&app, "Готово, перезапуск…");
        relaunch(&app, &exe)?;
        return Ok(json!({ "updated": true, "rebuilt": true }));
    }
    // Готовая сборка: скачать архив релиза
    let rel = latest_release().await?;
    let (name, url) = platform_asset(&rel).ok_or("В релизе нет архива для этой системы")?;
    let tmp = paths::get().temp.join("update");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let archive = tmp.join(&name);
    emit(&app, &format!("Скачиваю {name}…"));
    let curl = which("curl").ok_or("curl не найден")?;
    let st = ff::command(&curl).args(["-sL", "--fail", "-o", &s(&archive), &url]).output().await.map_err(|e| e.to_string())?;
    if !st.status.success() { return Err("Не удалось скачать обновление".into()); }
    emit(&app, "Распаковываю…");
    let x = tmp.join("x");
    std::fs::create_dir_all(&x).map_err(|e| e.to_string())?;
    let tar = which("tar").ok_or("tar не найден")?;
    let st = ff::command(&tar).args(["-xf", &s(&archive), "-C", &s(&x)]).output().await.map_err(|e| e.to_string())?;
    if !st.status.success() { return Err(format!("Не удалось распаковать: {}", String::from_utf8_lossy(&st.stderr))); }
    let exe_name = exe.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    let found = find_file(&x, &exe_name).ok_or("В архиве нет программы")?;
    let src_dir = found.parent().unwrap().to_path_buf();
    let dst_dir = exe.parent().unwrap().to_path_buf();
    let old = move_running_exe(&exe)?;
    if let Err(e) = copy_tree(&src_dir, &dst_dir) {
        let _ = std::fs::rename(&old, &exe);
        return Err(format!("Не удалось установить обновление: {e}"));
    }
    emit(&app, "Готово, перезапуск…");
    relaunch(&app, &exe)?;
    Ok(json!({ "updated": true }))
}

fn find_file(dir: &Path, name: &std::ffi::OsStr) -> Option<PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() { if let Some(f) = find_file(&p, name) { return Some(f); } }
        else if p.file_name() == Some(name) { return Some(p); }
    }
    None
}

/// Копирует новые файлы поверх старых; личные настройки (config.json) и папки данных не трогает
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)?.flatten() {
        let p = e.path();
        let name = e.file_name();
        let n = name.to_string_lossy().to_lowercase();
        if n == "config.json" || n == "cache" || n == "output" || n == "projects" { continue; }
        let to = dst.join(&name);
        if p.is_dir() { copy_tree(&p, &to)?; } else { std::fs::copy(&p, &to)?; }
    }
    Ok(())
}
