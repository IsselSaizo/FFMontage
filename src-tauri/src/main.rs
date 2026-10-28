// FF Montage вЂ” РІРёРґРµРѕСЂРµРґР°РєС‚РѕСЂ СЃ FFmpeg РїРѕРґ РєР°РїРѕС‚РѕРј (Tauri 2).
//   ff-montage                 вЂ” РїСЂРѕРіСЂР°РјРјР°
//   ff-montage --mcp           вЂ” MCP-СЃРµСЂРІРµСЂ РґР»СЏ РР-Р°СЃСЃРёСЃС‚РµРЅС‚Р° (stdio)
//   ff-montage --engine <cmd>  вЂ” РґРІРёР¶РѕРє Р±РµР· РѕРєРЅР° (Р°РІС‚РѕС‚РµСЃС‚С‹)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
mod commands;
mod control;
mod export;
mod ff;
mod mcp;
mod paths;
mod protocol;
mod selftest;
mod update;
mod windows;


fn main() {
    // РџР°РґРµРЅРёРµ вЂ” РІ Р¶СѓСЂРЅР°Р» <РєСЌС€>/app/logs/panic.log (Сѓ РѕРєРЅР° РЅРµС‚ РєРѕРЅСЃРѕР»Рё)
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
    // Р’СЂРµРјРµРЅРЅР°СЏ РїР°РїРєР° РѕРєРЅР° РїРµСЂРІРѕР№ РЅР°СЃС‚СЂРѕР№РєРё Р±РѕР»СЊС€Рµ РЅРµ РЅСѓР¶РЅР°
    if !p.first_run {
        let _ = std::fs::remove_dir_all(&p.firstrun_dir);
    }
    // Р’СЂРµРјРµРЅРЅС‹Рµ С„Р°Р№Р»С‹ FFmpeg Рё WebView вЂ” РІ РєСЌС€ РїСЂРѕРіСЂР°РјРјС‹
    std::env::set_var("TEMP", &p.temp);
    std::env::set_var("TMP", &p.temp);
    std::env::set_var("TMPDIR", &p.temp);

    // РћРґРЅР° РєРѕРїРёСЏ РїСЂРѕРіСЂР°РјРјС‹ РЅР° РїР°РїРєСѓ РєСЌС€Р°
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
                // РљР°РЅР°Р» СѓРїСЂР°РІР»РµРЅРёСЏ РґР»СЏ РР-Р°СЃСЃРёСЃС‚РµРЅС‚Р° (MCP): С‚РѕР»СЊРєРѕ Р»РѕРєР°Р»СЊРЅРѕ, СЃ СЃРµРєСЂРµС‚РЅС‹Рј РєР»СЋС‡РѕРј РІ РїР°РїРєРµ РєСЌС€Р°
                control::start(h);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("FF Montage: РЅРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РїСѓСЃС‚РёС‚СЊ РѕРєРЅРѕ");

    app.run(|_app, event| {
        if let tauri::RunEvent::Exit = event {
            export::cancel();
            control::stop();
        }
    });
}
