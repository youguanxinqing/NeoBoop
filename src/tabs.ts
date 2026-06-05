// Tab manager + split layout host + document model.
//
// THE WHOLE POINT (still): every tab owns a fully independent EditorPane that
// stays alive for the tab's entire lifetime. Switching tabs, splitting, and
// resizing only move the pane's DOM around — no shared editor, no state-swap,
// no responder/field-editor reattachment. This is the structural fix for the
// input-dies-on-tab-switch bug that plagued native Boop.
//
// SPLIT MODEL: a SplitTree decides the *geometry* (which leaves exist, how they
// are arranged, which is focused) and which tab each leaf shows. TabManager owns
// the tabs and reconciles pane DOM into the tree's leaf slots; unshown panes are
// parked in a hidden holder so their EditorView survives untouched. A tab is
// shown in at most one leaf — there is no shared-buffer dual view (see split.ts).
//
// DOCUMENT MODEL: each tab is backed by either a real file (opened from Finder /
// ⌘S-saved — explicit save, dirty marker, close-prompt) or a scratch (a managed
// file under app-data that autosaves and lives forever in the scratch history;
// the user never names or saves it). The two share one abstraction: `savedText`
// is the last-persisted baseline, and dirty = current text ≠ savedText. For a
// file that drives the visible dirty dot; for a scratch it just decides whether
// the next autosave tick has anything to flush.

import { EditorPane } from "./editor";
import { SplitTree, type Axis, type Direction } from "./split";
import { langFromFilename } from "./languages";
import {
  writeManifest,
  writeScratchContent,
  writeSession,
  writeTextFile,
  type Eol,
  type ScratchMeta,
  type SessionEntry,
  type TextFile,
} from "./store";

type TabKind = "scratch" | "file";

interface Tab {
  id: number;
  pane: EditorPane;
  kind: TabKind;
  /** User-set display name (double-click). Wins over the derived title. */
  customName?: string;
  /** Last text persisted to this tab's backing store. dirty = fullText !== this. */
  savedText: string;

  // file-backed:
  path: string | null;
  eol: Eol;
  finalNewline: boolean;
  /** Bad-encoding or unwritable file: ⌘S is steered to Save As instead. */
  readOnly: boolean;

  // scratch-backed:
  /** Managed-store id; null until the scratch first has non-empty content. */
  scratchId: number | null;
  created: number;

  /** Whether the dirty dot is currently rendered (so edits only re-render on a
   *  clean↔dirty flip, not every keystroke). */
  dirtyShown: boolean;
  autosaveTimer?: number;
}

const AUTOSAVE_MS = 600;
const PERSIST_MS = 400;

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function firstLinePreview(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.trim().slice(0, 80);
}

export class TabManager {
  private tabs: Tab[] = [];
  private nextId = 1;
  private dark: boolean;

  /** In-memory mirror of the scratch history manifest; flushed debounced. */
  private manifest: ScratchMeta[] = [];
  private nextScratchId = 1;
  private manifestTimer?: number;
  private sessionTimer?: number;

  /** Parking lot for panes whose tab is not currently shown in any leaf. */
  private readonly holder: HTMLElement;
  private split!: SplitTree;
  private focusedId = -1;

  /** Fires when the focused tab/pane changes, so UI bound to it (e.g. the
   *  language picker in the status bar) can refresh. */
  onFocusChange: (() => void) | null = null;
  /** A dirty file tab wants to close — the host shows the Save/Don't Save/Cancel
   *  prompt, then calls back into closeTab/saveFocused. */
  onCloseDirty: ((id: number) => void) | null = null;
  /** Double-clicking a scratch tab's label requests a rename. */
  onRenameRequest: ((id: number) => void) | null = null;

  constructor(
    private readonly tabBar: HTMLElement,
    private readonly editorHost: HTMLElement,
    dark: boolean,
  ) {
    this.dark = dark;
    this.holder = document.createElement("div");
    this.holder.className = "pane-holder";
    (editorHost.parentElement ?? document.body).appendChild(this.holder);
  }

  get focused(): EditorPane {
    return this.paneFor(this.focusedId) ?? this.tabs[0].pane;
  }

  init(): void {
    const first = this.createTab();
    this.focusedId = first.id;
    this.split = new SplitTree(this.editorHost, first.id);
    this.split.onLayoutChange = () => this.reconcile();
    this.split.onFocusChange = (tabId) => {
      this.focusedId = tabId;
      this.render();
      this.focused.focus();
      this.onFocusChange?.();
      this.scheduleSessionWrite();
    };
    this.reconcile();
    this.focused.focus();
  }

