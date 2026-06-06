// Custom editor right-click menu.
//
// The native WKWebView selection menu (Look Up / Translate / Search / Cut-Copy-
// Paste / Spelling …) cannot be EXTENDED — WKWebView exposes no API to inject an
// item into it. So to put a "Highlight" action in the right-click menu we
// preventDefault the native one and render our own. That means re-providing the
// editing actions ourselves (Cut/Copy/Paste/Select All); the macOS-only services
// (Look Up/Translate) are the accepted cost of owning the menu.
//
// Scoped per-view via EditorView.domEventHandlers, so the handler always gets the
// exact pane that was clicked — correct under splits without a DOM→pane registry.

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import {
  clearHighlights,
  highlightedTerms,
  isHighlightable,
  toggleHighlight,
} from "./highlight";

let menuEl: HTMLElement | null = null;
let teardown: (() => void) | null = null;

function ensureMenu(): HTMLElement {
  if (menuEl) return menuEl;
  const el = document.createElement("div");
  el.className = "ctxmenu hidden";
  el.setAttribute("role", "menu");
  document.body.appendChild(el);
  menuEl = el;
  return el;
}

function closeMenu(): void {
  if (menuEl) menuEl.classList.add("hidden");
  teardown?.();
  teardown = null;
}

/** The term to act on: the selection if it's highlightable, else the word under
 *  the click point (vim-interestingwords highlights the word under the cursor
 *  when nothing is selected). Null when neither yields a highlightable run. */
function termAt(view: EditorView, event: MouseEvent): string | null {
  const sel = view.state.selection.main;
  if (!sel.empty) {
    const t = view.state.sliceDoc(sel.from, sel.to);
    if (isHighlightable(t)) return t;
  }
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos != null) {
    const w = view.state.wordAt(pos);
    if (w) {
      const t = view.state.sliceDoc(w.from, w.to);
      if (isHighlightable(t)) return t;
    }
  }
  return null;
}

// ---- editing actions (we own the menu, so we own these) -------------------

function copy(view: EditorView): void {
  const sel = view.state.selection.main;
  if (!sel.empty) void navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to));
}

function cut(view: EditorView): void {
  const sel = view.state.selection.main;
  if (sel.empty) return;
  void navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to));
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert: "" }, selection: { anchor: sel.from } });
}

async function paste(view: EditorView): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) view.dispatch(view.state.replaceSelection(text));
  } catch {
    // Clipboard read unavailable — ⌘V still works through the native path.
  }
}

function selectAll(view: EditorView): void {
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
}

// ---- menu construction -----------------------------------------------------

function item(label: string, shortcut: string, enabled: boolean, run: () => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "ctxmenu-item" + (enabled ? "" : " disabled");
  el.setAttribute("role", "menuitem");
  const l = document.createElement("span");
  l.textContent = label;
  el.appendChild(l);
  if (shortcut) {
    const s = document.createElement("span");
    s.className = "ctxmenu-key";
    s.textContent = shortcut;
    el.appendChild(s);
  }
  if (enabled) {
    el.addEventListener("mousedown", (e) => e.preventDefault()); // keep editor focus
    el.addEventListener("click", () => {
      run();
      closeMenu();
    });
  }
  return el;
}

function separator(): HTMLElement {
  const el = document.createElement("div");
  el.className = "ctxmenu-sep";
  return el;
}

function build(view: EditorView, term: string | null): void {
  const el = ensureMenu();
  el.replaceChildren();
  const hasSel = !view.state.selection.main.empty;
  const lit = term != null && highlightedTerms(view).has(term);
  const shown = term ? `“${term.length > 24 ? term.slice(0, 24) + "…" : term}”` : "";

  el.append(
    item("Cut", "⌘X", hasSel, () => { cut(view); view.focus(); }),
    item("Copy", "⌘C", hasSel, () => { copy(view); view.focus(); }),
    item("Paste", "⌘V", true, () => { void paste(view).then(() => view.focus()); }),
    item("Select All", "⌘A", view.state.doc.length > 0, () => { selectAll(view); view.focus(); }),
    separator(),
    // One "Highlight" action — the system picks a random unused colour. No
    // colour picker: enabled only when there's a highlightable term that isn't
    // already lit; removal is the separate item below.
    item(`Highlight${shown ? " " + shown : ""}`, "⌘⇧H", term != null && !lit, () => {
      if (term) toggleHighlight(view, term);
      view.focus();
    }),
    item("Remove Highlight", "", lit, () => { if (term) toggleHighlight(view, term); view.focus(); }),
    item("Clear All Highlights", "⌘⇧K", highlightedTerms(view).size > 0, () => { clearHighlights(view); view.focus(); }),
  );
}

function position(el: HTMLElement, x: number, y: number): void {
  const r = el.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function openMenu(view: EditorView, event: MouseEvent): void {
  event.preventDefault();
  closeMenu(); // collapse any prior instance first
  build(view, termAt(view, event));
  const el = ensureMenu();
  el.classList.remove("hidden");
  position(el, event.clientX, event.clientY);

  const onDown = (e: MouseEvent) => { if (!el.contains(e.target as Node)) closeMenu(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeMenu(); };
  const onScroll = () => closeMenu();
  // Defer wiring so this very contextmenu event doesn't immediately dismiss it.
  window.setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    view.scrollDOM.addEventListener("scroll", onScroll, true);
  }, 0);
  teardown = () => {
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScroll, true);
    view.scrollDOM.removeEventListener("scroll", onScroll, true);
  };
}

/** Replace the native right-click menu in the editor with our own. Add per pane. */
export function editorContextMenu(): Extension {
  return EditorView.domEventHandlers({
    contextmenu: (event, view) => {
      openMenu(view, event);
      return true;
    },
  });
}
