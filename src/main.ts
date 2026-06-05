import "./styles.css";
import { getAllWebviewWindows, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { TabManager } from "./tabs";
import type { Direction } from "./split";
import { search } from "./picker";
import { scripts as builtinScripts, libs } from "./scripts/registry";
import { runScript, type BoopScript } from "./scripts/runtime";
import { getUserDir, loadUserScripts } from "./scripts/userscripts";
import { LANG_OPTIONS, type LangName } from "./languages";
import { applyGlobalShortcut, getGlobalShortcut } from "./shortcut";
import {
  readManifest,
  readScratchContent,
  readSession,
  readTextFile,
  takeOpenedFiles,
  type ScratchMeta,
} from "./store";
import { searchDocuments, type GlobalResult } from "./gsearch";

const tabBarEl = document.getElementById("tab-bar")!;
const editorEl = document.getElementById("editor")!;
const statusEl = document.getElementById("status-bar")!;
const statusMsg = document.getElementById("status-msg")!;
const docKindEl = document.getElementById("doc-kind")!;
const langSelect = document.getElementById("lang-select") as HTMLSelectElement;
const pickerWrap = document.getElementById("picker-wrap")!;
const pickerInput = document.getElementById("picker-input") as HTMLInputElement;
const pickerList = document.getElementById("picker-list")!;
const renameWrap = document.getElementById("rename-wrap")!;
const renameInput = document.getElementById("rename-input") as HTMLInputElement;
const confirmWrap = document.getElementById("confirm-wrap")!;
const confirmMsg = document.getElementById("confirm-msg")!;
const confirmButtons = document.getElementById("confirm-buttons")!;
const gsearchWrap = document.getElementById("gsearch-wrap")!;
const gsearchInput = document.getElementById("gsearch-input") as HTMLInputElement;
const gsearchSummary = document.getElementById("gsearch-summary")!;
const gsearchList = document.getElementById("gsearch-list")!;

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

// Status-bar indicator of what the focused tab is backed by: an autosaved
// scratch, or a real file on disk (with its path as tooltip, and a read-only
// flag when the file can't be written in place).
function updateDocKind(): void {
  if (tabs.focusedKind === "file") {
    const ro = tabs.focusedReadOnly;
    docKindEl.textContent = ro ? "File · read-only" : "File";
    docKindEl.title = tabs.focusedPath ?? "";
    docKindEl.className = "doc-kind file" + (ro ? " readonly" : "");
  } else {
    docKindEl.textContent = "Scratch";
    docKindEl.title = "Autosaved scratch — kept in Scratch History";
    docKindEl.className = "doc-kind scratch";
  }
}

/** Refresh everything bound to the focused tab (language picker + doc kind). */
function syncStatus(): void {
  syncLangSelect();
  updateDocKind();
}

langSelect.addEventListener("change", () => {
  tabs.focused.setMode(langSelect.value as LangName);
  tabs.focused.focus();
});
tabs.onFocusChange = syncStatus;
syncStatus();

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
    height: 340,
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

// ---- global quick-capture shortcut ----------------------------------------
// Rust fires "new-boop" when the system-wide chord is pressed (after it has
// already raised + focused the window); we just open a fresh tab. The chord
// itself is (re)registered here on launch from the saved/default value.
void listen("new-boop", () => tabs.newTab());
void applyGlobalShortcut(getGlobalShortcut()).catch((err) =>
  console.error("Failed to register global shortcut:", err),
);

// ---- open files from Finder ("Open With NeoBoop") -------------------------
// Rust reads the OS-opened file(s) and buffers them; we drain that buffer here.
// Drained both on the "open-files" nudge (app already running) and once on boot
// (cold launch, where the file arrived before this listener existed). The Rust
// side empties the buffer atomically, so the two paths never double-open.

async function drainOpenedFiles(): Promise<void> {
  let files;
  try {
    files = await takeOpenedFiles();
  } catch (err) {
    console.error("Failed to take opened files:", err);
    return;
  }
  if (!files.length) return;
  for (const f of files) tabs.openFile(f);
  syncStatus();
  const ro = files.some((f) => f.readOnly);
  setStatus(
    `Opened ${files.length} file${files.length > 1 ? "s" : ""}${ro ? " (read-only — bad encoding)" : ""}`,
    ro ? "error" : "info",
  );
}

void listen("open-files", () => void drainOpenedFiles());

// ---- save (⌘S) ------------------------------------------------------------
// Real files write in place. Scratch / read-only / never-saved tabs come back
// `needsPath`, so we run the native Save dialog and bind the result as a real
// file (promoting a scratch — its history entry stays put). This is the VS Code
// "⌘S on an untitled buffer pops Save As" behaviour.

async function saveCmd(): Promise<void> {
  const outcome = await tabs.saveFocused();
  if (outcome.kind === "saved") {
    setStatus(`Saved ${outcome.name}`, "info");
  } else if (outcome.kind === "error") {
    setStatus(`Save failed: ${outcome.message}`, "error");
  } else if (outcome.kind === "needsPath") {
    const path = await save({ defaultPath: outcome.suggested });
    if (!path) return;
    const r = await tabs.saveFocusedAs(path);
    if (r.kind === "saved") setStatus(`Saved ${r.name}`, "info");
    else if (r.kind === "error") setStatus(`Save failed: ${r.message}`, "error");
    syncStatus();
  }
  // A successful in-place save flips the dirty dot off but doesn't change kind;
  // still refresh so a scratch→file promotion updates the indicator.
  updateDocKind();
  tabs.focused.focus();
}

// ---- close with unsaved changes -------------------------------------------
// A dirty real file routes its close through here for the macOS Save / Don't
// Save / Cancel prompt. Scratch tabs never reach this — they're autosaved and
// kept in history, so closing one is non-destructive.

tabs.onCloseDirty = async (id) => {
  tabs.showTab(id);
  const choice = await confirmClose(tabs.focusedTitle || "this file");
  if (choice === "cancel") return;
  if (choice === "save") {
    const r = await tabs.saveFocused();
    if (r.kind === "needsPath") {
      const path = await save({ defaultPath: r.suggested });
      if (!path) return; // cancelling the Save dialog cancels the close
      const r2 = await tabs.saveFocusedAs(path);
      if (r2.kind === "error") {
        setStatus(`Save failed: ${r2.message}`, "error");
        return;
      }
    } else if (r.kind === "error") {
      setStatus(`Save failed: ${r.message}`, "error");
      return;
    }
  }
  tabs.closeTab(id);
};

// Double-click a scratch tab to rename it (⌘S is now Save, not rename).
tabs.onRenameRequest = (id) => {
  tabs.showTab(id);
  openRename();
};

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
          name: "Preview Markdown",
          description: "Set this pane's format to Markdown",
          badge: "action",
          keywords: "preview markdown md format mode language render syntax highlight",
          choose: () => {
            tabs.focused.setMode("markdown");
            syncLangSelect();
          },
        },
        {
          name: "Scratch History…",
          description: "Reopen a past scratch (all are kept forever)",
          badge: "action",
          keywords: "scratch history past previous recent notes drafts reopen archive",
          choose: () => openPicker(scratchHistorySession()),
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

/** Scratch-history session (⌘B → "Scratch History…"): every scratch ever typed
 *  is kept forever in the manifest; pick one to reopen it in a tab. Searchable
 *  by name or first-line preview, ordered newest-first by the manager. */
function scratchHistorySession(): PickerSession {
  return {
    placeholder: "Open a past scratch…",
    build: () =>
      tabs.scratchHistory().map((m) => ({
        name: m.name || m.preview || "Untitled",
        description: new Date(m.modified).toLocaleString(),
        keywords: `${m.name ?? ""} ${m.preview}`,
        choose: () => void openScratchFromHistory(m),
      })),
  };
}

async function openScratchFromHistory(meta: ScratchMeta): Promise<void> {
  const content = await readScratchContent(meta.id);
  tabs.openScratch(meta, content);
  syncStatus();
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

// ---- rename scratch tab (double-click) -------------------------------------
// ⌘S is now Save. A scratch's name is set by double-clicking its tab; for a
// scratch the name persists into the history manifest, for a real file the
// name is its filename (these tabs aren't renamable here).

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

// ---- unsaved-changes prompt ------------------------------------------------
// A small in-app modal for the Save / Don't Save / Cancel decision when closing
// a dirty real file. The dialog plugin only offers 2-button prompts, and this
// matches the app's existing overlay style anyway. Returns the chosen action;
// Escape (or clicking the backdrop) is Cancel, Enter is Save.

type CloseChoice = "save" | "discard" | "cancel";
let confirmResolve: ((c: CloseChoice) => void) | null = null;

function confirmClose(name: string): Promise<CloseChoice> {
  confirmMsg.textContent = `Save changes to “${name}” before closing?`;
  confirmButtons.innerHTML = "";
  const mk = (label: string, choice: CloseChoice, primary = false) => {
    const b = document.createElement("button");
    b.className = "confirm-btn" + (primary ? " primary" : "");
    b.textContent = label;
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      finishConfirm(choice);
    });
    confirmButtons.appendChild(b);
  };
  // Order mirrors macOS: Save (default) · Cancel · Don't Save.
  mk("Save", "save", true);
  mk("Cancel", "cancel");
  mk("Don't Save", "discard");
  confirmWrap.classList.remove("hidden");
  confirmWrap.focus();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function finishConfirm(choice: CloseChoice): void {
  confirmWrap.classList.add("hidden");
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(choice);
  tabs.focused.focus();
}

confirmWrap.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    finishConfirm("cancel");
  } else if (e.key === "Enter") {
    e.preventDefault();
    finishConfirm("save");
  }
});

