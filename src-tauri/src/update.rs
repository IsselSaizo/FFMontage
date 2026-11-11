// «Проверить обновления».
//  • Папка программы — git-клон: git fetch → сколько новых коммитов → git pull --ff-only →
//    если изменились исходники и есть Rust (cargo) — пересборка и перезапуск.
//  • Готовая сборка (архив с GitHub, M0.10 / R-4): список релизов (и хотфиксов — пре-релизов vX.Y.Z-hotfix.N, если они
//    включены, см. choose) → тег должен быть версией и больше текущей →
//    ассет строго своей ОС и архитектуры → SHA256SUMS с подписью ed25519 (ключ — UPDATE_PUBKEY) →
//    SHA-256 скачанного архива сверяется с SHA256SUMS → только после этого замена программы и перезапуск.
//    Любая ошибка проверки — ничего не устанавливается. Подпись делает tools/sign-release.mjs в release-workflow.
//    Сеть (0.5.1-hotfix.1): файл качается по очереди путями из routes — прямая ссылка github.com, тот же ассет через
//    api.github.com (у части провайдеров github.com недоступен, а API открывается) и, если в Windows включён системный
//    прокси, прямая ссылка через него (curl сам системный прокси не берёт). Подпись и SHA-256 проверяются как раньше.
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
// Версии: релиз «1.2.3» / «v1.2.3» и хотфикс «1.2.3-hotfix.N» (N ≥ 1) — пре-релиз СЛЕДУЮЩЕЙ версии:
// 0.5.0 < 0.5.1-hotfix.1 < 0.5.1-hotfix.2 < 0.5.1. Прочие пре-релизы (rc, beta…) и теги не предлагаются.
// ---------------------------------------------------------------------------
/// Ранг релиза: выше любого хотфикса той же версии (N хотфикса — не больше 9 цифр)
const RELEASE_RANK: u64 = u64::MAX;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    /// N хотфикса или RELEASE_RANK у релиза (порядок полей = порядок сравнения)
    rank: u64,
}

impl Version {
    fn is_hotfix(&self) -> bool {
        self.rank != RELEASE_RANK
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if self.is_hotfix() {
            write!(f, "-hotfix.{}", self.rank)?;
        }
        Ok(())
    }
}

fn parse_version(v: &str) -> Option<Version> {
    let v = v.trim();
    let v = v.strip_prefix('v').unwrap_or(v);
    let num = |p: &str| -> Option<u64> {
        if p.is_empty() || p.len() > 9 || !p.bytes().all(|b| b.is_ascii_digit()) {
            None
        } else {
            p.parse().ok()
        }
    };
    let (core, rank) = match v.split_once('-') {
        None => (v, RELEASE_RANK),
        Some((core, pre)) => {
            // Только «hotfix.N»: N без ведущих нулей, не 0
            let n = pre.strip_prefix("hotfix.")?;
            if n.starts_with('0') {
                return None;
            }
            (core, num(n)?)
        }
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    Some(Version { major: num(parts[0])?, minor: num(parts[1])?, patch: num(parts[2])?, rank })
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

/// Программа запущена из AppImage: обновлять надо сам файл $APPIMAGE (только если exe — из этого образа, paths::appimage)
fn appimage_path() -> Option<PathBuf> {
    paths::appimage().map(|a| a.file.clone()).filter(|p| p.is_file())
}

/// Какой ассет релиза взяло бы обновление для этой копии программы (для «--engine info»)
pub fn current_asset(version: &str) -> Option<String> {
    asset_name(version, std::env::consts::OS, std::env::consts::ARCH, appimage_path().is_some())
}

/// Где лежит ассет релиза: прямая ссылка (github.com/…/releases/download/…) и тот же файл через API
/// (api.github.com/repos/…/releases/assets/<id> с «Accept: application/octet-stream» — редирект на тот же файл)
#[derive(Debug, PartialEq, Clone)]
struct Link {
    web: String,
    api: Option<String>,
}

/// Ссылки на ассет релиза по точному имени
fn asset_url(rel: &Value, name: &str) -> Option<Link> {
    rel["assets"].as_array()?.iter().find_map(|a| {
        if a["name"].as_str()? != name {
            return None;
        }
        let web = a["browser_download_url"].as_str()?.to_string();
        let api = a["url"].as_str().filter(|u| u.starts_with("https://api.github.com/")).map(str::to_string);
        Some(Link { web, api })
    })
}

/// Что и откуда ставить
#[derive(Debug, PartialEq, Clone)]
struct Plan {
    version: String,
    name: String,
    url: Link,
    sums_url: Link,
    sig_url: Link,
    /// Хотфикс (пре-релиз GitHub vX.Y.Z-hotfix.N), а не обычный релиз
    hotfix: bool,
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
    let v = parse_version(rel["tag_name"].as_str().unwrap_or("")).ok_or(Skip::BadTag)?;
    let version = v.to_string();
    // Текущая версия не разобралась — не рискуем
    let cur = parse_version(current).ok_or(Skip::NotNewer)?;
    if v <= cur {
        return Err(Skip::NotNewer);
    }
    let name = asset_name(&version, os, arch, appimage).ok_or(Skip::NoBuild)?;
    let url = asset_url(rel, &name).ok_or(Skip::NoBuild)?;
    let sums_url = asset_url(rel, SUMS).ok_or(Skip::Unsigned)?;
    let sig_url = asset_url(rel, SIG).ok_or(Skip::Unsigned)?;
    Ok(Plan { version, name, url, sums_url, sig_url, hotfix: v.is_hotfix() })
}

// ---------------------------------------------------------------------------
// Выбор из списка релизов GitHub. Хотфиксы — пре-релизы с тегом vX.Y.Z-hotfix.N (собирает и подписывает тот же
// release.yml); предлагаются, только если включена настройка update.hotfixes. Черновики не смотрим, прочие пре-релизы
// (rc, beta, пре-релиз с тегом обычной версии) — тоже. Берётся самая новая версия новее установленной; если для неё нет
// сборки этой системы или подписи — следующая по новизне, которую можно поставить; если таких нет — причина самой новой.
// ---------------------------------------------------------------------------
/// Результат выбора: план (или причина отказа), релиз, о котором речь (ссылка и описание в окне), последний обычный релиз
struct Choice<'a> {
    plan: Result<Plan, Skip>,
    subject: Option<&'a Value>,
    latest: Option<&'a Value>,
}

fn choose<'a>(rels: &'a [Value], current: &str, hotfixes: bool, os: &str, arch: &str, appimage: bool) -> Choice<'a> {
    let tag = |r: &Value| parse_version(r["tag_name"].as_str().unwrap_or(""));
    let pre = |r: &Value| r["prerelease"].as_bool().unwrap_or(false);
    let listed: Vec<&Value> = rels.iter().filter(|r| r["draft"].as_bool() != Some(true)).collect();
    // Обычные релизы (не пре-релизы и не хотфиксы); последний — с самой большой версией, а если ни один тег
    // не версия — первый в списке (самый свежий, как /releases/latest)
    let stable: Vec<&Value> = listed.iter().copied().filter(|r| !pre(r) && !tag(r).is_some_and(|v| v.is_hotfix())).collect();
    let latest = stable.iter().copied().filter_map(|r| tag(r).map(|v| (v, r))).max_by_key(|x| x.0).map(|x| x.1).or(stable.first().copied());
    let cur = parse_version(current);
    let mut cands: Vec<(Version, &Value)> = listed
        .iter()
        .filter_map(|r| {
            let v = tag(r)?;
            let ok = if v.is_hotfix() { hotfixes } else { !pre(r) };
            ok.then_some((v, *r))
        })
        .filter(|(v, _)| cur.is_some_and(|c| *v > c))
        .collect();
    cands.sort_by_key(|c| std::cmp::Reverse(c.0));
    let mut first_err: Option<(Skip, &Value)> = None;
    for (_, r) in &cands {
        match plan(r, current, os, arch, appimage) {
            Ok(p) => return Choice { plan: Ok(p), subject: Some(r), latest },
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some((e, r));
                }
            }
        }
    }
    if let Some((e, r)) = first_err {
        return Choice { plan: Err(e), subject: Some(r), latest };
    }
    // Новее ничего нет: ни у одного обычного релиза тег не версия — так и говорим (как раньше с /releases/latest)
    let bad_tag = latest.is_some_and(|r| tag(r).is_none());
    Choice { plan: Err(if bad_tag { Skip::BadTag } else { Skip::NotNewer }), subject: latest, latest }
}

