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
  langSelect.value = tabs.active.mode;
}
langSelect.addEventListener("change", () => {
  tabs.active.setMode(langSelect.value as LangName);
  tabs.active.focus();
});
tabs.onActiveChange = syncLangSelect;
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

// ---- run a script ---------------------------------------------------------

function execute(script: BoopScript): void {
  const pane = tabs.active;
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

// A command is either a boop script or an app action (e.g. set the custom
// scripts folder). Surfacing actions in the ⌘B palette — the way Boop already
// exposes everything — is how the folder setting becomes discoverable, instead
// of hiding behind a bare keyboard shortcut.
interface Command {
  name: string;
  description: string;
  badge?: "custom" | "action";
  keywords: string;
  run: () => void;
}

/** Builds the command list: app actions first, then all scripts. */
function buildCommands(): Command[] {
  const actions: Command[] = [
    {
      name: "Settings…",
      description: "Custom scripts folder and preferences",
      badge: "action",
      keywords: "settings preferences custom user config directory folder scripts",
      run: () => void openPreferences(),
    },
  ];
  const scriptCmds: Command[] = allScripts.map((s) => ({
    name: s.meta.name,
    description: s.meta.description ?? "",
    badge: s.origin === "user" ? "custom" : undefined,
    keywords: s.meta.tags ?? "",
    run: () => execute(s),
  }));
  return [...actions, ...scriptCmds];
}

let matches: Command[] = [];
let activeIndex = 0;

function renderPicker(): void {
  const commands = buildCommands();
  matches = search(commands, pickerInput.value.trim(), (c) => `${c.name} ${c.keywords}`);
  if (activeIndex >= matches.length) activeIndex = Math.max(0, matches.length - 1);
  pickerList.innerHTML = "";
  matches.forEach((cmd, i) => {
    const li = document.createElement("li");
    li.className =
      "picker-item" +
      (i === activeIndex ? " active" : "") +
      (cmd.badge === "action" ? " is-action" : "");
    const badge = cmd.badge ? `<span class="picker-badge ${cmd.badge}">${cmd.badge}</span>` : "";
    li.innerHTML =
      `<span class="picker-name">${escapeHtml(cmd.name)}${badge}</span>` +
      `<span class="picker-desc">${escapeHtml(cmd.description)}</span>`;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      choosePicker(i);
    });
    pickerList.appendChild(li);
  });
  // Keep the highlighted item in view as the selection moves with arrow keys.
  pickerList.querySelector(".picker-item.active")?.scrollIntoView({ block: "nearest" });
}

function openPicker(): void {
  pickerWrap.classList.remove("hidden");
  pickerInput.value = "";
  activeIndex = 0;
  renderPicker();
  pickerInput.focus();
}

function closePicker(): void {
  pickerWrap.classList.add("hidden");
  tabs.active.focus();
}

function choosePicker(index: number): void {
  const cmd = matches[index];
  closePicker();
  cmd?.run();
}

pickerInput.addEventListener("input", () => {
  activeIndex = 0;
  renderPicker();
});

pickerInput.addEventListener("keydown", (e) => {
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, matches.length - 1);
      renderPicker();
      break;
    case "ArrowUp":
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      renderPicker();
      break;
    case "Enter":
      e.preventDefault();
      choosePicker(activeIndex);
      break;
    case "Escape":
      e.preventDefault();
      closePicker();
      break;
  }
});

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
// Note: Settings (⌘,) is handled by the native menu accelerator, which emits
// "open-settings" — no JS handler needed here.

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const key = e.key.toLowerCase();

  // Cmd-B: toggle the boop picker.
  if (key === "b" && !e.shiftKey) {
    e.preventDefault();
    if (pickerWrap.classList.contains("hidden")) openPicker();
    else closePicker();
    return;
  }
  // Cmd-T: new tab. Cmd-W: close tab.
  if (key === "t" && !e.shiftKey) {
    e.preventDefault();
    tabs.newTab();
    return;
  }
  if (key === "w" && !e.shiftKey) {
    e.preventDefault();
    tabs.closeTab();
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
  setStatus(`${allScripts.length} boops loaded${suffix} — ⌘B run · ⌘T tab · ⌘, settings`, "info");
});
