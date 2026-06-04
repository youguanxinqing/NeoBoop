// Tab manager.
//
// THE WHOLE POINT: every tab owns a fully independent EditorPane that stays
// alive for the tab's entire lifetime. Switching tabs only toggles which pane
// is visible — no shared editor, no state-swap, no responder/field-editor
// reattachment. This is the structural fix for the input-dies-on-tab-switch
// bug that plagued the native Boop.

import { EditorPane } from "./editor";

interface Tab {
  id: number;
  pane: EditorPane;
  title: string;
}

export class TabManager {
  private tabs: Tab[] = [];
  private activeId = -1;
  private nextId = 1;
  private dark: boolean;

  /** Fires when the active tab changes, so UI bound to it (e.g. the language
   *  picker) can refresh. */
  onActiveChange: (() => void) | null = null;

  constructor(
    private readonly tabBar: HTMLElement,
    private readonly editorHost: HTMLElement,
    dark: boolean,
  ) {
    this.dark = dark;
  }

  get active(): EditorPane {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    // A TabManager always has at least one tab after init().
    return tab!.pane;
  }

  init(): void {
    this.newTab();
  }

  newTab(): void {
    const pane = new EditorPane(this.editorHost, this.dark);
    const tab: Tab = { id: this.nextId++, pane, title: this.untitledName() };
    this.tabs.push(tab);
    this.activate(tab.id);
  }

  closeTab(id?: number): void {
    const targetId = id ?? this.activeId;
    const idx = this.tabs.findIndex((t) => t.id === targetId);
    if (idx === -1) return;

    const [removed] = this.tabs.splice(idx, 1);
    removed.pane.destroy();

    if (this.tabs.length === 0) {
      // Never leave the window editor-less; open a fresh tab.
      this.newTab();
      return;
    }
    if (this.activeId === targetId) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activate(next.id);
    } else {
      this.render();
    }
  }

  activate(id: number): void {
    this.activeId = id;
    for (const tab of this.tabs) tab.pane.setVisible(tab.id === id);
    this.render();
    this.active.focus();
    this.onActiveChange?.();
  }

  switchBy(delta: number): void {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeId);
    const next = (idx + delta + this.tabs.length) % this.tabs.length;
    this.activate(this.tabs[next].id);
  }

  setTheme(dark: boolean): void {
    this.dark = dark;
    for (const tab of this.tabs) tab.pane.setTheme(dark);
  }

  /** Title shown in the tab; falls back to a snippet of the content. */
  private titleFor(tab: Tab): string {
    const firstLine = tab.pane.fullText.split("\n", 1)[0].trim();
    return firstLine ? firstLine.slice(0, 24) : tab.title;
  }

  private untitledName(): string {
    return `Untitled ${this.tabs.length + 1}`;
  }

  private render(): void {
    // A single tab adds only chrome noise — hide the bar until there are 2+.
    this.tabBar.classList.toggle("hidden", this.tabs.length < 2);
    this.tabBar.innerHTML = "";

    for (const tab of this.tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (tab.id === this.activeId ? " active" : "");

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
        this.activate(tab.id);
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
    if (this.tabs.length >= 2) this.render();
  }
}
