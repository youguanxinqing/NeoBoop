// Thin Tauri shell. NeoBoop's logic lives in the webview frontend; Rust only
// hosts the window and exposes the one capability the web layer can't do
// itself: reading a user-chosen folder of .js scripts off disk.

use std::fs;
use std::str::FromStr;

use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

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

/// Bring the main window to the front (even if hidden/minimized) and tell the
/// frontend to open a fresh boop. This is what the global "quick capture"
/// shortcut does — summon NeoBoop from any app and start typing immediately.
fn summon_new_boop<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = app.emit("new-boop", ());
}

/// (Re)binds the global quick-capture shortcut to `accelerator` (Tauri syntax,
/// e.g. "Control+Alt+Space"). Called from the frontend on launch with the saved
/// value, and again whenever the user records a new chord in Preferences. Any
/// previous binding is cleared first. Returns an error string the UI can show
/// when the accelerator is unparseable or already claimed by the system.
#[tauri::command]
fn set_global_shortcut<R: Runtime>(app: AppHandle<R>, accelerator: String) -> Result<(), String> {
    let shortcut = Shortcut::from_str(&accelerator).map_err(|e| e.to_string())?;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.register(shortcut).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Global shortcut: one handler fires for whichever chord is currently
        // registered (we only ever keep one — the quick-capture binding).
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        summon_new_boop(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![read_scripts, set_global_shortcut])
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
            // View submenu carries the split commands; selecting one emits an
            // event the frontend turns into a SplitTree mutation. Directional
            // wording ("Split Right/Down") dodges the vertical/horizontal trap.
            // Ctrl+S = 竖屏 (side-by-side, vertical divider); Ctrl+V = 横屏
            // (stacked, horizontal divider) — the user's chosen mnemonics.
            let split_right = MenuItemBuilder::with_id("split-right", "Split Right")
                .accelerator("Control+S")
                .build(handle)?;
            let split_down = MenuItemBuilder::with_id("split-down", "Split Down")
                .accelerator("Control+V")
                .build(handle)?;
            // Ctrl+X closes the focused pane but keeps its tab (parked, still
            // in the tab bar). Closing a tab outright is ⌘W (macOS standard).
            let close_pane = MenuItemBuilder::with_id("close-pane", "Close Pane")
                .accelerator("Control+X")
                .build(handle)?;
            let view_menu = SubmenuBuilder::new(handle, "View")
                .item(&split_right)
                .item(&split_down)
                .separator()
                .item(&close_pane)
                .build()?;
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .minimize()
                .separator()
                .close_window()
                .build()?;
            MenuBuilder::new(handle)
                .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
                .build()
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => {
                let _ = app.emit("open-settings", ());
            }
            "split-right" => {
                let _ = app.emit("split-right", ());
            }
            "split-down" => {
                let _ = app.emit("split-down", ());
            }
            "close-pane" => {
                let _ = app.emit("close-pane", ());
            }
            _ => {}
        })
        // Standard macOS behaviour: the red close button (and "Close Window")
        // only hides the main window — the app stays alive so the global
        // shortcut keeps working. Quitting is reserved for Cmd+Q / the Quit
        // menu, which terminate the process directly without a CloseRequested.
        // The preferences window is transient and closes normally.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building NeoBoop")
        // Re-show the hidden window when its Dock icon is clicked (macOS), so a
        // window that was "closed" to the background is recoverable without the
        // shortcut.
        .run(|app, event| {
            if let RunEvent::Reopen { .. } = event {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        });
}