  /** Seed the scratch store from the persisted manifest (call before restore so
   *  id allocation doesn't collide with history). */
  loadManifest(manifest: ScratchMeta[]): void {
    this.manifest = manifest;
    this.nextScratchId = manifest.reduce((m, e) => Math.max(m, e.id), 0) + 1;
  }

  // ---- tab lifecycle ------------------------------------------------------

  /** Create a scratch tab + pane, parked in the holder. Does not show it. */
  private createTab(): Tab {
    const pane = new EditorPane(this.holder, this.dark);
    const tab: Tab = {
      id: this.nextId++,
      pane,
      kind: "scratch",
      savedText: "",
      path: null,
      eol: "lf",
      finalNewline: true,
      readOnly: false,
      scratchId: null,
      created: Date.now(),
      dirtyShown: false,
    };
    pane.onDocChange = () => this.onTabEdited(tab);
    this.tabs.push(tab);
    return tab;
  }

  /** New scratch tab, shown in the focused leaf (the macOS "new tab" feel). */
  newTab(): void {
    const tab = this.createTab();
    this.split.showTab(tab.id);
    this.focused.focus();
    this.scheduleSessionWrite();
  }

  /** Reuse the lone pristine scratch tab (clean cold-start / restore) instead of
   *  leaving a blank tab behind; otherwise create a fresh one. */
  private acquireTab(): Tab {
    const only = this.tabs.length === 1 ? this.tabs[0] : undefined;
    const pristine =
      only &&
      only.kind === "scratch" &&
      only.scratchId == null &&
      !only.customName &&
      only.pane.fullText === "";
    return pristine ? only : this.createTab();
  }

  /** Open a real file in a tab (Finder "Open With…", session restore). Focuses
   *  it if already open by the same path; sets the language from the extension. */
  openFile(tf: TextFile): number {
    const existing = this.tabs.find((t) => t.kind === "file" && t.path === tf.path);
    if (existing) {
      this.split.showTab(existing.id);
      this.focused.focus();
      return existing.id;
    }
    const tab = this.acquireTab();
    tab.kind = "file";
    tab.path = tf.path;
    tab.eol = tf.eol;
    tab.finalNewline = tf.finalNewline;
    tab.readOnly = tf.readOnly;
    tab.scratchId = null;
    tab.customName = undefined;
    tab.savedText = tf.content;
    tab.dirtyShown = false;
    tab.pane.setContent(tf.content);
    const mode = langFromFilename(tf.name);
    if (mode !== "auto") tab.pane.setMode(mode);
    this.split.showTab(tab.id);
    this.focused.focus();
    this.render();
    this.scheduleSessionWrite();
    return tab.id;
  }

  /** Open a scratch from history (or restore one) into a tab. */
  openScratch(meta: ScratchMeta, content: string): number {
    const existing = this.tabs.find((t) => t.kind === "scratch" && t.scratchId === meta.id);
    if (existing) {
      this.split.showTab(existing.id);
      this.focused.focus();
      return existing.id;
    }
    const tab = this.acquireTab();
    tab.kind = "scratch";
    tab.scratchId = meta.id;
    tab.created = meta.created;
    tab.customName = meta.name;
    tab.savedText = content;
    tab.dirtyShown = false;
    tab.pane.setContent(content);
    if (meta.lang && meta.lang !== "auto") tab.pane.setMode(meta.lang);
    this.split.showTab(tab.id);
    this.focused.focus();
    this.render();
    this.scheduleSessionWrite();
    return tab.id;
  }

  /** Show a tab by id (used after restore to focus the right one). */
  focusTab(id: number): void {
    if (this.tabs.some((t) => t.id === id)) this.split.showTab(id);
  }

