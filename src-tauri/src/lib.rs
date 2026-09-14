mod data_paths;
mod debug_timing;
mod logging;
mod process;
mod serial;
mod storage;

use data_paths::AppDataPaths;
use debug_timing::DebugTimer;
use process::ProcessRegistry;
use serial::SerialRegistry;
use storage::PersistentStore;
use tauri::{Manager, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _run_timer = DebugTimer::start("app_run");
    let mut context = tauri::generate_context!();
    let window_configs = context.config().app.windows.clone();
    // Resolve storage before creating a WebView so portable launches never open
    // an installed profile or write to its browser data directory.
    for window in &mut context.config_mut().app.windows {
        window.create = false;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(move |app| {
            let _setup_timer = DebugTimer::start("app_setup");
            let initialize = || -> Result<(), String> {
                let paths = AppDataPaths::resolve(app.handle())?;
                let store = PersistentStore::open(&paths.data_directory)?;
                app.manage(store);
                app.manage(paths.clone());
                for config in window_configs.iter().filter(|config| config.create) {
                    let mut window = WebviewWindowBuilder::from_config(app, config)
                        .map_err(|error| format!("无法配置应用窗口：{error}"))?;
                    if paths.portable {
                        #[cfg(target_os = "macos")]
                        {
                            // WKWebView cannot relocate its persistent data store.
                            // Settings are restored from SQLite before React starts.
                            window = window.incognito(true);
                        }
                        #[cfg(not(target_os = "macos"))]
                        {
                            window = window.data_directory(paths.data_directory.join("webview"));
                        }
                    }
                    window
                        .build()
                        .map_err(|error| format!("无法创建应用窗口：{error}"))?;
                }
                Ok(())
            };
            if let Err(error) = initialize() {
                eprintln!("iTerm startup failed: {error}");
                let handle = app.handle().clone();
                app.dialog()
                    .message(error)
                    .title("iTerm 启动失败 / Startup failed")
                    .kind(MessageDialogKind::Error)
                    .show(move |_| handle.exit(1));
            }
            Ok(())
        })
        .manage(SerialRegistry::default())
        .manage(ProcessRegistry::default())
        .invoke_handler(tauri::generate_handler![
            logging::open_log_directory,
            logging::open_log_file,
            process::open_ssh_session,
            process::list_external_tools,
            process::list_ssh_config_hosts,
            process::list_adb_devices,
            process::open_adb_session,
            process::close_process_session,
            process::resize_process_session,
            process::write_process_bytes,
            process::start_process_log,
            process::set_process_log_paused,
            process::stop_process_log,
            serial::list_serial_ports,
            serial::open_serial_session,
            serial::close_serial_session,
            serial::write_serial_text,
            serial::write_serial_text_many,
            serial::write_serial_bytes,
            serial::set_serial_signal,
            serial::send_serial_break,
            serial::clear_serial_buffers,
            serial::start_serial_log,
            serial::set_serial_log_paused,
            serial::stop_serial_log,
            storage::load_persistent_items,
            storage::save_persistent_items,
            storage::remove_persistent_item,
            storage::clear_persistent_items,
        ])
        .run(context)
        .expect("failed to run iTerm");
}
