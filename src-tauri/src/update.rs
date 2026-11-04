// «Проверить обновления».
//  • Папка программы — git-клон: git fetch → сколько новых коммитов → git pull --ff-only →
//    если изменились исходники и есть Rust (cargo) — пересборка и перезапуск.
//  • Готовая сборка (архив с GitHub, M0.10 / R-4): последний релиз → тег должен быть версией и больше текущей →
//    ассет строго своей ОС и архитектуры → SHA256SUMS с подписью ed25519 (ключ — UPDATE_PUBKEY) →
//    SHA-256 скачанного архива сверяется с SHA256SUMS → только после этого замена программы и перезапуск.
//    Любая ошибка проверки — ничего не устанавливается. Подпись делает tools/sign-release.mjs в release-workflow.
use crate::{ff, paths, tr};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const REPO: &str = "IsselSaizo/FFMontage";

/// Открытый ключ подписи релизов: base64("Ed" + keyid[8] + ключ ed25519[32]), keyid = SHA-256(ключ)[..8].
/// Формат и подпись — tools/sign-release.mjs; закрытый ключ — только в секрете GitHub FFM_SIGNING_KEY.
const UPDATE_PUBKEY: &str = "RWRntipCAjmjM9eeddvkSuUfxNe1SW5FsNP4z+0jNXMfC+w3QKPQxTr0";
const SUMS: &str = "SHA256SUMS";
const SIG: &str = "SHA256SUMS.sig";

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

pub fn which(name: &str) -> Option<PathBuf> {
    let exe = format!("{name}{}", if cfg!(windows) { ".exe" } else { "" });
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if name == "cargo" {
        if let Ok(h) = std::env::var("CARGO_HOME") {
            dirs.push(PathBuf::from(h).join("bin"));
        }
        if let Some(h) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            dirs.push(PathBuf::from(h).join(".cargo").join("bin"));
        }
    }
    if name == "git" && cfg!(windows) {
        for d in ["C:\\Program Files\\Git\\cmd", "C:\\Program Files (x86)\\Git\\cmd"] {
            dirs.push(PathBuf::from(d));
        }
    }
    dirs.into_iter().map(|d| d.join(&exe)).find(|p| p.is_file())
}

async fn git(args: &[&str]) -> Result<String, String> {
    let g = which("git").ok_or(tr!("Git не найден", "Git not found"))?;
    let mut c = ff::command(&g);
    c.args(args).current_dir(&paths::get().app_dir).env("GIT_TERMINAL_PROMPT", "0");
    let out = tokio::time::timeout(Duration::from_secs(120), c.output())
        .await
        .map_err(|_| tr!("git: нет ответа за 2 мин", "git: no response in 2 min").to_string())?
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

fn is_git() -> bool {
    paths::get().app_dir.join(".git").exists() && which("git").is_some()
}

// ---------------------------------------------------------------------------
// Версии: только «1.2.3» или «v1.2.3» — пре-релизы и прочие теги не предлагаются
// ---------------------------------------------------------------------------
fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim();
    let v = v.strip_prefix('v').unwrap_or(v);
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let num = |p: &str| -> Option<u64> {
        if p.is_empty() || p.len() > 9 || !p.bytes().all(|b| b.is_ascii_digit()) {
            None
        } else {
            p.parse().ok()
        }
    };
    Some((num(parts[0])?, num(parts[1])?, num(parts[2])?))
}

// ---------------------------------------------------------------------------
// Ассет по ОС и архитектуре: FF-Montage-<версия>-windows-x64.zip, -linux-x86_64.tar.gz, -linux-x86_64.AppImage.
// macOS (в планах) и ARM готовых сборок не имеют — обновление недоступно.
// ---------------------------------------------------------------------------
fn asset_name(version: &str, os: &str, arch: &str, appimage: bool) -> Option<String> {
    let plat = match (os, arch) {
        ("windows", "x86_64") => "windows-x64.zip",
        ("linux", "x86_64") if appimage => "linux-x86_64.AppImage",
        ("linux", "x86_64") => "linux-x86_64.tar.gz",
        _ => return None,
    };
    Some(format!("FF-Montage-{version}-{plat}"))
}

