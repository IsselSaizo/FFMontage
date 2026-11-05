// FF Montage — видеоредактор с FFmpeg под капотом (Tauri 2).
//   ff-montage                 — программа
//   ff-montage --mcp           — MCP-сервер для ИИ-ассистента (stdio)
//   ff-montage --engine <cmd>  — движок без окна (автотесты)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Clippy 0.1.99+ стал считать «слишком сложными» типы вида Arc<Mutex<HashMap<…, Vec<…>>>> (control.rs, ff.rs, fonts.rs,
// protocol.rs) — это не ошибка, а вкус; без allow CI упадёт, как только раннер получит новый stable
#![allow(clippy::type_complexity)]

mod assets;
mod cache;
mod cli;
mod commands;
mod control;
mod crashlog;
mod export;
mod ff;
mod fonts;
mod i18n;
mod mcp;
mod paths;
mod plancheck;
mod plugins;
mod procs;
mod protocol;
mod queue;
mod selftest;
mod settings;
mod update;
mod vst;
mod windows;

fn main() {
    // Падение — в журнал <кэш>/app/logs/panic.log и отчёт logs/reports/*-panic.txt (у окна нет консоли).
    // Хост аудиоплагинов — отдельно: падение стороннего плагина ожидаемо и изолировано, «программа упала» не показываем
    let args: Vec<String> = std::env::args().collect();
    crashlog::install(args.get(1).map(String::as_str) == Some("--vst-host"));
    // Процесс-хост аудиоплагинов VST3/CLAP (vst/host.rs) — до всего остального: только плагин и stdin/stdout
    if args.get(1).map(String::as_str) == Some("--vst-host") {
        #[cfg(windows)]
        vst::host::main(&args[2..]);
        #[cfg(not(windows))]
        std::process::exit(2);
    }
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
    // Linux: <video>/<audio> WebKitGTK (GStreamer) не открывают media:// — медиа идут по HTTP на 127.0.0.1 (protocol.rs)
    #[cfg(target_os = "linux")]
    {
        if protocol::http_start().is_none() {
            eprintln!("media http: cannot listen on 127.0.0.1");
        }
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("media", |_ctx, req, responder| {
            protocol::spawn(move || responder.respond(protocol::handle(&req)));
        })
        // Файлы плагинов для песочных iframe: http://plugin.localhost/<id>/… (Windows), plugin://localhost/<id>/…
        .register_asynchronous_uri_scheme_protocol("plugin", |_ctx, req, responder| {
            protocol::spawn(move || responder.respond(plugins::handle(&req)));
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
            commands::cache_autoclean,
            commands::settings_migrate_local,
            commands::paths_info,
            commands::media_pick,
            commands::media_probe,
            commands::media_thumbs,
            commands::media_peaks,
            commands::media_audio_stream,
            commands::media_proxy,
            commands::enc_detect,
            ff::enc_reset,
            commands::fx_reverse,
            commands::fx_freeze,
            commands::fx_frame,
            commands::fx_silence,
            commands::export_pick,
            commands::export_default_path,
            commands::export_start,
            commands::export_cancel,
            commands::export_loudness,
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
            commands::crash_report,
            commands::crash_reports,
            selftest::test_done,
            selftest::test_shot,
            update::update_check,
            update::update_apply,
            plugins::plugins_list,
            plugins::plugins_pick,
            plugins::plugins_install,
            plugins::plugins_install_github,
            plugins::plugins_remove,
            plugins::plugins_open_dir,
            plugins::plugin_storage_get,
            plugins::plugin_storage_set,
            plugins::plugin_net_fetch,
            fonts::fonts_list,
            fonts::fonts_add,
            fonts::fonts_remove,
            fonts::fonts_open_dir,
            fonts::fonts_export_dir,
            assets::export_asset_save,
            assets::subtitle_file_read,
            assets::subtitle_file_write,
            vst::vst_supported,
            vst::vst_list,
            vst::vst_scan,
            vst::vst_folders_set,
            vst::vst_pick_folder,
            vst::vst_install,
            vst::vst_info,
            vst::vst_render,
            vst::vst_editor_open,
            vst::vst_editor_cmd,
        ])
        .setup(|app| {
            let h = app.handle().clone();
            if paths::get().first_run {
                windows::open_setup(&h);
            } else {
                let _ = std::fs::create_dir_all(&paths::get().output_dir);
                windows::open_main(&h);
                // Признак «программа работает»: остался с прошлого раза — отчёт unclean-exit (журнал прошлого запуска)
                crashlog::session_start(&paths::get().logs.join("renderer.prev.log"));
                tauri::async_runtime::spawn(async {
                    ff::detect_encoders(&ff::find()).await;
                });
                // Канал управления для ИИ-ассистента (MCP): только локально, с секретным ключом в папке кэша
                control::start(h);
                // Кэш: сироты, .part и автоочистка до лимита — уже после проверки «одна копия на папку кэша»
                std::thread::spawn(cache::startup);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect(tr!("FF Montage: не удалось запустить окно", "FF Montage: cannot start the window"));

    app.run(|app, event| match event {
        // Главное окно закрыто (✕ в окне → win.close(), Alt+F4, WM_CLOSE) — выходим, даже если осталось что-то ещё
        tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } if label == "main" => {
            arm_exit_watchdog();
            app.exit(0);
        }
        tauri::RunEvent::ExitRequested { .. } => arm_exit_watchdog(),
        tauri::RunEvent::Exit => {
            arm_exit_watchdog();
            export::cancel();
            vst::close_all();
            procs::kill_all();
            control::stop();
            crashlog::session_end();
        }
        _ => {}
    });
}

/// Выход начался: если за 5 с процесс не завершился сам (завис WebView, поток, выгрузка DLL…) — завершить его жёстко,
/// иначе exe остаётся занятым и его нельзя заменить. Процессы FFmpeg умрут вместе с ним (Job Object, procs.rs).
fn arm_exit_watchdog() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static ARMED: AtomicBool = AtomicBool::new(false);
    if ARMED.swap(true, Ordering::SeqCst) {
        return;
    }
    // Выход начался по воле пользователя: зависание при закрытии (или жёсткое завершение ниже) — не «падение»
    crashlog::session_end();
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(5));
        let _ = std::fs::OpenOptions::new().create(true).append(true).open(paths::get().logs.join("renderer.log")).and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "[exit] watchdog: процесс не завершился за 5 с — завершаю принудительно")
        }); // i18n-ignore — служебный журнал
        hard_exit(0);
    });
}

#[cfg(windows)]
fn hard_exit(code: u32) -> ! {
    use ::windows::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};
    unsafe {
        let _ = TerminateProcess(GetCurrentProcess(), code);
    }
    std::process::exit(code as i32)
}

#[cfg(unix)]
fn hard_exit(code: u32) -> ! {
    unsafe { libc::_exit(code as i32) }
}