  /** A dirty file tab wants to close: route through the host's prompt. Scratch
   *  and clean tabs close immediately (scratch is already autosaved + in history). */
  requestClose(id: number = this.focusedId): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.kind === "file" && this.isDirty(tab)) this.onCloseDirty?.(id);
    else this.closeTab(id);
  }

  /** Close a tab: persist its last scratch edits, destroy the document, collapse
   *  the pane. A scratch's history entry is permanent — only the open tab goes. */
  closeTab(id?: number): void {
    const targetId = id ?? this.focusedId;
    const idx = this.tabs.findIndex((t) => t.id === targetId);
    if (idx === -1) return;

    const [removed] = this.tabs.splice(idx, 1);
    if (removed.autosaveTimer) clearTimeout(removed.autosaveTimer);
    // Capture the last edits before the pane is gone (autosave is debounced).
    if (removed.kind === "scratch") this.persistScratch(removed);

    const collapsed = this.split.removeTab(removed.id);
    removed.pane.destroy();

    if (this.tabs.length === 0) {
      const fresh = this.createTab();
      this.split.showTab(fresh.id);
    } else if (!collapsed) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.split.showTab(next.id);
    }
    this.focused.focus();
    this.scheduleSessionWrite();
  }

  /** Cycle which tab the focused leaf shows (⌘⇧[ / ⌘⇧]). */
  switchBy(delta: number): void {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.findIndex((t) => t.id === this.focusedId);
    const next = (idx + delta + this.tabs.length) % this.tabs.length;
    this.split.showTab(this.tabs[next].id);
  }

  // ---- save / dirty -------------------------------------------------------

  private isDirty(tab: Tab): boolean {
    return tab.pane.fullText !== tab.savedText;
  }

  /** Save the focused tab. Files write in place; scratch / read-only / pathless
   *  tabs report `needsPath` so the host can run a Save As dialog. */
  async saveFocused(): Promise<SaveOutcome> {
    const tab = this.focusedTab();
    if (!tab) return { kind: "clean" };
    if (tab.kind !== "file" || tab.readOnly || tab.path == null) {
      return { kind: "needsPath", suggested: this.suggestedName(tab) };
    }
    if (!this.isDirty(tab)) return { kind: "clean" };
    try {
      await writeTextFile(tab.path, tab.pane.fullText, tab.eol, tab.finalNewline);
      tab.savedText = tab.pane.fullText;
      tab.dirtyShown = false;
      this.render();
      return { kind: "saved", name: this.titleFor(tab) };
    } catch (e) {
      return { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Save the focused tab to `path` and (re)bind it as a real file. Used both for
   *  "Save As" on a file and for promoting a scratch to a real file — the scratch's
   *  history entry stays put, the tab just stops being a scratch. */
  async saveFocusedAs(path: string): Promise<SaveOutcome> {
    const tab = this.focusedTab();
    if (!tab) return { kind: "clean" };
    try {
      await writeTextFile(path, tab.pane.fullText, tab.eol, tab.finalNewline);
    } catch (e) {
      return { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
    tab.kind = "file";
    tab.path = path;
    tab.readOnly = false;
    tab.scratchId = null;
    tab.customName = undefined;
    tab.savedText = tab.pane.fullText;
    tab.dirtyShown = false;
    const mode = langFromFilename(basename(path));
    if (mode !== "auto") tab.pane.setMode(mode);
    this.render();
    this.scheduleSessionWrite();
    return { kind: "saved", name: basename(path) };
  }

  private suggestedName(tab: Tab): string {
    if (tab.path) return basename(tab.path);
    const t = this.titleFor(tab).trim();
    const base = t && t !== "" ? t : "untitled";
    return base.includes(".") ? base : `${base}.txt`;
  }

  // ---- scratch autosave + manifest ----------------------------------------

  private onTabEdited(tab: Tab): void {
    const dot = tab.kind === "file" && this.isDirty(tab);
    if (dot !== tab.dirtyShown) {
      tab.dirtyShown = dot;
      this.render();
    }
    if (tab.kind === "scratch") this.scheduleAutosave(tab);
  }

  private scheduleAutosave(tab: Tab): void {
    if (tab.autosaveTimer) clearTimeout(tab.autosaveTimer);
    tab.autosaveTimer = window.setTimeout(() => this.persistScratch(tab), AUTOSAVE_MS);
  }

  /** Flush a scratch's current text to its backing file + manifest entry. Skips
   *  an untouched-empty scratch so the history isn't littered with blank tabs. */
  private persistScratch(tab: Tab, text = tab.pane.fullText): void {
    if (tab.kind !== "scratch") return;
    if (text === tab.savedText) return;
    if (text === "" && tab.scratchId == null) return;
    if (tab.scratchId == null) tab.scratchId = this.nextScratchId++;
    tab.savedText = text;
    void writeScratchContent(tab.scratchId, text);
    this.upsertManifest(tab, text);
    this.scheduleManifestWrite();
    this.scheduleSessionWrite();
  }

  private upsertManifest(tab: Tab, text: string): void {
    if (tab.scratchId == null) return;
    const entry: ScratchMeta = {
      id: tab.scratchId,
      created: tab.created,
      modified: Date.now(),
      name: tab.customName,
      lang: tab.pane.mode,
      preview: firstLinePreview(text),
    };
    const i = this.manifest.findIndex((m) => m.id === tab.scratchId);
    if (i >= 0) this.manifest[i] = entry;
    else this.manifest.push(entry);
  }

  private scheduleManifestWrite(): void {
    if (this.manifestTimer) clearTimeout(this.manifestTimer);
    this.manifestTimer = window.setTimeout(() => void writeManifest(this.manifest), PERSIST_MS);
  }

  private scheduleSessionWrite(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = window.setTimeout(() => void writeSession(this.sessionEntries()), PERSIST_MS);
  }

  /** Tabs to reopen next launch: real files by path, scratch by id. Untouched
   *  (never-persisted) scratch tabs have nothing to restore and are skipped. */
  private sessionEntries(): SessionEntry[] {
    const out: SessionEntry[] = [];
    for (const tab of this.tabs) {
      const focused = tab.id === this.focusedId;
      if (tab.kind === "file" && tab.path) {
        out.push({ kind: "file", path: tab.path, focused });
      } else if (tab.kind === "scratch" && tab.scratchId != null) {
        out.push({ kind: "scratch", scratchId: tab.scratchId, focused });
      }
    }
    return out;
  }

  /** All scratch history entries, newest first (for the history picker). */
  scratchHistory(): ScratchMeta[] {
    return [...this.manifest].sort((a, b) => b.modified - a.modified);
  }

  // ---- split commands -----------------------------------------------------

  /** Split the focused pane; the new pane gets a fresh scratch tab. */
  splitPane(axis: Axis): void {
    const tab = this.createTab();
    this.split.split(axis, tab.id);
    this.focused.focus();
    this.scheduleSessionWrite();
  }

  /** Close the focused pane, collapsing the split — its tab survives, parked
   *  in the holder and still listed in the tab bar. No-op when not split. */
  closePane(): void {
    if (this.split.closeFocused()) this.focused.focus();
  }

  /** Move focus to the neighbouring pane in `dir`. Returns whether it moved
   *  (false when there's no pane that way — caller can let the key fall
   *  through to the editor). */
  focusDir(dir: Direction): boolean {
    return this.split.navigate(dir);
  }

  // ---- tab switcher (⌘B → Select Pane) ------------------------------------

  /** Snapshot of all tabs for the switcher picker. */
  list(): { id: number; title: string; preview: string; focused: boolean; shown: boolean }[] {
    const shown = new Set(this.split.leaves.map((l) => l.tabId));
    return this.tabs.map((t) => ({
      id: t.id,
      title: this.titleFor(t),
      preview: this.previewFor(t),
      focused: t.id === this.focusedId,
      shown: shown.has(t.id),
    }));
  }

  /** Show a tab in the focused pane (or focus it if already shown elsewhere). */
  showTab(id: number): void {
    this.split.showTab(id);
    this.focused.focus();
  }

  /** One-line content snippet, for disambiguating tabs in the switcher. */
  private previewFor(tab: Tab): string {
    return tab.pane.fullText.replace(/\s+/g, " ").trim().slice(0, 80);
  }

  // ---- reconcile + render -------------------------------------------------

  /** Idempotently mount each shown tab's pane into its leaf slot and park the
   *  rest. Moving a pane's DOM preserves its EditorView (the iron rule). */
  private reconcile(): void {
    const leaves = this.split.leaves;
    const shown = new Set<number>();

    for (const leaf of leaves) {
      shown.add(leaf.tabId);
      const pane = this.paneFor(leaf.tabId);
      if (!pane) continue;
      if (pane.dom.parentElement !== leaf.el) leaf.el.appendChild(pane.dom);
      pane.setVisible(true);
    }
    for (const tab of this.tabs) {
      if (shown.has(tab.id)) continue;
      if (tab.pane.dom.parentElement !== this.holder) this.holder.appendChild(tab.pane.dom);
      tab.pane.setVisible(false);
    }
    // Slots changed size — re-measure the visible editors so scroll math is sane.
    for (const id of shown) this.paneFor(id)?.view.requestMeasure();
    this.render();
  }

  private paneFor(id: number): EditorPane | undefined {
    return this.tabs.find((t) => t.id === id)?.pane;
  }

  setTheme(dark: boolean): void {
    this.dark = dark;
    for (const tab of this.tabs) tab.pane.setTheme(dark);
  }

  /** Force every pane to re-measure geometry (e.g. after a font-size change). */
  requestMeasure(): void {
    for (const tab of this.tabs) tab.pane.view.requestMeasure();
  }

  /** Auto title from the first line of content, else the "Untitled N" fallback. */
  private autoTitleFor(tab: Tab): string {
    const firstLine = tab.pane.fullText.split("\n", 1)[0].trim();
    return firstLine ? firstLine.slice(0, 24) : this.untitledName(tab);
  }

  /** Title shown in the tab: user name > file basename > first-line auto title. */
  private titleFor(tab: Tab): string {
    if (tab.customName) return tab.customName;
    if (tab.kind === "file" && tab.path) return basename(tab.path);
    return this.autoTitleFor(tab);
  }

  private focusedTab(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.focusedId);
  }

  /** Current custom name of the focused tab (empty when it has none). */
  get focusedCustomName(): string {
    return this.focusedTab()?.customName ?? "";
  }

  /** Auto title of the focused tab — shown as the rename placeholder. */
  get focusedAutoTitle(): string {
    const tab = this.focusedTab();
    return tab ? this.autoTitleFor(tab) : "";
  }

  /** Display title of the focused tab: filename for a file, name/first-line for
   *  a scratch. This is what the close prompt and tab bar show — not the raw
   *  first line of content. */
  get focusedTitle(): string {
    const tab = this.focusedTab();
    return tab ? this.titleFor(tab) : "";
  }

  /** Whether the focused tab is a real file or a scratch (for the status bar). */
  get focusedKind(): TabKind {
    return this.focusedTab()?.kind ?? "scratch";
  }

  /** Absolute path of the focused tab when it's a real file, else null. */
  get focusedPath(): string | null {
    return this.focusedTab()?.path ?? null;
  }

  /** Whether the focused file is read-only (bad encoding / unwritable). */
  get focusedReadOnly(): boolean {
    return this.focusedTab()?.readOnly ?? false;
  }

  /** Set (or, with an empty string, clear) the focused tab's display name. */
  renameFocused(name: string): void {
    const tab = this.focusedTab();
    if (!tab) return;
    const trimmed = name.trim();
    tab.customName = trimmed || undefined;
    if (tab.kind === "scratch" && tab.scratchId != null) {
      this.upsertManifest(tab, tab.pane.fullText);
      this.scheduleManifestWrite();
    }
    this.render();
    this.focused.focus();
  }

  private untitledName(tab: Tab): string {
    const idx = this.tabs.indexOf(tab);
    return `Untitled ${(idx >= 0 ? idx : this.tabs.length) + 1}`;
  }

  private render(): void {
    // A single scratch tab adds only chrome noise — hide the bar until there are
    // 2+. Exception: show it once a tab is named, or as soon as a real file is
    // open (its name + dirty dot are worth the row).
    const showBar =
      this.tabs.length >= 2 || this.tabs.some((t) => t.customName || t.kind === "file");
    this.tabBar.classList.toggle("hidden", !showBar);
    this.tabBar.innerHTML = "";

    // Tabs currently visible in a leaf get a marker; the focused one is active.
    const shown = new Set(this.split.leaves.map((l) => l.tabId));

    for (const tab of this.tabs) {
      const el = document.createElement("div");
      const dirty = tab.kind === "file" && this.isDirty(tab);
      el.className =
        "tab" +
        (tab.id === this.focusedId ? " active" : "") +
        (shown.has(tab.id) ? " shown" : "") +
        (dirty ? " dirty" : "");

      // Close button sits absolutely on the left and appears on hover/active,
      // so the centered label never shifts (the macOS Finder/Safari pattern).
      // For a dirty file it shows a filled dot at rest, ✕ on hover.
      const close = document.createElement("button");
      close.className = "tab-close";
      close.setAttribute("aria-label", "Close tab");
      close.title = "Close tab";
      close.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.requestClose(tab.id);
      });
      el.appendChild(close);

      const label = document.createElement("span");
      label.className = "tab-label";
      const title = this.titleFor(tab);
      label.textContent = title;
      label.title = tab.kind === "file" && tab.path ? tab.path : title;
      el.appendChild(label);

      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.split.showTab(tab.id);
      });
      // Double-click a scratch label to rename it; file tabs are named by path.
      if (tab.kind === "scratch") {
        el.addEventListener("dblclick", (e) => {
          e.preventDefault();
          this.onRenameRequest?.(tab.id);
        });
      }
      this.tabBar.appendChild(el);
    }

    // New-tab button, sitting just after the last tab.
    const add = document.createElement("button");
    add.className = "tab-add";
    add.setAttribute("aria-label", "New tab");
    add.title = "New tab (⌘T)";
    add.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.newTab();
    });
    this.tabBar.appendChild(add);
  }

  /** Refresh tab titles (call after a script mutates the active document). */
  refreshTitles(): void {
    this.render();
  }
}

/** Outcome of a save attempt (see saveFocused / saveFocusedAs). */
export type SaveOutcome =
  | { kind: "saved"; name: string }
  | { kind: "clean" }
  | { kind: "needsPath"; suggested: string }
  | { kind: "error"; message: string };