/// Программа запущена из AppImage: обновлять надо сам файл $APPIMAGE
fn appimage_path() -> Option<PathBuf> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|p| p.is_file())
}

/// Ссылка на ассет релиза по точному имени
fn asset_url(rel: &Value, name: &str) -> Option<String> {
    rel["assets"].as_array()?.iter().find_map(|a| {
        if a["name"].as_str()? == name {
            a["browser_download_url"].as_str().map(str::to_string)
        } else {
            None
        }
    })
}

/// Что и откуда ставить
#[derive(Debug, PartialEq)]
struct Plan {
    version: String,
    name: String,
    url: String,
    sums_url: String,
    sig_url: String,
}

/// Почему обновление не предлагается
#[derive(Debug, PartialEq)]
enum Skip {
    BadTag,
    NotNewer,
    NoBuild,
    Unsigned,
}

impl Skip {
    fn code(&self) -> &'static str {
        match self {
            Skip::BadTag => "tag",
            Skip::NotNewer => "latest",
            Skip::NoBuild => "platform",
            Skip::Unsigned => "unsigned",
        }
    }
    fn message(&self) -> &'static str {
        match self {
            Skip::BadTag => tr!(
                "Тег последнего релиза не похож на версию — обновление не предлагается.",
                "The latest release tag is not a version — no update offered."
            ),
            Skip::NotNewer => tr!("У вас последняя версия.", "You have the latest version."),
            Skip::NoBuild => tr!("Для этой системы в релизе нет готовой сборки.", "The release has no build for this system."),
            Skip::Unsigned => tr!(
                "В релизе нет SHA256SUMS или подписи — обновление не установлено.",
                "The release has no SHA256SUMS or signature — the update is not installed."
            ),
        }
    }
}

fn plan(rel: &Value, current: &str, os: &str, arch: &str, appimage: bool) -> Result<Plan, Skip> {
    let (a, b, c) = parse_version(rel["tag_name"].as_str().unwrap_or("")).ok_or(Skip::BadTag)?;
    let version = format!("{a}.{b}.{c}");
    // Текущая версия не разобралась — не рискуем
    let cur = parse_version(current).ok_or(Skip::NotNewer)?;
    if (a, b, c) <= cur {
        return Err(Skip::NotNewer);
    }
    let name = asset_name(&version, os, arch, appimage).ok_or(Skip::NoBuild)?;
    let url = asset_url(rel, &name).ok_or(Skip::NoBuild)?;
    let sums_url = asset_url(rel, SUMS).ok_or(Skip::Unsigned)?;
    let sig_url = asset_url(rel, SIG).ok_or(Skip::Unsigned)?;
    Ok(Plan { version, name, url, sums_url, sig_url })
}

// ---------------------------------------------------------------------------
// SHA256SUMS и подпись
// ---------------------------------------------------------------------------
/// «<64 hex>  <имя>» или «<64 hex> *<имя>» в строке; пустые строки пропускаются
fn parse_sums(text: &str) -> Result<HashMap<String, String>, String> {
    let mut m = HashMap::new();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let bad = || tr!("SHA256SUMS: не разобрана строка {}", "SHA256SUMS: cannot parse line {}", i + 1);
        let (hash, rest) = (line.get(..64).ok_or_else(bad)?, line.get(64..).ok_or_else(bad)?);
        if !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(bad());
        }
        let name = rest.strip_prefix("  ").or_else(|| rest.strip_prefix(" *")).filter(|n| !n.is_empty()).ok_or_else(bad)?;
        if m.insert(name.to_string(), hash.to_ascii_lowercase()).is_some() {
            return Err(tr!("SHA256SUMS: файл {} указан дважды", "SHA256SUMS: file {} is listed twice", name));
        }
    }
    if m.is_empty() {
        return Err(tr!("SHA256SUMS пуст", "SHA256SUMS is empty").into());
    }
    Ok(m)
}

