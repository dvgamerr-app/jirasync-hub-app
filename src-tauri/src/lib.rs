use tauri::{webview::PageLoadEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags, WindowExt};

fn derive_key() -> Result<[u8; 32], String> {
    use sha2::{Digest, Sha256};
    let machine_id = machine_uid::get().map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(machine_id.as_bytes());
    hasher.update(b"jirasync-hub-v1");
    Ok(hasher.finalize().into())
}

#[tauri::command]
fn encrypt_data(plaintext: String) -> Result<String, String> {
    use aes_gcm::{
        aead::{Aead, Generate, KeyInit},
        Aes256Gcm, Key,
    };
    use base64::{engine::general_purpose::STANDARD, Engine};

    let key_bytes = derive_key()?;
    let key = Key::<Aes256Gcm>::from(key_bytes);
    let cipher = Aes256Gcm::new(&key);
    let nonce = aes_gcm::aead::Nonce::<Aes256Gcm>::generate();
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| e.to_string())?;

    let mut payload = nonce.to_vec();
    payload.extend_from_slice(&ciphertext);
    Ok(STANDARD.encode(&payload))
}

#[tauri::command]
fn decrypt_data(ciphertext: String) -> Result<String, String> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Key, Nonce,
    };
    use base64::{engine::general_purpose::STANDARD, Engine};

    let data = STANDARD.decode(&ciphertext).map_err(|e| e.to_string())?;
    if data.len() < 12 {
        return Err("invalid ciphertext".into());
    }

    let key_bytes = derive_key()?;
    let key = Key::<Aes256Gcm>::from(key_bytes);
    let cipher = Aes256Gcm::new(&key);
    let nonce = Nonce::try_from(&data[..12]).map_err(|e| e.to_string())?;
    let plaintext = cipher
        .decrypt(&nonce, &data[12..])
        .map_err(|e| e.to_string())?;

    String::from_utf8(plaintext).map_err(|e| e.to_string())
}

// ── OS credential store (Windows Credential Manager / macOS Keychain) ───────────────────────
// Jira API tokens live here instead of in localStorage. On platforms without a supported store
// every command returns an error and the frontend falls back to its previous storage.
const KEYRING_SERVICE: &str = "com.scg.wedo.jirasync-hub";

#[cfg(any(windows, target_os = "macos"))]
fn secret_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("jira-token:{account}")).map_err(|e| e.to_string())
}

#[tauri::command]
fn store_secret(account: String, secret: String) -> Result<(), String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        secret_entry(&account)?
            .set_password(&secret)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (account, secret, KEYRING_SERVICE);
        Err("OS keychain is not supported on this platform".into())
    }
}

#[tauri::command]
fn get_secret(account: String) -> Result<Option<String>, String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        match secret_entry(&account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = account;
        Err("OS keychain is not supported on this platform".into())
    }
}

#[tauri::command]
fn delete_secret(account: String) -> Result<(), String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        match secret_entry(&account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = account;
        Err("OS keychain is not supported on this platform".into())
    }
}

#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

#[cfg(target_os = "macos")]
#[tauri::command]
fn set_window_theme(window: tauri::WebviewWindow, is_dark: bool) {
    use objc2_app_kit::{NSColor, NSWindow};
    unsafe {
        let ns_window = &*(window.ns_window().unwrap() as *mut NSWindow);
        let bg_color = if is_dark {
            // dark --background: hsl(222, 25%, 8%) ≈ rgb(15, 18, 26)
            NSColor::colorWithRed_green_blue_alpha(
                15.0 / 255.0,
                18.0 / 255.0,
                26.0 / 255.0,
                1.0,
            )
        } else {
            // light --background: hsl(220, 20%, 97%) ≈ rgb(244, 247, 250)
            NSColor::colorWithRed_green_blue_alpha(
                244.0 / 255.0,
                247.0 / 255.0,
                250.0 / 255.0,
                1.0,
            )
        };
        ns_window.setBackgroundColor(Some(&*bg_color));
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn set_window_theme(_window: tauri::WebviewWindow, _is_dark: bool) {}

const WINDOW_TITLE: &str = "JiraSync Hub";
const WINDOW_WIDTH: f64 = 1280.0;
const WINDOW_HEIGHT: f64 = 800.0;
// Small enough for a 1366x768 laptop (or a 1920x1080 screen scaled to 150%) so the window
// never has to be taller than the screen.
const MIN_WINDOW_WIDTH: f64 = 1000.0;
const MIN_WINDOW_HEIGHT: f64 = 600.0;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(WindowStateBuilder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            set_window_theme,
            encrypt_data,
            decrypt_data,
            store_secret,
            get_secret,
            delete_secret
        ])
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
