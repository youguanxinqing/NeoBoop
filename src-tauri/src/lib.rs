// Thin Tauri shell. NeoBoop's logic lives in the webview frontend; Rust only
// hosts the window and exposes the one capability the web layer can't do
// itself: reading a user-chosen folder of .js scripts off disk.

use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::str::FromStr;
use std::sync::Mutex;

use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(serde::Serialize)]
struct ScriptFile {
    name: String,
    source: String,
}

/// A text file loaded from disk — opened from Finder, dropped on the icon, or
/// reopened on session restore. Content is always normalised to LF for the
/// editor; `eol`/`final_newline` record the original shape so a later save
/// writes it back unchanged rather than silently rewriting line endings.
///
/// `read_only` is set when the bytes aren't valid UTF-8 (we still show them,
/// decoded lossily, but must not write the mangled result back) or the file
/// isn't writable. The frontend disables ⌘S for read-only docs.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TextFile {
    path: String,
    name: String,
    content: String,
    encoding_ok: bool,
    read_only: bool,
    eol: String,
    final_newline: bool,
}

/// Files the OS handed us via `RunEvent::Opened` but the webview hasn't picked
/// up yet. This is the single source of truth: a cold launch drains it once the
/// frontend boots, and a warm open drains it in response to the "open-files"
/// nudge — `take_opened_files` empties it atomically, so neither path can
/// deliver the same file twice.
#[derive(Default)]
struct PendingOpens(Mutex<Vec<TextFile>>);

/// Cap on what we'll slurp into the editor. NeoBoop is a text scratchpad; this
/// keeps a fat-fingered "Open With" on a multi-gigabyte binary from wedging the
/// webview.
const MAX_OPEN_BYTES: u64 = 16 * 1024 * 1024;

/// Read a path into a `TextFile`, or `None` if it isn't a regular file, is too
/// big, or can't be read. Detects CRLF vs LF and a trailing newline, then hands
/// back LF-normalised content; `encoding_ok` is false when we had to decode
/// lossily, which forces the doc read-only so a save can't corrupt the original.
fn read_text_file_at(path: &Path) -> Option<TextFile> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_OPEN_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let (content_raw, encoding_ok) = match String::from_utf8(bytes) {
        Ok(s) => (s, true),
        Err(e) => (String::from_utf8_lossy(e.as_bytes()).into_owned(), false),
    };
    let eol = if content_raw.contains("\r\n") { "crlf" } else { "lf" };
    let final_newline = content_raw.ends_with('\n');
    // Normalise to LF for CodeMirror; lone CRs collapse too so mixed files don't
    // confuse the editor. The original `eol` is what we restore on save.
    let content = content_raw.replace("\r\n", "\n").replace('\r', "\n");
    let read_only = !encoding_ok || meta.permissions().readonly();
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();
    Some(TextFile {
        path: path.to_string_lossy().into_owned(),
        name,
        content,
        encoding_ok,
        read_only,
        eol: eol.to_string(),
        final_newline,
    })
}

/// Drain and return any files the OS asked us to open. Called by the frontend
/// on boot (cold launch) and whenever the "open-files" event fires (warm open).
#[tauri::command]
fn take_opened_files(state: State<PendingOpens>) -> Vec<TextFile> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// Read a real file by absolute path (Save-target reopen / session restore).
#[tauri::command]
fn read_text_file(path: String) -> Result<TextFile, String> {
    read_text_file_at(Path::new(&path)).ok_or_else(|| format!("cannot read {path}"))
}

/// Write `content` (LF-joined, as the editor holds it) to `path`, restoring the
/// document's original line-ending style and trailing-newline so saving an
/// untouched-elsewhere file is a byte-for-byte no-op on those axes.
#[tauri::command]
fn write_text_file(
    path: String,
    content: String,
    eol: String,
    final_newline: bool,
) -> Result<(), String> {
    let nl = if eol == "crlf" { "\r\n" } else { "\n" };
    let mut body = if nl == "\n" {
        content
    } else {
        content.replace('\n', nl)
    };
    if final_newline && !body.ends_with(nl) {
        body.push_str(nl);
    }
    fs::write(&path, body).map_err(|e| e.to_string())
}

