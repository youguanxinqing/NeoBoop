import "./styles.css";
import { getAllWebviewWindows, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { TabManager } from "./tabs";
import { search } from "./picker";
import { scripts as builtinScripts, libs } from "./scripts/registry";
import { runScript, type BoopScript } from "./scripts/runtime";
import { getUserDir, loadUserScripts } from "./scripts/userscripts";
import { LANG_OPTIONS, type LangName } from "./languages";

const tabBarEl = document.getElementById("tab-bar")!;
const editorEl = document.getElementById("editor")!;
const statusEl = document.getElementById("status-bar")!;
const statusMsg = document.getElementById("status-msg")!;
const langSelect = document.getElementById("lang-select") as HTMLSelectElement;
const pickerWrap = document.getElementById("picker-wrap")!;
const pickerInput = document.getElementById("picker-input") as HTMLInputElement;
const pickerList = document.getElementById("picker-list")!;
const renameWrap = document.getElementById("rename-wrap")!;
const renameInput = document.getElementById("rename-input") as HTMLInputElement;

// ---- theme: follow the OS -------------------------------------------------

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const isDark = () => darkQuery.matches;

const tabs = new TabManager(tabBarEl, editorEl, isDark());
tabs.init();

darkQuery.addEventListener("change", () => tabs.setTheme(isDark()));

// ---- language picker (status bar) -----------------------------------------

for (const { value, label } of LANG_OPTIONS) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  langSelect.appendChild(opt);
}
function syncLangSelect(): void {
  langSelect.value = tabs.focused.mode;
}
langSelect.addEventListener("change", () => {
  tabs.focused.setMode(langSelect.value as LangName);
  tabs.focused.focus();
});
tabs.onFocusChange = syncLangSelect;
syncLangSelect();

// ---- script registry (built-in + user) -----------------------------------

let allScripts: BoopScript[] = [...builtinScripts];

async function loadUser(announce: boolean): Promise<void> {
  const dir = getUserDir();
  if (!dir) return;
  try {
    const { scripts } = await loadUserScripts(dir);
    allScripts = [...builtinScripts, ...scripts];
    if (announce) setStatus(`Loaded ${scripts.length} custom scripts from ${dir}`, "info");
  } catch (err) {
    setStatus(`Custom scripts failed: ${err instanceof Error ? err.message : err}`, "error");
  }
}

// ---- status bar -----------------------------------------------------------

let statusTimer: number | undefined;
function setStatus(message: string, kind: "info" | "error" | "idle"): void {
  statusMsg.textContent = message;
  statusEl.className = `status-bar ${kind}`;
  if (statusTimer) clearTimeout(statusTimer);
  if (message && kind !== "idle") {
    statusTimer = window.setTimeout(() => setStatus("", "idle"), 4000);
  }
}

// ---- preferences window ---------------------------------------------------

// Opened from the native "Settings…" menu item (⌘,) — Rust emits "open-settings"
// — and from the ⌘B palette. A dedicated window, the way macOS apps (and Boop)
// present Settings. It writes the chosen folder to localStorage (shared across
// same-origin windows) and emits "scripts-folder-changed"; we reload here.
async function openPreferences(): Promise<void> {
  const existing = (await getAllWebviewWindows()).find((w) => w.label === "preferences");
  if (existing) {
    await existing.setFocus();
    return;
  }
  new WebviewWindow("preferences", {
    url: "preferences.html",
    title: "Preferences",
    width: 560,
    height: 220,
    resizable: false,
    center: true,
  });
}

void listen("open-settings", () => void openPreferences());
void listen("scripts-folder-changed", () => void loadUser(true));

// ---- split view (native View menu, mirroring how Settings is wired) --------
void listen("split-right", () => tabs.splitPane("row"));
void listen("split-down", () => tabs.splitPane("column"));
void listen("close-pane", () => tabs.closePane());

// ---- run a script ---------------------------------------------------------

