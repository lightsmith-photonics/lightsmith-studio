// The desktop shell is deliberately thin: the whole app is the web build in
// ../dist. Rust only adds native file dialogs / file access and the
// `lightsmith-studio://` deep-link scheme (forwarded to the running window).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // A second launch (e.g. clicking an lightsmith-studio:// link) hands its URL to the
    // running instance, where the deep-link plugin's onOpenUrl fires.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|_app| {
            // Installers register the scheme; this also registers it for dev / portable runs.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                _app.deep_link().register_all()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Lightsmith Studio");
}
