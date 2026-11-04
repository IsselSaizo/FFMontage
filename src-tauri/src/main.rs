// FF Montage — видеоредактор с FFmpeg под капотом (Tauri 2).
//   ff-montage                 — программа
//   ff-montage --mcp           — MCP-сервер для ИИ-ассистента (stdio)
//   ff-montage --engine <cmd>  — движок без окна (автотесты)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod cli;
mod commands;
mod control;
mod export;
mod ff;
mod i18n;
mod mcp;
mod paths;
mod procs;
mod protocol;
mod selftest;
mod update;
mod windows;


fn main() {
    // Падение — в журнал <кэш>/app/logs/panic.log (у окна нет консоли)
    std::panic::set_hook(Box::new(|info| {
        let bt = std::backtrace::Backtrace::force_capture();
        let msg = format!("{info}\n{bt}\n");
        eprintln!("{msg}");
        let p = paths::get();
        let _ = std::fs::create_dir_all(&p.logs);
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p.logs.join("panic.log")) {
            let _ = writeln!(f, "--- {:?}\n{msg}", std::time::SystemTime::now());
        }
    }));
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--mcp") {
        mcp::main();
        return;
    }
    if let Some(i) = args.iter().position(|a| a == "--engine") {
        cli::main(args.get(i + 1).map(String::as_str).unwrap_or(""));
        return;
    }
    run();
}

fn run() {
    if std::env::var_os("FFM_RELAUNCH").is_some() {
        std::env::remove_var("FFM_RELAUNCH");
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }
    update::cleanup_old();
    let p = paths::get();
    paths::ensure_dirs();
    i18n::set(&windows::boot_lang().0);
    std::thread::spawn(|| procs::sweep_leftovers(&paths::get().media_cache));
    // Временная папка окна первой настройки больше не нужна
    if !p.first_run {
        let _ = std::fs::remove_dir_all(&p.firstrun_dir);
    }
    // Временные файлы FFmpeg и WebView — в кэш программы
    std::env::set_var("TEMP", &p.temp);
    std::env::set_var("TMP", &p.temp);
    std::env::set_var("TMPDIR", &p.temp);

    // Одна копия программы на папку кэша
    if !p.first_run && control::focus_existing() {
        return;
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("media", |_ctx, req, responder| {
            std::thread::spawn(move || responder.respond(protocol::handle(&req)));
        })
        .on_page_load(windows::on_page_load)
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::setup_info,
            commands::setup_pick_folder,
            commands::setup_check_ffmpeg,
            commands::setup_encoders,
            commands::setup_save,
            commands::setup_open,
            commands::setup_cancel,
            commands::app_restart,
            commands::settings_get,
            commands::settings_set,
            commands::cache_stats,
            commands::cache_clear,
            commands::media_pick,
            commands::media_probe,
            commands::media_thumbs,
            commands::media_peaks,
            commands::media_audio_stream,
            commands::media_proxy,
            commands::enc_detect,
            commands::fx_reverse,
            commands::fx_freeze,
            commands::fx_frame,
            commands::fx_silence,
            commands::export_pick,
            commands::export_default_path,
            commands::export_start,
            commands::export_cancel,
            commands::project_save,
            commands::project_open,
            commands::project_read,
            commands::autosave_write,
            commands::autosave_read,
            commands::shell_show,
            commands::shell_open,
            commands::win_devtools,
            commands::win_title,
            commands::fs_exists,
            commands::mcp_info,
            commands::mcp_result,
            commands::log_line,
            selftest::test_done,
            selftest::test_shot,
            update::update_check,
            update::update_apply,
        ])
        .setup(|app| {
            let h = app.handle().clone();
            if paths::get().first_run {
                windows::open_setup(&h);
            } else {
                let _ = std::fs::create_dir_all(&paths::get().output_dir);
                windows::open_main(&h);
                tauri::async_runtime::spawn(async { ff::detect_encoders(&ff::find()).await; });
                // Канал управления для ИИ-ассистента (MCP): только локально, с секретным ключом в папке кэша
                control::start(h);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect(tr!("FF Montage: не удалось запустить окно", "FF Montage: cannot start the window"));

    app.run(|_app, event| {
        if let tauri::RunEvent::Exit = event {
            export::cancel();
            procs::kill_all();
            control::stop();
        }
    });
}