function execute(script: BoopScript): void {
  const pane = tabs.focused;
  const result = runScript(
    script,
    libs,
    pane.fullText,
    pane.selection,
    pane.insertIndex,
    script.extraLibs ?? {},
  );
  pane.apply(result.text);
  tabs.refreshTitles();
  if (result.error) setStatus(result.error, "error");
  else if (result.info) setStatus(result.info, "info");
  else setStatus(`${script.meta.name} ✓`, "info");
  pane.focus();
}

// ---- command palette (scripts + actions) ----------------------------------

// A palette entry is an app action, a boop script, or a tab in the switcher.
// Surfacing actions in the ⌘B palette — the way Boop already exposes everything
// — is how features like the scripts folder and pane switching stay
// discoverable instead of hiding behind bare shortcuts.
interface PickerEntry {
  name: string;
  description: string;
  badge?: "custom" | "action" | "current";
  keywords: string;
  choose: () => void;
}

// A picker session swaps the overlay between modes (command palette ↔ tab
// switcher) while reusing the same DOM, fuzzy search, and keyboard handling.
interface PickerSession {
  placeholder: string;
  build: () => PickerEntry[];
}

/** Command-palette session: app actions first, then all scripts. */
function commandSession(): PickerSession {
  return {
    placeholder: "Search boops…",
    build: () => {
      const actions: PickerEntry[] = [
        {
          name: "Select Pane",
          description: "Show another tab in the focused pane",
          badge: "action",
          keywords: "select pane tab switch go to choose buffer window",
          choose: () => openPicker(tabSession()),
        },
        {
          name: "Settings…",
          description: "Custom scripts folder and preferences",
          badge: "action",
          keywords: "settings preferences custom user config directory folder scripts",
          choose: () => void openPreferences(),
        },
      ];
      const scriptCmds: PickerEntry[] = allScripts.map((s) => ({
        name: s.meta.name,
        description: s.meta.description ?? "",
        badge: s.origin === "user" ? "custom" : undefined,
        keywords: s.meta.tags ?? "",
        choose: () => execute(s),
      }));
      return [...actions, ...scriptCmds];
    },
  };
}

/** Tab-switcher session (⌘B → "Select Pane"): pick a tab to show in the focused
 *  pane. Searchable by title or content; Enter shows it in the current pane. */
function tabSession(): PickerSession {
  return {
    placeholder: "Switch tab in this pane…",
    build: () =>
      tabs.list().map((t) => ({
        name: t.title || "Untitled",
        description: t.preview,
        badge: t.focused ? "current" : undefined,
        keywords: t.preview,
        choose: () => tabs.showTab(t.id),
      })),
  };
}

let session: PickerSession = commandSession();
let matches: PickerEntry[] = [];
let activeIndex = 0;

function renderPicker(): void {
  const entries = session.build();
  matches = search(entries, pickerInput.value.trim(), (e) => `${e.name} ${e.keywords}`);
  if (activeIndex >= matches.length) activeIndex = Math.max(0, matches.length - 1);
  pickerList.innerHTML = "";
  matches.forEach((entry, i) => {
    const li = document.createElement("li");
    li.className =
      "picker-item" +
      (i === activeIndex ? " active" : "") +
      (entry.badge === "action" ? " is-action" : "");
    const badge = entry.badge ? `<span class="picker-badge ${entry.badge}">${entry.badge}</span>` : "";
    li.innerHTML =
      `<span class="picker-name">${escapeHtml(entry.name)}${badge}</span>` +
      `<span class="picker-desc">${escapeHtml(entry.description)}</span>`;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      choosePicker(i);
    });
    pickerList.appendChild(li);
  });
  // Keep the highlighted item in view as the selection moves with arrow keys.
  pickerList.querySelector(".picker-item.active")?.scrollIntoView({ block: "nearest" });
}

/** Open the overlay in a given session (command palette or tab switcher). */
function openPicker(next: PickerSession): void {
  session = next;
  pickerWrap.classList.remove("hidden");
  pickerInput.placeholder = next.placeholder;
  pickerInput.value = "";
  activeIndex = 0;
  renderPicker();
  pickerInput.focus();
}