/// Rename a real file on disk (tab rename). Same-directory move only is enforced
/// by the caller; here we just refuse to clobber an existing target so a careless
/// rename can't silently destroy another file.
#[tauri::command]
fn rename_file(from: String, to: String) -> Result<(), String> {
    let to_path = Path::new(&to);
    if to_path.exists() {
        let name = to_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| to.clone());
        return Err(format!("“{name}” already exists"));
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Resolve `rel` under the app-data dir, refusing any traversal out of it. This
/// is the sandbox for NeoBoop's own bookkeeping — the scratch store, its
/// manifest, and the session file all live here, never user-visible paths.
fn app_data_path<R: Runtime>(app: &AppHandle<R>, rel: &str) -> Result<PathBuf, String> {
    if rel.contains("..") {
        return Err("invalid path".into());
    }
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join(rel))
}

/// Read a file under the app-data dir; `None` (not an error) when it's absent,
/// so first-run reads of the manifest/session just come back empty.
#[tauri::command]
fn app_data_read<R: Runtime>(app: AppHandle<R>, rel: String) -> Result<Option<String>, String> {
    let path = app_data_path(&app, &rel)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Write a file under the app-data dir, creating parent dirs as needed. Backs
/// the scratch store (`scratch/<id>.txt`), its `manifest.json`, and `session.json`.
#[tauri::command]
fn app_data_write<R: Runtime>(app: AppHandle<R>, rel: String, content: String) -> Result<(), String> {
    let path = app_data_path(&app, &rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
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

// ---- `boop` CLI shim -------------------------------------------------------
//
// "Install command in PATH" (VS Code's `code` model) drops a tiny shell shim on
// PATH that forwards to the GUI:
//
//     #!/bin/sh
//     exec /usr/bin/open -a NeoBoop "$@"
//
// `open -a NeoBoop file` is the native macOS launch-or-forward: it starts the
// app if needed and otherwise sends the file to the running instance as an
// `odoc` Apple Event — exactly what `RunEvent::Opened` already handles (new
// tab, or focus an already-open file). Resolving the app by NAME keeps the shim
// valid wherever NeoBoop.app lives, so app moves/updates don't break it.

/// Standard install location — almost always on PATH (Homebrew owns it on most
/// dev Macs, so the write often needs no elevation).
const CLI_DIR: &str = "/usr/local/bin";
const CLI_NAME: &str = "boop";
const CLI_SHIM: &str = "#!/bin/sh\nexec /usr/bin/open -a NeoBoop \"$@\"\n";

fn cli_path() -> PathBuf {
    Path::new(CLI_DIR).join(CLI_NAME)
}

/// Run a shell command with a native macOS admin prompt (osascript). Used only
/// when the direct filesystem write is denied.
fn run_elevated(script: &str) -> Result<(), String> {
    let escaped = script.replace('\\', "\\\\").replace('"', "\\\"");
    let osa = format!("do shell script \"{escaped}\" with administrator privileges");
    let out = Command::new("osascript")
        .arg("-e")
        .arg(osa)
        .output()
        .map_err(|e| format!("could not run osascript: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    // -128 is "User canceled" from the authentication dialog.
    if err.contains("-128") {
        Err("Cancelled.".into())
    } else {
        Err(format!("Install failed: {}", err.trim()))
    }
}

/// Whether our shim is installed (checks content so we don't claim some other
/// `boop` on PATH as ours).
#[tauri::command]
fn cli_status() -> bool {
    fs::read_to_string(cli_path())
        .map(|s| s.contains("open -a NeoBoop"))
        .unwrap_or(false)
}

/// Install the `boop` shim. Tries a direct write first (works when CLI_DIR is
/// user-writable), then falls back to an admin-elevated copy.
#[tauri::command]
fn install_cli() -> Result<String, String> {
    let target = cli_path();
    if write_shim_direct(&target).is_ok() {
        return Ok(format!("Installed `{CLI_NAME}` → {}", target.display()));
    }
    // Elevated path: stage the shim in a temp file, then copy + chmod as admin.
    let tmp = std::env::temp_dir().join("neoboop-boop-shim");
    fs::write(&tmp, CLI_SHIM).map_err(|e| format!("could not stage shim: {e}"))?;
    let script = format!(
        "mkdir -p '{dir}' && cp '{tmp}' '{target}' && chmod 755 '{target}'",
        dir = CLI_DIR,
        tmp = tmp.display(),
        target = target.display(),
    );
    let res = run_elevated(&script);
    let _ = fs::remove_file(&tmp);
    res.map(|()| format!("Installed `{CLI_NAME}` → {} (as admin)", target.display()))
}

fn write_shim_direct(target: &Path) -> std::io::Result<()> {
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(target, CLI_SHIM)?;
    fs::set_permissions(target, fs::Permissions::from_mode(0o755))
}

/// Remove the `boop` shim (direct, then elevated fallback).
#[tauri::command]
fn uninstall_cli() -> Result<String, String> {
    let target = cli_path();
    if !target.exists() {
        return Ok(format!("`{CLI_NAME}` is not installed."));
    }
    if fs::remove_file(&target).is_ok() {
        return Ok(format!("Removed `{CLI_NAME}`."));
    }
    run_elevated(&format!("rm -f '{}'", target.display()))
        .map(|()| format!("Removed `{CLI_NAME}` (as admin)."))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingOpens::default())
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
        .invoke_handler(tauri::generate_handler![
            read_scripts,
            set_global_shortcut,
            take_opened_files,
            read_text_file,
            write_text_file,
            rename_file,
            app_data_read,
            app_data_write,
            install_cli,
            uninstall_cli,
            cli_status
        ])
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
            //
            // No accelerators here on purpose: the keyboard chords (⌃S side-by-
            // side, ⌃V stacked, ⌃X close pane) are handled in the frontend's
            // capture-phase keydown instead. A native Control accelerator raced
            // with CodeMirror's emacs bindings (⌃V = page-down), so the key both
            // scrolled and split. These items stay clickable; the shortcut hints
            // live in the README + the boot status line.
            let split_right = MenuItemBuilder::with_id("split-right", "Split Right")
                .build(handle)?;
            let split_down = MenuItemBuilder::with_id("split-down", "Split Down")
                .build(handle)?;
            // Closing the focused pane keeps its tab (parked, still in the tab
            // bar). Closing a tab outright is ⌘W (macOS standard).
            let close_pane = MenuItemBuilder::with_id("close-pane", "Close Pane")
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
        .run(|app, event| match event {
            RunEvent::Reopen { .. } => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            // Finder "Open With NeoBoop", dragging a file onto the icon, or
            // `open -a NeoBoop file`. Read each file here (the web layer can't
            // touch arbitrary paths), stash it, raise the window, and nudge the
            // frontend to drain. On a cold launch the window may not be ready;
            // the buffer survives until the frontend's boot drain picks it up.
            RunEvent::Opened { urls } => {
                let files: Vec<TextFile> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .filter_map(|p| read_text_file_at(&p))
                    .collect();
                if files.is_empty() {
                    return;
                }
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                app.state::<PendingOpens>().0.lock().unwrap().extend(files);
                let _ = app.emit("open-files", ());
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("neoboop_test_{name}"))
    }

    #[test]
    fn write_lf_adds_trailing_newline() {
        let p = tmp("lf");
        write_text_file(p.to_string_lossy().into(), "a\nb".into(), "lf".into(), true).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"a\nb\n");
    }

    #[test]
    fn write_crlf_restores_carriage_returns() {
        let p = tmp("crlf");
        write_text_file(p.to_string_lossy().into(), "a\nb".into(), "crlf".into(), true).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"a\r\nb\r\n");
    }

    #[test]
    fn no_final_newline_is_respected() {
        let p = tmp("nonl");
        write_text_file(p.to_string_lossy().into(), "a\nb".into(), "lf".into(), false).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"a\nb");
    }

    #[test]
    fn read_detects_crlf_and_normalises_to_lf() {
        let p = tmp("read_crlf");
        fs::write(&p, b"line1\r\nline2\r\n").unwrap();
        let tf = read_text_file_at(&p).unwrap();
        assert_eq!(tf.eol, "crlf");
        assert!(tf.final_newline);
        assert!(tf.encoding_ok && !tf.read_only);
        assert_eq!(tf.content, "line1\nline2\n"); // editor always sees LF
    }

    /// The safety property: read a file, write it back with its recorded
    /// eol/final-newline, and the bytes are unchanged on those axes.
    #[test]
    fn crlf_round_trip_is_byte_identical() {
        let p = tmp("roundtrip");
        let original = b"x\r\ny\r\nz".to_vec(); // CRLF, no trailing newline
        fs::write(&p, &original).unwrap();
        let tf = read_text_file_at(&p).unwrap();
        write_text_file(tf.path.clone(), tf.content, tf.eol, tf.final_newline).unwrap();
        assert_eq!(fs::read(&p).unwrap(), original);
    }

    #[test]
    fn invalid_utf8_is_read_only() {
        let p = tmp("binary");
        fs::write(&p, [0xff, 0xfe, 0x00, 0x41]).unwrap();
        let tf = read_text_file_at(&p).unwrap();
        assert!(!tf.encoding_ok, "bad UTF-8 should not be encoding_ok");
        assert!(tf.read_only, "bad UTF-8 must be read-only so a save can't corrupt it");
    }
}
