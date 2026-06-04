// Thin Tauri shell. NeoBoop's logic lives in the webview frontend; Rust only
// hosts the window and exposes the one capability the web layer can't do
// itself: reading a user-chosen folder of .js scripts off disk.

use std::fs;

use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::Emitter;

#[derive(serde::Serialize)]
struct ScriptFile {
    name: String,
    source: String,
}

/// Reads all top-level `*.js` files in `dir`, returning name (without extension)
/// and source. Used to load a user's custom script folder. std::fs keeps this
/// free of the fs-plugin path-scoping ceremony.
#[tauri::command]
fn read_scripts(dir: String) -> Result<Vec<ScriptFile>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("js") {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        if let Ok(source) = fs::read_to_string(&path) {
            out.push(ScriptFile { name, source });
        }
    }
    Ok(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_scripts])
        // Native menu bar. The app submenu carries a standard "Settings…" (⌘,)
        // item; selecting it emits "open-settings", which the frontend handles
        // by opening the Preferences window. The Edit submenu restores the
        // standard text shortcuts (undo/cut/copy/paste/…) for the editor.
        .menu(|handle| {
            let settings = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(handle)?;
            let app_menu = SubmenuBuilder::new(handle, "NeoBoop")
                .about(Some(AboutMetadata::default()))
                .separator()
                .item(&settings)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .minimize()
                .separator()
                .close_window()
                .build()?;
            MenuBuilder::new(handle)
                .items(&[&app_menu, &edit_menu, &window_menu])
                .build()
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "settings" {
                let _ = app.emit("open-settings", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running NeoBoop");
}