fn sha256(data: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(data).into()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn sha256_file(p: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h)?;
    Ok(hex(&h.finalize()))
}

/// Открытый ключ: (keyid, ключ)
fn decode_pubkey(text: &str) -> Result<([u8; 8], [u8; 32]), String> {
    let b = crate::assets::base64_decode(text.trim())
        .filter(|b| b.len() == 42 && &b[..2] == b"Ed")
        .ok_or(tr!("Неверный открытый ключ подписи", "Invalid signing public key"))?;
    let (mut id, mut pk) = ([0u8; 8], [0u8; 32]);
    id.copy_from_slice(&b[2..10]);
    pk.copy_from_slice(&b[10..]);
    if sha256(&pk)[..8] != id {
        return Err(tr!("Неверный открытый ключ подписи", "Invalid signing public key").into());
    }
    Ok((id, pk))
}

/// Подпись SHA256SUMS.sig: строка «untrusted comment: …» и base64("Ed" + keyid[8] + подпись[64])
fn verify_signature(msg: &[u8], sig_text: &str, pubkey: &str) -> Result<(), String> {
    use ed25519_dalek::{Signature, VerifyingKey};
    let (id, pk) = decode_pubkey(pubkey)?;
    let bad = || tr!("Неверный формат подписи SHA256SUMS", "Invalid SHA256SUMS signature format").to_string();
    let line = sig_text.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("untrusted comment:")).ok_or_else(bad)?;
    let b = crate::assets::base64_decode(line).filter(|b| b.len() == 74 && &b[..2] == b"Ed").ok_or_else(bad)?;
    if b[2..10] != id {
        return Err(tr!("SHA256SUMS подписан другим ключом", "SHA256SUMS is signed with a different key").into());
    }
    let sig = Signature::from_slice(&b[10..]).map_err(|_| bad())?;
    let key = VerifyingKey::from_bytes(&pk).map_err(|_| tr!("Неверный открытый ключ подписи", "Invalid signing public key").to_string())?;
    key.verify_strict(msg, &sig).map_err(|_| tr!("Подпись SHA256SUMS не сходится", "SHA256SUMS signature does not match").into())
}

// ---------------------------------------------------------------------------
// Сеть
// ---------------------------------------------------------------------------
async fn latest_release() -> Result<Value, String> {
    let curl = which("curl").ok_or(tr!("curl не найден", "curl not found"))?;
    let mut c = ff::command(&curl);
    c.args([
        "-sL",
        "--max-time",
        "30",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "User-Agent: FF-Montage",
        &format!("https://api.github.com/repos/{REPO}/releases/latest"),
    ]);
    let out = c.output().await.map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| tr!("GitHub не ответил", "GitHub did not respond").to_string())?;
    if v["tag_name"].is_null() {
        return Err(v["message"].as_str().unwrap_or(tr!("Релизов пока нет", "No releases yet")).to_string());
    }
    Ok(v)
}

