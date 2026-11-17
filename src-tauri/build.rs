use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn main() {
    bundled_plugins();
    tauri_build::build()
}

/// Встроенные плагины: ../plugins-bundled/<id>/… (папка с plugin.json) → $OUT_DIR/bundled_plugins.rs
/// со списком `BUNDLED: &[(id, &[(относительный путь через «/», include_bytes!)])]` (src/bundled.rs).
/// Скрытые файлы и папки («.» в начале) пропускаются; порядок — по имени (сборка воспроизводима).
fn bundled_plugins() {
    let root = Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("..").join("plugins-bundled");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut code = String::from("pub static BUNDLED: &[(&str, &[(&str, &[u8])])] = &[\n");
    for dir in sorted(&root) {
        if !dir.is_dir() || !dir.join("plugin.json").is_file() {
            continue;
        }
        let id = dir.file_name().unwrap().to_string_lossy().to_string();
        let mut files = vec![];
        walk(&dir, "", &mut files);
        writeln!(code, "    ({id:?}, &[").unwrap();
        for (rel, file) in files {
            println!("cargo:rerun-if-changed={}", file.display());
            writeln!(code, "        ({rel:?}, include_bytes!({:?})),", file.to_string_lossy()).unwrap();
        }
        code.push_str("    ]),\n");
    }
    code.push_str("];\n");
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("bundled_plugins.rs");
    std::fs::write(out, code).unwrap();
}

fn sorted(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().filter(|e| !e.file_name().to_string_lossy().starts_with('.')).map(|e| e.path()).collect())
        .unwrap_or_default();
    v.sort();
    v
}

fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) {
    for p in sorted(dir) {
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        if p.is_dir() {
            println!("cargo:rerun-if-changed={}", p.display());
            walk(&p, &rel, out);
        } else if p.is_file() {
            out.push((rel, p));
        }
    }
}
