use tauri::{WebviewUrl, WebviewWindowBuilder};

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
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let window_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title(WINDOW_TITLE)
                .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
                .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT);

            #[cfg(target_os = "macos")]
            let window_builder = window_builder
                .hidden_title(true)
                .title_bar_style(TitleBarStyle::Transparent);

            #[cfg(not(target_os = "macos"))]
            let window_builder = window_builder.decorations(false);

            #[cfg(target_os = "macos")]
            let window = window_builder.build()?;

            #[cfg(not(target_os = "macos"))]
            let _window = window_builder.build()?;

            #[cfg(target_os = "macos")]
            {
                use cocoa::appkit::{NSColor, NSWindow};
                use cocoa::base::{id, nil};

                let ns_window = window.ns_window().unwrap() as id;

                unsafe {
                    let bg_color = NSColor::colorWithRed_green_blue_alpha_(
                        nil,
                        244.0 / 255.0,
                        247.0 / 255.0,
                        250.0 / 255.0,
                        1.0,
                    );
                    ns_window.setBackgroundColor_(bg_color);
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