// ---- global cross-tab search (⌃X ⌃F) --------------------------------------
// A ⌘B-style overlay that searches every open tab's name + content at once
// (triggered by the Emacs-style ⌃X prefix → ⌃F; see the capture-phase handler).
// Each result is a tab with hits — name (matched chars marked) + kind badge +
// count, then a content snippet with the query highlighted. Selecting jumps to
// that tab and selects its first hit. titleHtml/snippetHtml are pre-escaped by
// gsearch.ts (only <mark> survives), so injecting them as innerHTML is safe.

let gsResults: GlobalResult[] = [];
let gsActive = 0;

function openGlobalSearch(): void {
  gsearchWrap.classList.remove("hidden");
  gsearchInput.value = "";
  gsActive = 0;
  renderGlobalSearch();
  gsearchInput.focus();
}

function closeGlobalSearch(): void {
  gsearchWrap.classList.add("hidden");
  tabs.focused.focus();
}

function renderGlobalSearch(): void {
  const query = gsearchInput.value.trim();
  gsResults = searchDocuments(tabs.documentsForSearch(), query);
  if (gsActive >= gsResults.length) gsActive = Math.max(0, gsResults.length - 1);

  if (!query) {
    gsearchSummary.textContent = "Type to search open tabs — names & contents";
  } else if (gsResults.length === 0) {
    gsearchSummary.textContent = "No matches";
  } else {
    const total = gsResults.reduce((n, r) => n + r.count, 0);
    gsearchSummary.innerHTML =
      `<b>${total}</b> ${total === 1 ? "match" : "matches"} in ` +
      `<b>${gsResults.length}</b> ${gsResults.length === 1 ? "tab" : "tabs"}`;
  }

  gsearchList.innerHTML = "";
  gsResults.forEach((r, i) => {
    const li = document.createElement("li");
    li.className = "gs-item" + (i === gsActive ? " active" : "");
    const lineRef = r.line != null ? `<span class="gs-line">L${r.line}</span>` : "";
    const countLabel = `${r.count} ${r.count === 1 ? "match" : "matches"}`;
    li.innerHTML =
      `<div class="gs-row1">` +
      `<span class="gs-name">${r.titleHtml}</span>` +
      `<span class="gs-badge ${r.kind}">${r.kind}</span>` +
      `<span class="gs-count">${countLabel}</span>` +
      `</div>` +
      `<div class="gs-snippet">${lineRef}${r.snippetHtml}</div>`;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      chooseGlobalSearch(i);
    });
    gsearchList.appendChild(li);
  });
  gsearchList.querySelector(".gs-item.active")?.scrollIntoView({ block: "nearest" });
}