function closePicker(): void {
  pickerWrap.classList.add("hidden");
  tabs.focused.focus();
}

function choosePicker(index: number): void {
  const entry = matches[index];
  closePicker();
  entry?.choose();
}

pickerInput.addEventListener("input", () => {
  activeIndex = 0;
  renderPicker();
});

pickerInput.addEventListener("keydown", (e) => {
  // Move with the arrows or ⌃N / ⌃P (Emacs convention); selection wraps around
  // at both ends so it scrolls cyclically.
  const key = e.key.toLowerCase();
  const down = e.key === "ArrowDown" || (e.ctrlKey && key === "n");
  const up = e.key === "ArrowUp" || (e.ctrlKey && key === "p");
  const n = matches.length;

  if (down) {
    e.preventDefault();
    if (n > 0) activeIndex = (activeIndex + 1) % n;
    renderPicker();
  } else if (up) {
    e.preventDefault();
    if (n > 0) activeIndex = (activeIndex - 1 + n) % n;
    renderPicker();
  } else if (e.key === "Enter") {
    e.preventDefault();
    choosePicker(activeIndex);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closePicker();
  }
});

// ---- rename tab (⌘S) -------------------------------------------------------
// NeoBoop is a scratchpad with no files, so ⌘S doesn't "save" — it names the
// focused tab. The name lives in memory for the session only (not persisted).

function openRename(): void {
  renameInput.value = tabs.focusedCustomName;
  renameInput.placeholder = tabs.focusedAutoTitle || "Tab name";
  renameWrap.classList.remove("hidden");
  renameInput.focus();
  renameInput.select();
}

function closeRename(): void {
  renameWrap.classList.add("hidden");
  tabs.focused.focus();
}

renameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    tabs.renameFocused(renameInput.value);
    closeRename();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeRename();
  }
});
// Clicking away abandons the rename (no commit), like dismissing the picker.
renameInput.addEventListener("blur", () => renameWrap.classList.add("hidden"));

// ---- editor font zoom (⌘+ / ⌘- / ⌘0) --------------------------------------
// App-wide zoom, the macOS way: one font size shared by every tab (and every
// window, via localStorage), not a per-editor setting. Driven through the
// --editor-font-size CSS variable that .cm-scroller reads.

// Matches Boop's default editor font (SFMono-Regular 15pt). 1 CSS px maps 1:1
// to a macOS point in the webview, so 15px reads the same size as native Boop.
const DEFAULT_FONT_PX = 15;
const MIN_FONT_PX = 8;
const MAX_FONT_PX = 40;
const FONT_KEY = "editor-font-px";

const clampFont = (n: number) =>
  Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, Math.round(n)));

let fontPx = clampFont(Number(localStorage.getItem(FONT_KEY)) || DEFAULT_FONT_PX);

function applyFont(persist: boolean): void {
  document.documentElement.style.setProperty("--editor-font-size", `${fontPx}px`);
  if (persist) localStorage.setItem(FONT_KEY, String(fontPx));
  // Line heights changed — make CodeMirror re-measure so scroll math stays sane.
  tabs.requestMeasure();
}

function zoomFont(delta: number): void {
  const next = delta === 0 ? DEFAULT_FONT_PX : clampFont(fontPx + delta);
  if (next === fontPx && delta !== 0) return;
  fontPx = next;
  applyFont(true);
  setStatus(`Font size ${fontPx}px`, "info");
}

// Apply the persisted size on boot, and keep other windows in sync live.
applyFont(false);
window.addEventListener("storage", (e) => {
  if (e.key !== FONT_KEY || e.newValue == null) return;
  fontPx = clampFont(Number(e.newValue) || DEFAULT_FONT_PX);
  applyFont(false);
});

// ---- global shortcuts -----------------------------------------------------
// These are ⌘ (Cmd) shortcuts only. Ctrl is reserved for the native View-menu
// accelerators — ⌃S/⌃V split, ⌃X close pane — so we deliberately do NOT treat
// Ctrl as a Cmd alias here; otherwise ⌃S would fire both rename and split.
// Note: Settings (⌘,) is handled by the native menu accelerator (emits
// "open-settings") — no JS handler needed here.

