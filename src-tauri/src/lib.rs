use tauri::{webview::PageLoadEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags, WindowExt};

#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

const WINDOW_TITLE: &str = "JiraSync Hub";
const WINDOW_WIDTH: f64 = 1280.0;
const WINDOW_HEIGHT: f64 = 800.0;
const MIN_WINDOW_WIDTH: f64 = 1200.0;
const MIN_WINDOW_HEIGHT: f64 = 800.0;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(WindowStateBuilder::default().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let window_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title(WINDOW_TITLE)
                .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
                .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
                .visible(false)
                .on_page_load(|webview, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        let _ = webview.show();
                    }
                });

            #[cfg(target_os = "macos")]
            let window_builder = window_builder
                .hidden_title(true)
                .title_bar_style(TitleBarStyle::Transparent);

            #[cfg(not(target_os = "macos"))]
            let window_builder = window_builder.decorations(false);

            let window = window_builder.build()?;

            // Restore saved window size + position (falls back to defaults on first launch)
            window.restore_state(StateFlags::all())?;

            #[cfg(target_os = "macos")]
            {
                use objc2_app_kit::{NSColor, NSWindow};

                unsafe {
                    let ns_window = &*(window.ns_window().unwrap() as *mut NSWindow);
                    let bg_color = NSColor::colorWithRed_green_blue_alpha(
                        244.0 / 255.0,
                        247.0 / 255.0,
                        250.0 / 255.0,
                        1.0,
                    );
                    ns_window.setBackgroundColor(Some(&*bg_color));
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