function chooseGlobalSearch(i: number): void {
  const r = gsResults[i];
  closeGlobalSearch();
  if (!r) return;
  tabs.revealMatch(r.id, r.from, r.to);
  syncStatus();
}

gsearchInput.addEventListener("input", () => {
  gsActive = 0;
  renderGlobalSearch();
});

gsearchInput.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  const down = e.key === "ArrowDown" || (e.ctrlKey && key === "n");
  const up = e.key === "ArrowUp" || (e.ctrlKey && key === "p");
  const n = gsResults.length;
  if (down) {
    e.preventDefault();
    if (n > 0) gsActive = (gsActive + 1) % n;
    renderGlobalSearch();
  } else if (up) {
    e.preventDefault();
    if (n > 0) gsActive = (gsActive - 1 + n) % n;
    renderGlobalSearch();
  } else if (e.key === "Enter") {
    e.preventDefault();
    chooseGlobalSearch(gsActive);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeGlobalSearch();
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
  // Cmd-S: save. Real files write in place; a scratch pops Save As (promote).
  if (key === "s" && !e.shiftKey) {
    e.preventDefault();
    void saveCmd();
    return;
  }
  // Cmd-T: new tab.
  if (key === "t" && !e.shiftKey) {
    e.preventDefault();
    tabs.newTab();
    return;
  }
  // Cmd-W: close the focused tab. A dirty real file prompts to save first
  // (see tabs.onCloseDirty); scratch tabs close freely (autosaved + in history).
  // We always preventDefault so a stray ⌘W never falls through to the native
  // "Close Window" and shuts the whole window.
  if (key === "w" && !e.shiftKey) {
    e.preventDefault();
    tabs.requestClose();
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
  // Ctrl-S/Ctrl-V (split) and Ctrl-X (close pane) are Ctrl chords — handled in
  // the capture-phase listener below, not here (this handler only sees ⌘).
});