/// Получать ли хотфиксы: settings.json → update.hotfixes (по умолчанию да). Миграция с 0.5.0: если его нет,
/// а старое update.drive (хотфиксы с Google Диска) выключено — тоже выключено.
fn hotfixes_enabled(settings: &Value) -> bool {
    let u = &settings["update"];
    u["hotfixes"].as_bool().unwrap_or(u["drive"].as_bool() != Some(false))
}

/// Выбор для этой копии программы (ОС, архитектура, AppImage)
fn choose_here<'a>(rels: &'a [Value], current: &str, hotfixes: bool) -> Choice<'a> {
    choose(rels, current, hotfixes, std::env::consts::OS, std::env::consts::ARCH, appimage_path().is_some())
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
/// Подключение к серверу: дольше не ждём (без него curl на Windows ждёт ~21 с на каждый адрес), дальше — другой путь
const CONNECT_SECS: &str = "20";

/// Совет, когда GitHub не открылся ни одним путём
fn offline_hint() -> String {
    tr!(
        "Похоже, GitHub недоступен из этой сети (провайдер, VPN или прокси). Повторите позже или через другое подключение. \
         Вручную: скачайте архив со страницы https://github.com/{}/releases и распакуйте поверх папки программы — \
         настройки и проекты останутся.",
        "GitHub seems to be unreachable from this network (ISP, VPN or proxy). Try again later or over another connection. \
         By hand: download the archive from https://github.com/{}/releases and unpack it over the program folder — \
         settings and projects are kept.",
        REPO
    )
}

/// curl сам берёт прокси из переменных окружения — тогда системный не подставляем
#[cfg_attr(not(windows), allow(dead_code))]
fn proxy_in_env() -> bool {
    ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"].iter().any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()))
}