window.addEventListener("keydown", (e) => {
  if (!e.metaKey || e.ctrlKey) return;
  const key = e.key.toLowerCase();

  // Cmd-B: toggle the boop command palette.
  if (key === "b" && !e.shiftKey) {
    e.preventDefault();
    if (pickerWrap.classList.contains("hidden")) openPicker(commandSession());
    else closePicker();
    return;
  }
  // Cmd-P: jump straight into Select Pane (the tab switcher), skipping the
  // command palette. Same overlay, just opened in the tab session directly.
  if (key === "p" && !e.shiftKey) {
    e.preventDefault();
    if (pickerWrap.classList.contains("hidden")) openPicker(tabSession());
    else closePicker();
    return;
  }
  // Cmd-S: rename the focused tab (NeoBoop has no files — see openRename).
  if (key === "s" && !e.shiftKey) {
    e.preventDefault();
    if (renameWrap.classList.contains("hidden")) openRename();
    else closeRename();
    return;
  }
  // Cmd-T: new tab. Cmd-W: close tab.
  if (key === "t" && !e.shiftKey) {
    e.preventDefault();
    tabs.newTab();
    return;
  }
  // Cmd-W (close tab + its pane) is intentionally disabled for now — too easy
  // to fat-finger and lose work. We still swallow the key (preventDefault) so a
  // stray ⌘W doesn't fall through to the native "Close Window" and shut the
  // whole window. Tabs are still closable on purpose via the ✕ button.
  // Re-enable by restoring `tabs.closeTab()` here.
  if (key === "w" && !e.shiftKey) {
    e.preventDefault();
    return;
  }
  // Cmd-+ / Cmd-= : larger font. Cmd-- : smaller. Cmd-0 : reset.
  // "=" is the unshifted ⌘+ on most layouts; accept both. preventDefault also
  // suppresses the WebView's own full-page zoom.
  if (key === "=" || key === "+") {
    e.preventDefault();
    zoomFont(+1);
    return;
  }
  if (key === "-" || key === "_") {
    e.preventDefault();
    zoomFont(-1);
    return;
  }
  if (key === "0") {
    e.preventDefault();
    zoomFont(0);
    return;
  }
  // Cmd-Shift-] / [ : next / previous tab.
  if (e.shiftKey && (key === "]" || key === "}")) {
    e.preventDefault();
    tabs.switchBy(1);
    return;
  }
  if (e.shiftKey && (key === "[" || key === "{")) {
    e.preventDefault();
    tabs.switchBy(-1);
    return;
  }
  // Ctrl-S (竖屏 / side-by-side) and Ctrl-V (横屏 / stacked) are handled by the
  // native View-menu accelerators, which emit "split-right" / "split-down" —
  // see the listeners above. Same pattern as Settings (⌘,); no JS handler.

  // Cmd-Opt-arrows : move focus to the neighbouring pane.
  if (e.altKey) {
    const dir =
      key === "arrowleft" ? "left" :
      key === "arrowright" ? "right" :
      key === "arrowup" ? "up" :
      key === "arrowdown" ? "down" : null;
    if (dir) {
      e.preventDefault();
      tabs.focusDir(dir);
      return;
    }
  }
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// Dev-only test handle (stripped from production builds).
if (import.meta.env.DEV) {
  (window as unknown as { __neoboop: unknown }).__neoboop = {
    tabs,
    execute,
    get scripts() {
      return allScripts;
    },
  };
}

// ---- boot -----------------------------------------------------------------

void loadUser(false).then(() => {
  const extra = allScripts.length - builtinScripts.length;
  const suffix = extra > 0 ? ` (+${extra} custom)` : "";
  setStatus(`${allScripts.length} boops loaded${suffix} — ⌘B run · ⌘T tab · ⌃S/⌃V split · ⌘, settings`, "info");
});