// Pane control via Ctrl chords, handled in the CAPTURE phase so they beat
// CodeMirror's mac emacs bindings before the editor sees them. (They are NOT
// native menu accelerators: a native Control accelerator raced with CodeMirror
// — e.g. ⌃V is emacs cursorPageDown, so it both scrolled and split.)
//
//   ⌃S split side-by-side · ⌃V split stacked
//   ⌃H/J/K/L move focus between panes, Vim-style (← ↓ ↑ →)
//   ⌃X is an Emacs-style PREFIX:  ⌃X ⌃F search all tabs · ⌃X 0 close pane
//
// The split chords always swallow the key; H/J/K/L only swallows when focus
// actually moves, so single-pane editing keeps CodeMirror's ⌃H (delete char) /
// ⌃K (kill line).
const PANE_DIRS: Record<string, Direction> = {
  h: "left",
  j: "down",
  k: "up",
  l: "right",
};

// ⌃X prefix: after ⌃X we wait briefly for the second key (⌃F or 0). ⌃X itself
// no longer closes the pane — that moved to ⌃X 0 (Emacs delete-window) so ⌃X
// can serve as a prefix without the close-pane action lagging behind a timeout.
let ctrlXPending = false;
let ctrlXTimer: number | undefined;
function endCtrlXPrefix(): void {
  ctrlXPending = false;
  if (ctrlXTimer) clearTimeout(ctrlXTimer);
  ctrlXTimer = undefined;
}
function beginCtrlXPrefix(): void {
  ctrlXPending = true;
  setStatus("⌃X-   ⌃F search all tabs · 0 close pane", "info");
  if (ctrlXTimer) clearTimeout(ctrlXTimer);
  ctrlXTimer = window.setTimeout(() => {
    endCtrlXPrefix();
    setStatus("", "idle");
  }, 1800);
}