/// Строка ProxyServer из настроек Windows → адрес для curl --proxy.
/// «host:port» — один HTTP-прокси на всё; «http=h:p;https=h:p;socks=h:p» — по протоколам (берём https, затем http,
/// затем socks — у Windows это SOCKS4). Системный прокси читается только на Windows (на Linux — тесты).
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_proxy_server(s: &str) -> Option<String> {
    let s = s.trim();
    let pick = if s.contains('=') {
        let parts: Vec<(String, &str)> = s
            .split(';')
            .filter_map(|p| p.split_once('=').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim())))
            .filter(|(_, v)| !v.is_empty())
            .collect();
        let get = |k: &str| parts.iter().find(|(n, _)| n == k).map(|(_, v)| *v);
        match (get("https").or_else(|| get("http")), get("socks")) {
            (Some(v), _) => v.to_string(),
            (None, Some(v)) if !v.contains("://") => format!("socks4a://{v}"),
            (None, Some(v)) => v.to_string(),
            (None, None) => return None,
        }
    } else {
        s.split(';').next().unwrap_or("").trim().to_string()
    };
    if pick.is_empty() || pick.starts_with('-') || pick.chars().any(char::is_whitespace) {
        return None;
    }
    Some(if pick.contains("://") { pick } else { format!("http://{pick}") })
}

/// Системный прокси Windows (Параметры → Сеть → Прокси; его ставят и VPN-клиенты в режиме «системный прокси»).
/// Браузер и окно программы ходят через него, а curl — нет. PAC-скрипты (AutoConfigURL) не поддерживаются.
#[cfg(windows)]
fn system_proxy() -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ};
    if proxy_in_env() {
        return None;
    }
    let key = HSTRING::from("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings");
    let mut on: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let r = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &key,
            &HSTRING::from("ProxyEnable"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut on as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    if r != ERROR_SUCCESS || on == 0 {
        return None;
    }
    let mut buf = [0u16; 2048];
    let mut size = std::mem::size_of_val(&buf) as u32;
    let r = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &key,
            &HSTRING::from("ProxyServer"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut size),
        )
    };
    if r != ERROR_SUCCESS {
        return None;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    parse_proxy_server(&String::from_utf16_lossy(&buf[..end]))
}

/// На Linux curl и так берёт https_proxy / all_proxy из окружения
#[cfg(not(windows))]
fn system_proxy() -> Option<String> {
    None
}

/// Один путь до файла
#[derive(Debug, PartialEq)]
struct Route {
    url: String,
    /// Адрес ассета в API: нужен заголовок «Accept: application/octet-stream», иначе придёт JSON с описанием
    api: bool,
    proxy: Option<String>,
}

impl Route {
    /// «github.com», «api.github.com», «github.com через прокси http://127.0.0.1:8080» — для журнала и ошибки
    fn describe(&self) -> String {
        let host = self.url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or(&self.url);
        match &self.proxy {
            Some(p) => tr!("{} через прокси {}", "{} via proxy {}", host, p),
            None => host.to_string(),
        }
    }
}

/// Пути по очереди: прямая ссылка → через API → прямая ссылка через системный прокси
fn routes(link: &Link, proxy: Option<&str>) -> Vec<Route> {
    let mut r = vec![Route { url: link.web.clone(), api: false, proxy: None }];
    if let Some(a) = &link.api {
        r.push(Route { url: a.clone(), api: true, proxy: None });
    }
    if let Some(p) = proxy {
        r.push(Route { url: link.web.clone(), api: false, proxy: Some(p.to_string()) });
    }
    r
}

/// Аргументы curl для скачивания по одному пути: только HTTPS (и редиректы тоже), обрыв при подключении дольше
/// CONNECT_SECS и при скорости ниже 1 КБ/с дольше минуты (зависшее соединение), общий предел max_secs
fn curl_args(r: &Route, to: &Path, max_secs: u32) -> Vec<String> {
    let mut a: Vec<String> = [
        "-sSL",
        "--fail",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--connect-timeout",
        CONNECT_SECS,
        "--speed-limit",
        "1024",
        "--speed-time",
        "60",
        "--max-time",
        &max_secs.to_string(),
        "-H",
        "User-Agent: FF-Montage",
    ]
    .iter()
    .map(|x| x.to_string())
    .collect();
    if r.api {
        a.extend(["-H".into(), "Accept: application/octet-stream".into()]);
    }
    if let Some(p) = &r.proxy {
        a.extend(["--proxy".into(), p.clone()]);
    }
    a.extend(["-o".into(), s(to), r.url.clone()]);
    a
}

/// Последние релизы и пре-релизы (новые сверху). Напрямую, а если не ответил — через системный прокси.
async fn releases() -> Result<Vec<Value>, String> {
    let curl = which("curl").ok_or(tr!("curl не найден", "curl not found"))?;
    let url = format!("https://api.github.com/repos/{REPO}/releases?per_page=20");
    let mut errs: Vec<String> = vec![];
    for proxy in std::iter::once(None).chain(system_proxy().map(Some)) {
        let mut c = ff::command(&curl);
        c.args(["-sSL", "--connect-timeout", CONNECT_SECS, "--max-time", "30"]);
        c.args(["-H", "Accept: application/vnd.github+json", "-H", "User-Agent: FF-Montage"]);
        if let Some(p) = &proxy {
            c.args(["--proxy", p]);
        }
        c.arg(&url);
        let out = c.output().await.map_err(|e| e.to_string())?;
        let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) else {
            let r = Route { url: url.clone(), api: true, proxy };
            errs.push(format!("{}: {}", r.describe(), String::from_utf8_lossy(&out.stderr).trim()));
            continue;
        };
        return match v {
            Value::Array(list) if !list.is_empty() => Ok(list),
            Value::Array(_) => Err(tr!("Релизов пока нет", "No releases yet").into()),
            // Ошибка API (лимит запросов и т. п.) — объект с message
            v => Err(v["message"].as_str().unwrap_or(tr!("GitHub не ответил", "GitHub did not respond")).to_string()),
        };
    }
    Err(format!("{}\n{}\n\n{}", tr!("GitHub не ответил", "GitHub did not respond"), errs.join("\n"), offline_hint()))
}

