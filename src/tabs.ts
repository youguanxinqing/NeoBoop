// Tab manager + split layout host.
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

import { EditorPane } from "./editor";
import { SplitTree, type Axis, type Direction } from "./split";

interface Tab {
  id: number;
  pane: EditorPane;
  title: string;
  /** User-set name (⌘S). Overrides the first-line auto-title. Session-only. */
  customName?: string;
}

export class TabManager {
  private tabs: Tab[] = [];
  private nextId = 1;
  private dark: boolean;

  /** Parking lot for panes whose tab is not currently shown in any leaf. */
  private readonly holder: HTMLElement;
  private split!: SplitTree;
  private focusedId = -1;

  /** Fires when the focused tab/pane changes, so UI bound to it (e.g. the
   *  language picker in the status bar) can refresh. */
  onFocusChange: (() => void) | null = null;

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
    };
    this.reconcile();
    this.focused.focus();
  }

  // ---- tab lifecycle ------------------------------------------------------

  /** Create a tab + pane, parked in the holder. Does not show it anywhere. */
  private createTab(): Tab {
    const pane = new EditorPane(this.holder, this.dark);
    const tab: Tab = { id: this.nextId++, pane, title: this.untitledName() };
    this.tabs.push(tab);
    return tab;
  }

  /** New tab, shown in the focused leaf (the macOS "new tab in this pane" feel). */
  newTab(): void {
    const tab = this.createTab();
    this.split.showTab(tab.id);
    this.focused.focus();
  }

  /** Close a tab: destroy its document and collapse the pane showing it. */
  closeTab(id?: number): void {
    const targetId = id ?? this.focusedId;
    const idx = this.tabs.findIndex((t) => t.id === targetId);
    if (idx === -1) return;

    const [removed] = this.tabs.splice(idx, 1);
    // Collapse the leaf showing it. Returns false only for the lone root leaf,
    // which can't collapse — we re-point it at a replacement below.
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
  }

  /** Cycle which tab the focused leaf shows (⌘⇧[ / ⌘⇧]). */
  switchBy(delta: number): void {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.findIndex((t) => t.id === this.focusedId);
    const next = (idx + delta + this.tabs.length) % this.tabs.length;
    this.split.showTab(this.tabs[next].id);
  }

  // ---- split commands -----------------------------------------------------

  /** Split the focused pane; the new pane gets a fresh scratch tab. */
  splitPane(axis: Axis): void {
    const tab = this.createTab();
    this.split.split(axis, tab.id);
    this.focused.focus();
  }

  /** Close the focused pane, collapsing the split — its tab survives, parked
   *  in the holder and still listed in the tab bar. No-op when not split. */
  closePane(): void {
    if (this.split.closeFocused()) this.focused.focus();
  }

  focusDir(dir: Direction): void {
    this.split.navigate(dir);
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
    return firstLine ? firstLine.slice(0, 24) : tab.title;
  }

  /** Title shown in the tab: the user-set name (⌘S) wins over the auto title. */
  private titleFor(tab: Tab): string {
    return tab.customName ?? this.autoTitleFor(tab);
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

  /** Set (or, with an empty string, clear) the focused tab's name. ⌘S. */
  renameFocused(name: string): void {
    const tab = this.focusedTab();
    if (!tab) return;
    const trimmed = name.trim();
    tab.customName = trimmed || undefined;
    this.render();
    this.focused.focus();
  }

  private untitledName(): string {
    return `Untitled ${this.tabs.length + 1}`;
  }

  private render(): void {
    // A single tab adds only chrome noise — hide the bar until there are 2+.
    // Exception: once a tab is named (⌘S), show the bar so the name is visible.
    const showBar = this.tabs.length >= 2 || this.tabs.some((t) => t.customName);
    this.tabBar.classList.toggle("hidden", !showBar);
    this.tabBar.innerHTML = "";

    // Tabs currently visible in a leaf get a marker; the focused one is active.
    const shown = new Set(this.split.leaves.map((l) => l.tabId));

    for (const tab of this.tabs) {
      const el = document.createElement("div");
      el.className =
        "tab" +
        (tab.id === this.focusedId ? " active" : "") +
        (shown.has(tab.id) ? " shown" : "");

      // Close button sits absolutely on the left and appears on hover/active,
      // so the centered label never shifts (the macOS Finder/Safari pattern).
      const close = document.createElement("button");
      close.className = "tab-close";
      close.setAttribute("aria-label", "Close tab");
      close.title = "Close tab";
      close.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.closeTab(tab.id);
      });
      el.appendChild(close);

      const label = document.createElement("span");
      label.className = "tab-label";
      const title = this.titleFor(tab);
      label.textContent = title;
      label.title = title;
      el.appendChild(label);

      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.split.showTab(tab.id);
      });
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