window.addEventListener(
  "keydown",
  (e) => {
    // Overlays own the keyboard while open.
    if (!pickerWrap.classList.contains("hidden")) return;
    if (!renameWrap.classList.contains("hidden")) return;
    if (!confirmWrap.classList.contains("hidden")) return;
    if (!gsearchWrap.classList.contains("hidden")) return;

    const key = e.key.toLowerCase();

    // ⌃X prefix continuation.
    if (ctrlXPending) {
      // Keep waiting through the bare modifier keydowns themselves.
      if (key === "control" || key === "shift" || key === "alt" || key === "meta") return;
      if (e.ctrlKey && key === "f" && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        endCtrlXPrefix();
        setStatus("", "idle");
        openGlobalSearch();
        return;
      }
      if (key === "0" && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        endCtrlXPrefix();
        setStatus("", "idle");
        tabs.closePane();
        return;
      }
      // Any other key abandons the prefix and is handled normally below.
      endCtrlXPrefix();
      setStatus("", "idle");
    }

    if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

    if (key === "x") {
      e.preventDefault();
      e.stopPropagation();
      beginCtrlXPrefix();
      return;
    }
    const split = key === "s" ? "row" : key === "v" ? "column" : null;
    if (split) {
      e.preventDefault();
      e.stopPropagation();
      tabs.splitPane(split);
      return;
    }
    const dir = PANE_DIRS[key];
    if (!dir) return;
    if (tabs.focusDir(dir)) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

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

// ---- session restore -------------------------------------------------------
// Reopen the tabs from last launch: real files by path, scratch by id (content
// from the managed store). The manifest is always loaded first so scratch-id
// allocation this session doesn't collide with history. A file that moved or was
// deleted is skipped, not fatal. The pristine empty boot tab is reused by the
// first restored doc (see TabManager.acquireTab), so there's no leftover blank.

async function restoreSession(): Promise<void> {
  const [manifest, entries] = await Promise.all([readManifest(), readSession()]);
  tabs.loadManifest(manifest);
  if (!entries.length) return;
  const byId = new Map<number, ScratchMeta>(manifest.map((m) => [m.id, m]));
  let focusId: number | undefined;
  for (const e of entries) {
    try {
      if (e.kind === "file" && e.path) {
        const id = tabs.openFile(await readTextFile(e.path));
        if (e.focused) focusId = id;
      } else if (e.kind === "scratch" && e.scratchId != null) {
        const meta = byId.get(e.scratchId);
        if (!meta) continue;
        const id = tabs.openScratch(meta, await readScratchContent(e.scratchId));
        if (e.focused) focusId = id;
      }
    } catch (err) {
      console.error("Session restore skipped an entry:", e, err);
    }
  }
  if (focusId != null) tabs.focusTab(focusId);
  syncStatus();
}

// ---- boot -----------------------------------------------------------------

void (async () => {
  await restoreSession();
  await loadUser(false);
  const extra = allScripts.length - builtinScripts.length;
  const suffix = extra > 0 ? ` (+${extra} custom)` : "";
  setStatus(
    `${allScripts.length} boops loaded${suffix} — ⌘B run · ⌘S save · ⌘T tab · ⌃S/⌃V split`,
    "info",
  );
  // Pick up any file the app was cold-launched with (Finder "Open With…").
  // Runs last so an opened-file message wins the banner.
  await drainOpenedFiles();
})();