/// Скачать файл релиза: пути из routes по очереди, до первого удачного. В окне обновления видно, какой путь пробуется.
async fn download(app: &AppHandle, link: &Link, to: &Path, max_secs: u32) -> Result<(), String> {
    let curl = which("curl").ok_or(tr!("curl не найден", "curl not found"))?;
    let mut errs: Vec<String> = vec![];
    for (i, r) in routes(link, system_proxy().as_deref()).iter().enumerate() {
        if i > 0 {
            emit(app, &tr!("Не получилось, пробую через {}…", "Failed, trying via {}…", r.describe()));
        }
        let _ = std::fs::remove_file(to);
        let out = ff::command(&curl).args(curl_args(r, to, max_secs)).output().await.map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        errs.push(format!("{}: {}", r.describe(), String::from_utf8_lossy(&out.stderr).trim()));
    }
    let _ = std::fs::remove_file(to);
    let name = link.web.rsplit('/').next().unwrap_or(&link.web);
    Err(tr!("Не удалось скачать {}:\n{}\n\n{}", "Cannot download {}:\n{}\n\n{}", name, errs.join("\n"), offline_hint()))
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
    // Релизы GitHub и (если включено) хотфиксы — пре-релизы vX.Y.Z-hotfix.N; ставится самое новое, что можно поставить
    let hotfixes = hotfixes_enabled(&crate::settings::load());
    let rels = releases().await?;
    let c = choose_here(&rels, &current, hotfixes);
    let p = &c.plan;
    let subject = c.subject.unwrap_or(&Value::Null);
    let latest = c.latest.or(c.subject).and_then(|r| r["tag_name"].as_str()).unwrap_or("");
    // «newer»: версия больше, но поставить нельзя (нет сборки для системы или подписи) — окно так и пишет
    let newer = !matches!(p, Err(Skip::BadTag | Skip::NotNewer));
    let (reason, message) = match p {
        Ok(_) => (Value::Null, Value::Null),
        Err(e) => (json!(e.code()), json!(e.message())),
    };
    Ok(json!({
        "mode": "release", "current": current, "latest": latest, "available": p.is_ok(), "newer": newer,
        "reason": reason, "message": message,
        "url": subject["html_url"], "notes": subject["body"],
        "asset": p.as_ref().ok().map(|p| json!({
            "name": p.name, "url": p.url.web, "version": p.version, "hotfix": p.hotfix,
            "source": if p.hotfix { "hotfix" } else { "release" },
        })),
        "hotfixes": { "enabled": hotfixes },
    }))
}

fn emit(app: &AppHandle, text: &str) {
    let _ = app.emit("update:log", json!({ "text": text }));
}

/// Перезапуск: новая копия программы стартует, эта закрывается. В AppImage запускается файл образа ($APPIMAGE),
/// а не exe из папки образа: та исчезнет вместе с этим процессом (paths::launch_command).
pub fn relaunch(app: &AppHandle, exe: &Path) -> Result<(), String> {
    let mut c = paths::launch_command(exe);
    // Новая копия подождёт, пока эта закроется (иначе сработает защита от второго экземпляра)
    c.env("FFM_RELAUNCH", "1");
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
    let current = app.package_info().version.to_string();
    let appimage = appimage_path();
    let rels = releases().await?;
    let p = choose_here(&rels, &current, hotfixes_enabled(&crate::settings::load())).plan.map_err(|e| e.message().to_string())?;
    if p.hotfix {
        emit(&app, &tr!("Хотфикс {} (предварительный выпуск на GitHub)", "Hotfix {} (GitHub pre-release)", p.version));
    }
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
    download(app, &p.sums_url, &sums_file, 60).await?;
    download(app, &p.sig_url, &sig_file, 60).await?;
    let sums = std::fs::read(&sums_file).map_err(|e| e.to_string())?;
    let sig = std::fs::read_to_string(&sig_file).map_err(|e| e.to_string())?;
    verify_signature(&sums, &sig, UPDATE_PUBKEY)?;
    let list = parse_sums(&String::from_utf8_lossy(&sums))?;
    let want = list.get(&p.name).ok_or_else(|| tr!("В SHA256SUMS нет {}", "SHA256SUMS does not list {}", p.name))?.clone();
    emit(app, &tr!("Скачиваю {}…", "Downloading {}…", p.name));
    let archive = tmp.join(&p.name);
    download(app, &p.url, &archive, 3600).await?;
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

/// Временный файл нового образа: рядом с $APPIMAGE (та же файловая система — rename атомарен), имя + «.new»
#[cfg_attr(not(unix), allow(dead_code))]
fn appimage_next(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(".new");
    target.with_file_name(name)
}

/// Скопировать новый образ рядом с target (права 755) и подменить target переименованием; при ошибке target не тронут
#[cfg(unix)]
fn swap_appimage(file: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let next = appimage_next(target);
    let r = std::fs::copy(file, &next)
        .and_then(|_| std::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o755)))
        .and_then(|_| std::fs::rename(&next, target));
    if r.is_err() {
        let _ = std::fs::remove_file(&next);
    }
    r
}