/// Скачать по HTTPS (и редиректы только HTTPS)
async fn download(url: &str, to: &Path, max_secs: u32) -> Result<(), String> {
    let curl = which("curl").ok_or(tr!("curl не найден", "curl not found"))?;
    let out = ff::command(&curl)
        .args([
            "-sSL",
            "--fail",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--max-time",
            &max_secs.to_string(),
            "-H",
            "User-Agent: FF-Montage",
            "-o",
            &s(to),
            url,
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(tr!("Не удалось скачать {}: {}", "Cannot download {}: {}", url, String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
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
    let p = plan(&rel, &current, std::env::consts::OS, std::env::consts::ARCH, appimage_path().is_some());
    // «newer»: версия больше, но поставить нельзя (нет сборки для системы или подписи) — окно так и пишет
    let newer = !matches!(p, Err(Skip::BadTag | Skip::NotNewer));
    let (reason, message) = match &p {
        Ok(_) => (Value::Null, Value::Null),
        Err(e) => (json!(e.code()), json!(e.message())),
    };
    Ok(json!({
        "mode": "release", "current": current, "latest": tag, "available": p.is_ok(), "newer": newer,
        "reason": reason, "message": message,
        "url": rel["html_url"], "notes": rel["body"],
        "asset": p.as_ref().ok().map(|p| json!({ "name": p.name, "url": p.url })),
    }))
}

fn emit(app: &AppHandle, text: &str) {
    let _ = app.emit("update:log", json!({ "text": text }));
}

/// Перезапуск: новая копия программы стартует, эта закрывается
pub fn relaunch(app: &AppHandle, exe: &Path) -> Result<(), String> {
    let mut c = std::process::Command::new(exe);
    // Новая копия подождёт, пока эта закроется (иначе сработает защита от второго экземпляра)
    c.current_dir(&paths::get().app_dir).env("FFM_RELAUNCH", "1");
    c.spawn().map_err(|e| tr!("Не удалось запустить новую версию: {}", "Cannot start the new version: {}", e))?;
    app.exit(0);
    Ok(())
}

/// Освободить файл запущенной программы (Windows не даёт перезаписать запущенный exe, но даёт переименовать)
fn move_running_exe(exe: &Path) -> Result<PathBuf, String> {
    let old = exe.with_extension("old.exe");
    let _ = std::fs::remove_file(&old);
    std::fs::rename(exe, &old).map_err(|e| tr!("Не удалось освободить файл программы: {}", "Cannot free the program file: {}", e))?;
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
        if before == after {
            return Ok(json!({ "updated": false, "message": tr!("Уже последняя версия.", "Already the latest version.") }));
        }
        let changed = git(&["diff", "--name-only", &before, &after]).await.unwrap_or_default();
        let needs_build = changed.lines().any(|f| f.starts_with("src-tauri/") || f.starts_with("src/renderer/") || f.starts_with("mcp/"));
        if !needs_build {
            return Ok(
                json!({ "updated": true, "rebuilt": false, "message": tr!("Обновлено. Изменения не затрагивают программу — перезапуск не нужен.", "Updated. The changes do not affect the program — no restart needed.") }),
            );
        }
        let Some(cargo) = which("cargo") else {
            return Ok(json!({ "updated": true, "rebuilt": false, "needsBuild": true,
                "message": tr!("Исходники обновлены. Чтобы применить, запустите setup.cmd (пересборка) или скачайте готовую сборку из Releases.", "Sources updated. To apply, run setup.cmd (rebuild) or download a ready build from Releases.") }));
        };
        emit(
            &app,
            tr!(
                "Пересборка (cargo build --release)… первый раз это несколько минут",
                "Rebuilding (cargo build --release)… the first time takes a few minutes"
            ),
        );
        let built = paths::get()
            .app_dir
            .join("src-tauri")
            .join("target")
            .join("release")
            .join(format!("ff-montage{}", if cfg!(windows) { ".exe" } else { "" }));
        let same = paths::normalize(&built).to_string_lossy().to_lowercase() == paths::normalize(&exe).to_string_lossy().to_lowercase();
        // Запущенный файл нельзя перезаписать, но можно переименовать
        let old = if same { Some(move_running_exe(&exe)?) } else { None };
        let mut c = ff::command(&cargo);
        c.args(["build", "--release"]).current_dir(paths::get().app_dir.join("src-tauri"));
        let out = c.output().await.map_err(|e| e.to_string());
        let ok = matches!(&out, Ok(o) if o.status.success()) && built.exists();
        if !ok {
            if let Some(o) = &old {
                let _ = std::fs::rename(o, &exe);
            }
            let err = match out {
                Ok(o) => String::from_utf8_lossy(&o.stderr)
                    .lines()
                    .rev()
                    .take(12)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n"),
                Err(e) => e,
            };
            return Err(tr!("Сборка не удалась:\n{}", "Build failed:\n{}", err));
        }
        if !same {
            // «FF Montage.exe» в папке программы — копия сборки
            let o = move_running_exe(&exe)?;
            if let Err(e) = std::fs::copy(&built, &exe) {
                let _ = std::fs::rename(&o, &exe);
                return Err(tr!("Не удалось заменить программу: {}", "Cannot replace the program: {}", e));
            }
        }
        emit(&app, tr!("Готово, перезапуск…", "Done, restarting…"));
        relaunch(&app, &exe)?;
        return Ok(json!({ "updated": true, "rebuilt": true }));
    }
    // Готовая сборка: те же проверки, что в update_check, затем подпись и SHA-256
    let rel = latest_release().await?;
    let current = app.package_info().version.to_string();
    let appimage = appimage_path();
    let p = plan(&rel, &current, std::env::consts::OS, std::env::consts::ARCH, appimage.is_some()).map_err(|e| e.message().to_string())?;
    let tmp = paths::get().temp.join("update");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let r = download_verified(&app, &p, &tmp).await;
    let archive = match r {
        Ok(a) => a,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
    };
    if let Some(target) = appimage {
        return install_appimage(&app, &archive, &target);
    }
    emit(&app, tr!("Распаковываю…", "Unpacking…"));
    let x = tmp.join("x");
    std::fs::create_dir_all(&x).map_err(|e| e.to_string())?;
    let tar = which("tar").ok_or(tr!("tar не найден", "tar not found"))?;
    let st = ff::command(&tar).args(["-xf", &s(&archive), "-C", &s(&x)]).output().await.map_err(|e| e.to_string())?;
    if !st.status.success() {
        return Err(tr!("Не удалось распаковать: {}", "Cannot unpack: {}", String::from_utf8_lossy(&st.stderr)));
    }
    let exe_name = exe.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    let found = find_file(&x, &exe_name).ok_or(tr!("В архиве нет программы", "The archive does not contain the program"))?;
    let src_dir = found.parent().unwrap().to_path_buf();
    let dst_dir = exe.parent().unwrap().to_path_buf();
    let old = move_running_exe(&exe)?;
    if let Err(e) = copy_tree(&src_dir, &dst_dir) {
        let _ = std::fs::rename(&old, &exe);
        return Err(tr!("Не удалось установить обновление: {}", "Cannot install the update: {}", e));
    }
    emit(&app, tr!("Готово, перезапуск…", "Done, restarting…"));
    relaunch(&app, &exe)?;
    Ok(json!({ "updated": true }))
}

/// Скачать SHA256SUMS + подпись, проверить подпись, скачать архив и сверить его SHA-256. Возвращает путь к архиву.
async fn download_verified(app: &AppHandle, p: &Plan, tmp: &Path) -> Result<PathBuf, String> {
    emit(app, tr!("Проверяю подпись релиза…", "Checking the release signature…"));
    let (sums_file, sig_file) = (tmp.join(SUMS), tmp.join(SIG));
    download(&p.sums_url, &sums_file, 60).await?;
    download(&p.sig_url, &sig_file, 60).await?;
    let sums = std::fs::read(&sums_file).map_err(|e| e.to_string())?;
    let sig = std::fs::read_to_string(&sig_file).map_err(|e| e.to_string())?;
    verify_signature(&sums, &sig, UPDATE_PUBKEY)?;
    let list = parse_sums(&String::from_utf8_lossy(&sums))?;
    let want = list.get(&p.name).ok_or_else(|| tr!("В SHA256SUMS нет {}", "SHA256SUMS does not list {}", p.name))?.clone();
    emit(app, &tr!("Скачиваю {}…", "Downloading {}…", p.name));
    let archive = tmp.join(&p.name);
    download(&p.url, &archive, 3600).await?;
    let a = archive.clone();
    let got = tokio::task::spawn_blocking(move || sha256_file(&a)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    if got != want {
        return Err(tr!(
            "SHA-256 архива {} не совпадает с SHA256SUMS — обновление не установлено",
            "SHA-256 of {} does not match SHA256SUMS — the update is not installed",
            p.name
        ));
    }
    emit(app, &tr!("Подпись и SHA-256 верны (версия {})", "Signature and SHA-256 are valid (version {})", p.version));
    Ok(archive)
}

/// AppImage: новый файл кладётся рядом с $APPIMAGE и подменяет его переименованием (запущенный образ это не ломает)
#[cfg(unix)]
fn install_appimage(app: &AppHandle, file: &Path, target: &Path) -> Result<Value, String> {
    use std::os::unix::fs::PermissionsExt;
    let next = target.with_extension("AppImage.new");
    let fail = |e: std::io::Error| tr!("Не удалось установить обновление: {}", "Cannot install the update: {}", e);
    std::fs::copy(file, &next).map_err(fail)?;
    std::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o755)).map_err(fail)?;
    if let Err(e) = std::fs::rename(&next, target) {
        let _ = std::fs::remove_file(&next);
        return Err(fail(e));
    }
    emit(app, tr!("Готово, перезапуск…", "Done, restarting…"));
    relaunch(app, target)?;
    Ok(json!({ "updated": true }))
}

#[cfg(not(unix))]
fn install_appimage(_app: &AppHandle, _file: &Path, _target: &Path) -> Result<Value, String> {
    Err(tr!("AppImage бывает только на Linux", "AppImage exists only on Linux").into())
}

fn find_file(dir: &Path, name: &std::ffi::OsStr) -> Option<PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_file(&p, name) {
                return Some(f);
            }
        } else if p.file_name() == Some(name) {
            return Some(p);
        }
    }
    None
}

/// Копирует новые файлы поверх старых; личные настройки и папки данных не трогает
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    const KEEP: [&str; 8] = ["config.json", "settings.json", "portable.txt", "cache", "output", "projects", "user-fonts", "plugins"];
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)?.flatten() {
        let p = e.path();
        let name = e.file_name();
        let n = name.to_string_lossy().to_lowercase();
        if KEEP.contains(&n.as_str()) {
            continue;
        }
        let to = dst.join(&name);
        if p.is_dir() {
            copy_tree(&p, &to)?;
        } else {
            std::fs::copy(&p, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Вектор от tools/sign-release.mjs (Node crypto.sign) на тестовом ключе — проверяет совместимость Node ↔ Rust
    const TEST_PUB: &str = "RWQWQ3S80R7pCXZXzBv23tttBKG/6Zs6XSfgpBx1qXL3MeiFrJVcU6rB";
    const TEST_SIG: &str =
        "untrusted comment: test\nRWQWQ3S80R7pCeFXqFfNQXhQjPArqPFcgsN9r1cBfo3Vw9aFvT9nPoWB21gjxKnThMDErHo80/BFnGbQVEK3Yp1nwJcAkEclXQM=\n";
    fn test_sums() -> String {
        format!("{}  FF-Montage-0.4.0-windows-x64.zip\n{}  FF-Montage-0.4.0-linux-x86_64.tar.gz\n", "aa".repeat(32), "bb".repeat(32))
    }

    #[test]
    fn sums_parse() {
        let m = parse_sums(&test_sums()).unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m["FF-Montage-0.4.0-windows-x64.zip"], "aa".repeat(32));
        // Двоичный режим «*», CRLF, пустые строки, верхний регистр
        let m = parse_sums(&format!("\r\n{} *a.zip\r\n\r\n", "AB".repeat(32))).unwrap();
        assert_eq!(m["a.zip"], "ab".repeat(32));
        assert!(parse_sums("").is_err());
        assert!(parse_sums("abc  a.zip").is_err());
        assert!(parse_sums(&format!("{} a.zip", "aa".repeat(32))).is_err(), "one space");
        assert!(parse_sums(&format!("{}  ", "aa".repeat(32))).is_err(), "no name");
        assert!(parse_sums(&format!("{}  a.zip", "zz".repeat(32))).is_err(), "not hex");
        assert!(parse_sums(&format!("{0}  a.zip\n{0}  a.zip", "aa".repeat(32))).is_err(), "duplicate");
    }

    #[test]
    fn signature_valid_and_tampered() {
        let sums = test_sums();
        verify_signature(sums.as_bytes(), TEST_SIG, TEST_PUB).unwrap();
        // Без комментария и с CRLF — тоже
        verify_signature(sums.as_bytes(), &TEST_SIG.replace('\n', "\r\n"), TEST_PUB).unwrap();
        // Подменили один хэш
        let forged = sums.replacen("aa", "ab", 1);
        assert!(verify_signature(forged.as_bytes(), TEST_SIG, TEST_PUB).is_err());
        // Лишняя строка в конце
        assert!(verify_signature(format!("{sums}\n").as_bytes(), TEST_SIG, TEST_PUB).is_err());
        // Чужой ключ (боевой) — keyid не совпадает
        assert!(verify_signature(sums.as_bytes(), TEST_SIG, UPDATE_PUBKEY).is_err());
        // Испорченная подпись
        let line = TEST_SIG.lines().nth(1).unwrap();
        let mut b = crate::assets::base64_decode(line).unwrap();
        b[40] ^= 1;
        let bad = format!("untrusted comment: x\n{}", b64(&b));
        assert!(verify_signature(sums.as_bytes(), &bad, TEST_PUB).is_err());
        assert!(verify_signature(sums.as_bytes(), "untrusted comment: x\n", TEST_PUB).is_err());
        assert!(verify_signature(sums.as_bytes(), "garbage", TEST_PUB).is_err());
    }

    #[test]
    fn embedded_pubkey_is_valid() {
        decode_pubkey(UPDATE_PUBKEY).unwrap();
        assert!(decode_pubkey("RWQ=").is_err());
        // Подменили байт ключа — keyid больше не сходится
        let mut b = crate::assets::base64_decode(UPDATE_PUBKEY).unwrap();
        b[20] ^= 1;
        assert!(decode_pubkey(&b64(&b)).is_err());
    }

    #[test]
    fn versions() {
        assert_eq!(parse_version("v0.4.0"), Some((0, 4, 0)));
        assert_eq!(parse_version("0.10.2"), Some((0, 10, 2)));
        for bad in ["", "v", "latest", "v0.4", "v0.4.0.1", "v0.4.0-beta", "0.4.x", "V0.4.0", "v 0.4.0", "v0..1", "v99999999999.0.0"] {
            assert_eq!(parse_version(bad), None, "{bad}");
        }
        assert!(parse_version("0.4.0") > parse_version("0.3.10"));
        assert!(parse_version("0.10.0") > parse_version("0.9.9"));
    }

    fn release(tag: &str, names: &[&str]) -> Value {
        json!({ "tag_name": tag, "assets": names.iter().map(|n| json!({ "name": n, "browser_download_url": format!("https://example/{n}") })).collect::<Vec<_>>() })
    }
    const ALL: [&str; 5] = [
        "FF-Montage-0.4.0-windows-x64.zip",
        "FF-Montage-0.4.0-linux-x86_64.tar.gz",
        "FF-Montage-0.4.0-linux-x86_64.AppImage",
        "SHA256SUMS",
        "SHA256SUMS.sig",
    ];

    #[test]
    fn asset_choice() {
        let rel = release("v0.4.0", &ALL);
        assert_eq!(plan(&rel, "0.3.1", "windows", "x86_64", false).unwrap().name, "FF-Montage-0.4.0-windows-x64.zip");
        assert_eq!(plan(&rel, "0.3.1", "linux", "x86_64", false).unwrap().name, "FF-Montage-0.4.0-linux-x86_64.tar.gz");
        let p = plan(&rel, "0.3.1", "linux", "x86_64", true).unwrap();
        assert_eq!(p.name, "FF-Montage-0.4.0-linux-x86_64.AppImage");
        assert_eq!(p.sums_url, "https://example/SHA256SUMS");
        assert_eq!(p.sig_url, "https://example/SHA256SUMS.sig");
        assert_eq!(p.version, "0.4.0");
        // macOS и ARM — готовой сборки нет (раньше на macOS выбирался Linux-архив)
        assert_eq!(plan(&rel, "0.3.1", "macos", "aarch64", false), Err(Skip::NoBuild));
        assert_eq!(plan(&rel, "0.3.1", "macos", "x86_64", false), Err(Skip::NoBuild));
        assert_eq!(plan(&rel, "0.3.1", "windows", "aarch64", false), Err(Skip::NoBuild));
        assert_eq!(plan(&rel, "0.3.1", "linux", "aarch64", false), Err(Skip::NoBuild));
        // Архив другой версии (тег 0.4.0, а файл 0.3.9) не подходит
        let rel = release("v0.4.0", &["FF-Montage-0.3.9-windows-x64.zip", "SHA256SUMS", "SHA256SUMS.sig"]);
        assert_eq!(plan(&rel, "0.3.1", "windows", "x86_64", false), Err(Skip::NoBuild));
        // Старые имена (win-x64, linux-x64) и похожие не подхватываются
        let rel =
            release("v0.4.0", &["FF-Montage-0.4.0-win-x64.zip", "FF-Montage-0.4.0-windows-x64.zip.part", "SHA256SUMS", "SHA256SUMS.sig"]);
        assert_eq!(plan(&rel, "0.3.1", "windows", "x86_64", false), Err(Skip::NoBuild));
    }

    #[test]
    fn tag_and_signature_required() {
        assert_eq!(plan(&release("v0.4.0", &ALL), "0.4.0", "windows", "x86_64", false), Err(Skip::NotNewer));
        assert_eq!(plan(&release("v0.3.9", &ALL), "0.4.0", "windows", "x86_64", false), Err(Skip::NotNewer));
        assert_eq!(plan(&release("latest", &ALL), "0.3.1", "windows", "x86_64", false), Err(Skip::BadTag));
        assert_eq!(plan(&release("v0.4.0-rc1", &ALL), "0.3.1", "windows", "x86_64", false), Err(Skip::BadTag));
        assert_eq!(plan(&json!({ "assets": [] }), "0.3.1", "windows", "x86_64", false), Err(Skip::BadTag));
        assert_eq!(plan(&release("v0.4.0", &ALL), "garbage", "windows", "x86_64", false), Err(Skip::NotNewer));
        assert_eq!(plan(&release("v0.4.0", &ALL[..4]), "0.3.1", "windows", "x86_64", false), Err(Skip::Unsigned));
        assert_eq!(plan(&release("v0.4.0", &[ALL[0], ALL[4]]), "0.3.1", "windows", "x86_64", false), Err(Skip::Unsigned));
    }

    #[test]
    fn file_hash() {
        let dir = std::env::temp_dir().join(format!("ffm-update-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.bin");
        std::fs::write(&f, b"abc").unwrap();
        assert_eq!(sha256_file(&f).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn b64(b: &[u8]) -> String {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut s = String::new();
        for c in b.chunks(3) {
            let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
            for i in 0..4 {
                if i <= c.len() {
                    s.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
                } else {
                    s.push('=');
                }
            }
        }
        s
    }
}