/// AppImage: новый файл кладётся рядом с $APPIMAGE и подменяет его переименованием (запущенный образ это не ломает:
/// он смонтирован из старого inode). Имя файла не меняется — ярлыки и «non-Steam game» в Steam продолжают работать.
#[cfg(unix)]
fn install_appimage(app: &AppHandle, file: &Path, target: &Path) -> Result<Value, String> {
    swap_appimage(file, target).map_err(|e| tr!("Не удалось установить обновление: {}", "Cannot install the update: {}", e))?;
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
        let v = |s: &str| parse_version(s).unwrap();
        assert_eq!(v("v0.4.0"), Version { major: 0, minor: 4, patch: 0, rank: RELEASE_RANK });
        assert_eq!(v("0.10.2"), Version { major: 0, minor: 10, patch: 2, rank: RELEASE_RANK });
        assert_eq!(v("v0.5.1-hotfix.1"), Version { major: 0, minor: 5, patch: 1, rank: 1 });
        assert_eq!(v("0.5.1-hotfix.12").rank, 12);
        assert!(!v("0.5.1").is_hotfix() && v("0.5.1-hotfix.3").is_hotfix());
        // Строка версии обратно — как в имени ассета и в теге
        assert_eq!(v("v0.5.1").to_string(), "0.5.1");
        assert_eq!(v("v0.5.1-hotfix.2").to_string(), "0.5.1-hotfix.2");
        for bad in [
            "",
            "v",
            "latest",
            "v0.4",
            "v0.4.0.1",
            "v0.4.0-beta",
            "v0.4.0-rc1",
            "v0.4.0-rc.1",
            "0.4.x",
            "V0.4.0",
            "v 0.4.0",
            "v0..1",
            "v99999999999.0.0",
            "0.5.1-",
            "0.5.1-hotfix",
            "0.5.1-hotfix.",
            "0.5.1-hotfix.0",
            "0.5.1-hotfix.01",
            "0.5.1-hotfix.1.2",
            "0.5.1-hotfix.x",
            "0.5.1-hotfix.-1",
            "0.5.1-Hotfix.1",
            "0.5.1-hotfix1",
            "0.5.1-hotfix.1+build",
            "0.5.1-hotfix.1-hotfix.2",
            "0.5-hotfix.1",
            "0.5.1-hotfix.9999999999",
        ] {
            assert_eq!(parse_version(bad), None, "{bad}");
        }
        assert!(v("0.4.0") > v("0.3.10"));
        assert!(v("0.10.0") > v("0.9.9"));
        // 0.5.0 < 0.5.1-hotfix.1 < 0.5.1-hotfix.2 < 0.5.1-hotfix.10 < 0.5.1 < 0.5.2-hotfix.1
        let order = ["0.5.0", "0.5.1-hotfix.1", "0.5.1-hotfix.2", "0.5.1-hotfix.10", "0.5.1", "0.5.2-hotfix.1", "0.6.0"];
        for w in order.windows(2) {
            assert!(v(w[0]) < v(w[1]), "{} < {}", w[0], w[1]);
        }
        assert_eq!(v("0.5.1-hotfix.1"), v("v0.5.1-hotfix.1"));
    }

    fn release(tag: &str, names: &[&str]) -> Value {
        let asset = |n: &&str| json!({ "name": n, "browser_download_url": format!("https://example/{n}"), "url": format!("https://api.github.com/repos/x/releases/assets/{n}") });
        json!({ "tag_name": tag, "assets": names.iter().map(asset).collect::<Vec<_>>() })
    }

    #[test]
    fn asset_links() {
        let rel = json!({ "assets": [
            { "name": "a.zip", "browser_download_url": "https://github.com/x/releases/download/v1/a.zip",
              "url": "https://api.github.com/repos/x/releases/assets/1" },
            // Адрес API не с api.github.com (или не https) — не берём, остаётся только прямая ссылка
            { "name": "b.zip", "browser_download_url": "https://github.com/x/releases/download/v1/b.zip", "url": "http://api.github.com/x" },
            { "name": "c.zip", "browser_download_url": "https://github.com/x/releases/download/v1/c.zip" },
            { "name": "d.zip", "url": "https://api.github.com/repos/x/releases/assets/4" },
        ]});
        assert_eq!(asset_url(&rel, "a.zip").unwrap().api.as_deref(), Some("https://api.github.com/repos/x/releases/assets/1"));
        assert_eq!(asset_url(&rel, "b.zip").unwrap(), Link { web: "https://github.com/x/releases/download/v1/b.zip".into(), api: None });
        assert_eq!(asset_url(&rel, "c.zip").unwrap().api, None);
        // Без прямой ссылки ассет не считается найденным
        assert_eq!(asset_url(&rel, "d.zip"), None);
        assert_eq!(asset_url(&rel, "e.zip"), None);
    }

    #[test]
    fn download_routes() {
        let link = Link {
            web: "https://github.com/x/releases/download/v1/a.zip".into(),
            api: Some("https://api.github.com/repos/x/releases/assets/1".into()),
        };
        let r = routes(&link, None);
        assert_eq!(
            r.iter().map(|r| (r.url.as_str(), r.api, r.proxy.is_some())).collect::<Vec<_>>(),
            [
                ("https://github.com/x/releases/download/v1/a.zip", false, false),
                ("https://api.github.com/repos/x/releases/assets/1", true, false)
            ]
        );
        assert_eq!(r[0].describe(), "github.com");
        assert_eq!(r[1].describe(), "api.github.com");
        let r = routes(&link, Some("http://127.0.0.1:8080"));
        assert_eq!(r.len(), 3);
        assert_eq!((r[2].url.as_str(), r[2].api, r[2].proxy.as_deref()), (link.web.as_str(), false, Some("http://127.0.0.1:8080")));
        assert!(r[2].describe().starts_with("github.com ") && r[2].describe().ends_with(" http://127.0.0.1:8080"));
        // Без адреса API — прямая ссылка и прокси
        let only = Link { web: link.web.clone(), api: None };
        assert_eq!(routes(&only, None).len(), 1);
        assert_eq!(routes(&only, Some("http://p:1")).len(), 2);

        // Аргументы curl: HTTPS-only, тайм-аут подключения, Accept только для API, --proxy только у пути через прокси
        let to = Path::new("out.bin");
        let r = routes(&link, Some("http://127.0.0.1:8080"));
        let a: Vec<Vec<String>> = r.iter().map(|r| curl_args(r, to, 60)).collect();
        for x in &a {
            for need in ["--fail", "--proto", "=https", "--proto-redir", "--connect-timeout", "--max-time"] {
                assert!(x.iter().any(|y| y == need), "{need} in {x:?}");
            }
            assert_eq!(x[x.len() - 3..], ["-o".to_string(), "out.bin".into(), x.last().unwrap().clone()]);
        }
        let has = |x: &Vec<String>, s: &str| x.iter().any(|y| y == s);
        assert!(!has(&a[0], "Accept: application/octet-stream") && has(&a[1], "Accept: application/octet-stream"));
        assert!(!has(&a[0], "--proxy") && !has(&a[1], "--proxy") && has(&a[2], "--proxy"));
        assert_eq!(a[1].last().unwrap(), "https://api.github.com/repos/x/releases/assets/1");
    }

    #[test]
    fn proxy_server_setting() {
        let p = |s: &str| parse_proxy_server(s);
        assert_eq!(p("127.0.0.1:10809").as_deref(), Some("http://127.0.0.1:10809"));
        assert_eq!(p(" proxy.local:3128 ").as_deref(), Some("http://proxy.local:3128"));
        assert_eq!(p("http://127.0.0.1:8080").as_deref(), Some("http://127.0.0.1:8080"));
        assert_eq!(p("http=h1:1;https=h2:2;socks=h3:3").as_deref(), Some("http://h2:2"));
        assert_eq!(p("HTTP=h1:1;ftp=h4:4").as_deref(), Some("http://h1:1"));
        assert_eq!(p("socks=127.0.0.1:1080").as_deref(), Some("socks4a://127.0.0.1:1080"));
        assert_eq!(p("socks=socks5h://127.0.0.1:1080").as_deref(), Some("socks5h://127.0.0.1:1080"));
        assert_eq!(p("https=;http=h1:1").as_deref(), Some("http://h1:1"));
        for bad in ["", "  ", "ftp=h4:4", "https=", "-x", "a b:1"] {
            assert_eq!(p(bad), None, "{bad}");
        }
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
        assert_eq!(p.sums_url.web, "https://example/SHA256SUMS");
        assert_eq!(p.sig_url.web, "https://example/SHA256SUMS.sig");
        assert_eq!(p.url.api.as_deref(), Some("https://api.github.com/repos/x/releases/assets/FF-Montage-0.4.0-linux-x86_64.AppImage"));
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
    fn hotfix_plan() {
        // Ассет хотфикса — то же имя с полной версией: FF-Montage-0.5.1-hotfix.1-windows-x64.zip
        let names = ["FF-Montage-0.5.1-hotfix.1-windows-x64.zip", "FF-Montage-0.5.1-hotfix.1-linux-x86_64.AppImage", SUMS, SIG];
        let rel = release("v0.5.1-hotfix.1", &names);
        let p = plan(&rel, "0.5.0", "windows", "x86_64", false).unwrap();
        assert_eq!((p.version.as_str(), p.name.as_str(), p.hotfix), ("0.5.1-hotfix.1", names[0], true));
        assert_eq!(plan(&rel, "0.5.0", "linux", "x86_64", true).unwrap().name, names[1]);
        // Архив без суффикса хотфикса в хотфикс-релизе не подходит
        let rel2 = release("v0.5.1-hotfix.1", &["FF-Montage-0.5.1-windows-x64.zip", SUMS, SIG]);
        assert_eq!(plan(&rel2, "0.5.0", "windows", "x86_64", false), Err(Skip::NoBuild));
        // Установлен хотфикс: этот же и более старые — не новее; релиз той же версии — новее
        assert_eq!(plan(&rel, "0.5.1-hotfix.1", "windows", "x86_64", false), Err(Skip::NotNewer));
        assert_eq!(plan(&rel, "0.5.1-hotfix.2", "windows", "x86_64", false), Err(Skip::NotNewer));
        assert_eq!(plan(&rel, "0.5.1", "windows", "x86_64", false), Err(Skip::NotNewer));
        let r = release("v0.5.1", &["FF-Montage-0.5.1-windows-x64.zip", SUMS, SIG]);
        let p = plan(&r, "0.5.1-hotfix.2", "windows", "x86_64", false).unwrap();
        assert_eq!((p.version.as_str(), p.hotfix), ("0.5.1", false));
    }

    /// Релиз из списка GitHub: тег, пре-релиз ли, ассеты под Windows (+ SHA256SUMS и подпись, если signed)
    fn gh(tag: &str, prerelease: bool, build: bool, signed: bool) -> Value {
        let v = tag.trim_start_matches('v');
        let mut names = vec![];
        let win = format!("FF-Montage-{v}-windows-x64.zip");
        if build {
            names.push(win.as_str());
        }
        if signed {
            names.extend([SUMS, SIG]);
        }
        let mut r = release(tag, &names);
        r["prerelease"] = json!(prerelease);
        r["draft"] = json!(false);
        r["html_url"] = json!(format!("https://github.com/x/releases/tag/{tag}"));
        r["body"] = json!(format!("notes {tag}"));
        r
    }

    fn pick(rels: &[Value], current: &str, hotfixes: bool) -> (Result<String, Skip>, Option<String>, Option<String>) {
        let c = choose(rels, current, hotfixes, "windows", "x86_64", false);
        let tag = |r: Option<&Value>| r.and_then(|r| r["tag_name"].as_str()).map(str::to_string);
        (c.plan.map(|p| p.version), tag(c.subject), tag(c.latest))
    }

    #[test]
    fn release_list_choice() {
        let ok = |s: &str| -> Result<String, Skip> { Ok(s.to_string()) };
        let some = |s: &str| Some(s.to_string());
        // Список GitHub — новые сверху
        let rels = vec![
            gh("v0.5.1-hotfix.2", true, true, true),
            gh("v0.5.1-hotfix.1", true, true, true),
            gh("v0.5.0", false, true, true),
            gh("v0.4.7", false, true, true),
        ];
        // Хотфиксы включены — самый новый хотфикс; «последний релиз» — обычный v0.5.0
        assert_eq!(pick(&rels, "0.5.0", true), (ok("0.5.1-hotfix.2"), some("v0.5.1-hotfix.2"), some("v0.5.0")));
        let c = choose(&rels, "0.5.0", true, "windows", "x86_64", false);
        assert!(c.plan.unwrap().hotfix);
        // Выключены — пре-релизы не смотрим: новее ничего нет
        assert_eq!(pick(&rels, "0.5.0", false), (Err(Skip::NotNewer), some("v0.5.0"), some("v0.5.0")));
        assert_eq!(pick(&rels, "0.4.7", false), (ok("0.5.0"), some("v0.5.0"), some("v0.5.0")));
        // Установлен хотфикс
        assert_eq!(pick(&rels, "0.5.1-hotfix.1", true).0, ok("0.5.1-hotfix.2"));
        assert_eq!(pick(&rels, "0.5.1-hotfix.2", true).0, Err(Skip::NotNewer));
        assert_eq!(pick(&rels, "0.5.1-hotfix.2", false).0, Err(Skip::NotNewer));
        // Релиз выигрывает у своих хотфиксов (и ставится поверх установленного хотфикса, даже если хотфиксы выключены)
        let mut with_rel = vec![gh("v0.5.1", false, true, true)];
        with_rel.extend(rels.iter().cloned());
        assert_eq!(pick(&with_rel, "0.5.0", true), (ok("0.5.1"), some("v0.5.1"), some("v0.5.1")));
        assert_eq!(pick(&with_rel, "0.5.1-hotfix.2", false).0, ok("0.5.1"));
        // Порядок в списке не важен — выбирается по версии
        let mut rev = with_rel.clone();
        rev.reverse();
        assert_eq!(pick(&rev, "0.5.0", true).0, ok("0.5.1"));
        // Черновики не смотрим
        let mut draft = gh("v0.6.0", false, true, true);
        draft["draft"] = json!(true);
        assert_eq!(pick(&[draft, gh("v0.5.0", false, true, true)], "0.4.7", true).0, ok("0.5.0"));
    }

    #[test]
    fn release_list_ignores_other_prereleases() {
        let rels = vec![
            gh("v0.6.0-rc.1", true, true, true),
            gh("v0.6.0-beta", false, true, true),
            gh("v0.6.0", true, true, true), // пре-релиз с тегом обычной версии
            gh("v0.5.0", false, true, true),
        ];
        assert_eq!(pick(&rels, "0.5.0", true).0, Err(Skip::NotNewer));
        assert_eq!(pick(&rels, "0.5.0", false).0, Err(Skip::NotNewer));
        assert_eq!(pick(&rels, "0.4.0", true).0, Ok("0.5.0".to_string()));
        // Хотфикс-тег без отметки «пре-релиз» — всё равно хотфикс: только при включённой настройке
        let rels = vec![gh("v0.5.1-hotfix.1", false, true, true), gh("v0.5.0", false, true, true)];
        assert_eq!(pick(&rels, "0.5.0", false), (Err(Skip::NotNewer), Some("v0.5.0".into()), Some("v0.5.0".into())));
        assert_eq!(pick(&rels, "0.5.0", true).0, Ok("0.5.1-hotfix.1".to_string()));
    }

    #[test]
    fn release_list_fallback() {
        let some = |s: &str| Some(s.to_string());
        // Самый новый без сборки для системы — берётся следующий, который можно поставить
        let rels = vec![gh("v0.5.2-hotfix.1", true, false, true), gh("v0.5.1", false, true, true), gh("v0.5.0", false, true, true)];
        assert_eq!(pick(&rels, "0.5.0", true), (Ok("0.5.1".into()), some("v0.5.1"), some("v0.5.1")));
        // Без подписи — тоже
        let rels = vec![gh("v0.5.1-hotfix.2", true, true, false), gh("v0.5.1-hotfix.1", true, true, true), gh("v0.5.0", false, true, true)];
        assert_eq!(pick(&rels, "0.5.0", true).0, Ok("0.5.1-hotfix.1".into()));
        // Поставить нечего — причина самой новой версии, речь о ней
        let rels =
            vec![gh("v0.5.1-hotfix.2", true, true, false), gh("v0.5.1-hotfix.1", true, false, true), gh("v0.5.0", false, true, true)];
        assert_eq!(pick(&rels, "0.5.0", true), (Err(Skip::Unsigned), some("v0.5.1-hotfix.2"), some("v0.5.0")));
        let rels = vec![gh("v0.5.1", false, false, true), gh("v0.5.0", false, true, true)];
        assert_eq!(pick(&rels, "0.5.0", true).0, Err(Skip::NoBuild));
        assert_eq!(pick(&rels, "0.5.0", true).0.unwrap_err().code(), "platform");
        // macOS — сборки нет ни в одном
        let c = choose(&rels, "0.5.0", true, "macos", "aarch64", false);
        assert_eq!(c.plan, Err(Skip::NoBuild));
    }

    #[test]
    fn release_list_bad_tag_and_current() {
        // Релиз с тегом не версией пропускается, если есть релизы с версией
        let rels = vec![gh("nightly", false, true, true), gh("v0.5.0", false, true, true)];
        assert_eq!(pick(&rels, "0.5.0", true), (Err(Skip::NotNewer), Some("v0.5.0".into()), Some("v0.5.0".into())));
        assert_eq!(pick(&rels, "0.4.0", true).0, Ok("0.5.0".into()));
        // Только релиз с кривым тегом — он и «последний», причина BadTag (как раньше с /releases/latest)
        let rels = vec![gh("nightly", false, true, true)];
        assert_eq!(pick(&rels, "0.5.0", true), (Err(Skip::BadTag), Some("nightly".into()), Some("nightly".into())));
        // Текущая версия не разобралась — ничего не ставим
        let rels = vec![gh("v0.5.1", false, true, true)];
        assert_eq!(pick(&rels, "garbage", true).0, Err(Skip::NotNewer));
        assert_eq!(pick(&rels, "0.5.1-rc.1", true).0, Err(Skip::NotNewer));
        // Пустой список
        assert_eq!(pick(&[], "0.5.0", true), (Err(Skip::NotNewer), None, None));
    }

    #[test]
    fn hotfix_setting_and_migration() {
        assert!(hotfixes_enabled(&json!({})));
        assert!(hotfixes_enabled(&json!({ "update": {} })));
        assert!(hotfixes_enabled(&json!({ "update": { "hotfixes": true } })));
        assert!(!hotfixes_enabled(&json!({ "update": { "hotfixes": false } })));
        // 0.5.0: update.drive=false (хотфиксы с Google Диска выключены) — выключено и теперь
        assert!(!hotfixes_enabled(&json!({ "update": { "drive": false } })));
        assert!(hotfixes_enabled(&json!({ "update": { "drive": true } })));
        // Новая настройка важнее старой
        assert!(hotfixes_enabled(&json!({ "update": { "drive": false, "hotfixes": true } })));
        assert!(!hotfixes_enabled(&json!({ "update": { "drive": true, "hotfixes": false } })));
    }

    #[test]
    fn appimage_replaced_in_place() {
        // Имя образа сохраняется (ярлык Steam указывает на него), временный файл — рядом, с «.new»
        let t = Path::new("/home/deck/Applications/FF-Montage-0.4.2-linux-x86_64.AppImage");
        assert_eq!(appimage_next(t), Path::new("/home/deck/Applications/FF-Montage-0.4.2-linux-x86_64.AppImage.new"));
        // Переименованный пользователем образ (без расширения, с точками в имени)
        assert_eq!(appimage_next(Path::new("/opt/ff-montage")), Path::new("/opt/ff-montage.new"));
        assert_eq!(appimage_next(Path::new("/opt/FF.Montage.v1")), Path::new("/opt/FF.Montage.v1.new"));
        // Из AppImage обновление берёт именно AppImage-ассет
        assert_eq!(asset_name("0.4.2", "linux", "x86_64", true).unwrap(), "FF-Montage-0.4.2-linux-x86_64.AppImage");
    }

    #[cfg(unix)]
    #[test]
    fn appimage_swap_keeps_old_inode_readable() {
        // Подмена переименованием: открытый (смонтированный) старый файл остаётся читаемым, по пути — уже новый,
        // исполняемый; временного .new не остаётся
        use std::io::Read;
        use std::os::unix::fs::PermissionsExt;
        let dir = paths::test_dir("appimage-swap");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("FF-Montage-0.4.1-linux-x86_64.AppImage");
        let download = dir.join("download.AppImage");
        std::fs::write(&target, b"old").unwrap();
        std::fs::write(&download, b"new").unwrap();
        let mut running = std::fs::File::open(&target).unwrap();
        swap_appimage(&download, &target).unwrap();
        let mut s = String::new();
        running.read_to_string(&mut s).unwrap();
        assert_eq!(s, "old");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o755);
        assert!(!appimage_next(&target).exists());
        // Ошибка (нет скачанного файла) — старый образ на месте
        assert!(swap_appimage(&dir.join("nope"), &target).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&dir);
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
