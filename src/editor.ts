// CodeMirror 6 editor wrapper.
//
// ARCHITECTURE NOTE: each EditorPane owns one independent EditorView. Tabs and
// windows will each instantiate their own pane — there is no shared editor whose
// state gets swapped on tab switch. That shared-editor/state-swap pattern is
// exactly what broke text input in the original Boop when adding tabs/windows;
// CodeMirror state lives entirely in the DOM subtree, so independent panes
// cannot corrupt each other's input handling.

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { detect, loadLanguage, type LangName } from "./languages";
import {
  clearHighlights as clearTermHighlights,
  interestingWords,
  toggleHighlight as toggleTermHighlight,
} from "./highlight";
import { editorContextMenu } from "./context-menu";

/** Above this document size (characters), syntax highlighting is disabled and
 *  the buffer renders as plain text — keeps large files snappy. */
const MAX_HIGHLIGHT_CHARS = 1_000_000;

/** Theme is reconfigured live (no editor rebuild) so dark/light follows the OS. */
function themeFor(dark: boolean): Extension {
  return dark ? oneDark : [];
}

// Brand-coloured editor surfaces, loaded after the theme compartment so they
// override oneDark / the default light theme. Everything derives from the
// --theme CSS var (see styles.css), so the editor tracks the app's hue.
//
// Two greens that must stay distinguishable: the current-line highlight is a
// faint, full-width *wash* (ambient — "you are here"), while the selection is a
// stronger, more saturated *block* (deliberate — "you picked this"). Same hue,
// different weight, so they read as one family yet never blur together.
//
// The active line is also gated on focus: CodeMirror keeps `.cm-activeLine`
// decorated even when blurred, so an idle split pane would otherwise show a
// line bar and look active. We blank it by default and only paint it under
// `.cm-focused`.
const editorTheme = EditorView.theme({
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused .cm-activeLine": { backgroundColor: "var(--active-line)" },
  "&.cm-focused .cm-activeLineGutter": { backgroundColor: "var(--active-line-gutter)" },
  ".cm-selectionBackground": { backgroundColor: "var(--selection)" },
  // Match the default theme's exact selector chain (0,5,0 specificity) or the
  // built-in focused-selection colour wins and the selection stays lavender.
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--selection-focused)",
  },
  "::selection": { backgroundColor: "var(--selection-focused)" },
});

export class EditorPane {
  readonly view: EditorView;
  readonly dom: HTMLElement;
  private readonly theme = new Compartment();
  private readonly language = new Compartment();

  /** Selected mode: "auto" detects from content; anything else is locked. */
  private modeName: LangName = "auto";
  /** Concrete language currently applied (for skipping redundant reconfigs). */
  private appliedLang: LangName | null = null;
  private detectTimer: number | undefined;

  /** Called when the effective language changes, so the picker can refresh. */
  onLanguageChange: (() => void) | null = null;

  /** Called on every user/programmatic doc edit, so the tab layer can update
   *  the dirty marker and schedule a scratch autosave. */
  onDocChange: (() => void) | null = null;

  constructor(
    parent: HTMLElement,
    dark: boolean,
    extraKeymap: Parameters<typeof keymap.of>[0] = [],
  ) {
    // Each pane gets its own host element so panes can be shown/hidden by
    // toggling display, never by tearing down and rebuilding the editor.
    this.dom = document.createElement("div");
    this.dom.className = "editor-pane";
    parent.appendChild(this.dom);

    const extensions: Extension[] = [
      basicSetup,
      this.theme.of(themeFor(dark)),
      this.language.of([]),
      EditorView.lineWrapping,
      // Re-detect on edits while in auto mode (debounced); always notify the
      // tab layer so dirty/autosave can react.
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        if (this.modeName === "auto") this.scheduleDetect();
        this.onDocChange?.();
      }),
      keymap.of(extraKeymap),
      editorTheme,
      // Multi-colour "interesting words" highlighting (vim-interestingwords).
      interestingWords(),
      // Custom right-click menu (replaces the native one) with editing actions
      // plus the highlight-colour swatches.
      editorContextMenu(),
    ];
    this.view = new EditorView({
      state: EditorState.create({ doc: "", extensions }),
      parent: this.dom,
    });
  }

  get mode(): LangName {
    return this.modeName;
  }

  /** The concrete language being highlighted right now (resolves "auto"). */
  get effectiveLanguage(): LangName {
    return this.appliedLang ?? "text";
  }

  setMode(name: LangName): void {
    this.modeName = name;
    void this.applyEffectiveLanguage();
  }

  private scheduleDetect(): void {
    if (this.detectTimer) clearTimeout(this.detectTimer);
    this.detectTimer = window.setTimeout(() => void this.applyEffectiveLanguage(), 350);
  }

  private async applyEffectiveLanguage(): Promise<void> {
    // Performance guard: above ~1 MB, render as plain text regardless of mode or
    // extension. Tokenising multi-MB buffers (especially the legacy stream modes
    // — shell/lua/elisp — which parse line-by-line) is what makes a big file feel
    // sluggish; a scratchpad must stay snappy. `doc.length` is O(1), so the check
    // itself costs nothing and we never even materialise the string for big docs.
    const tooBig = this.view.state.doc.length > MAX_HIGHLIGHT_CHARS;
    const target: LangName = tooBig
      ? "text"
      : this.modeName === "auto"
        ? detect(this.fullText)
        : this.modeName;
    if (target === this.appliedLang) return;
    this.appliedLang = target;
    const ext = target === "text" ? [] : await loadLanguage(target);
    // Guard against a later detection having superseded this async load.
    if (this.appliedLang !== target) return;
    this.view.dispatch({ effects: this.language.reconfigure(ext) });
    this.onLanguageChange?.();
  }

  setTheme(dark: boolean): void {
    this.view.dispatch({ effects: this.theme.reconfigure(themeFor(dark)) });
  }

  setVisible(visible: boolean): void {
    this.dom.style.display = visible ? "" : "none";
  }

  get fullText(): string {
    return this.view.state.doc.toString();
  }

  /** Selected text, or null when the selection is empty (Boop semantics). */
  get selection(): string | null {
    const r = this.view.state.selection.main;
    return r.empty ? null : this.view.state.sliceDoc(r.from, r.to);
  }

  /** Caret offset, used as Boop's insert index. */
  get insertIndex(): number {
    return this.view.state.selection.main.from;
  }

  /** Replaces either the selection or the whole document, preserving Boop's model. */
  apply(text: string): void {
    const sel = this.view.state.selection.main;
    if (!sel.empty) {
      this.view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from, head: sel.from + text.length },
      });
    } else {
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: text },
      });
    }
  }

  /** Replace the whole document outright (loading a file opened from Finder).
   *  Unlike `apply`, this never touches the selection model — it's a load, not
   *  a Boop transform. The caret lands at the start of the freshly-loaded doc. */
  setContent(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor: 0 },
    });
  }

  /** Toggle the "interesting words" highlight for the current selection: colour
   *  every occurrence of the selected text, or uncolour it if already lit. A
   *  no-op when the selection is empty or spans multiple lines. */
  toggleHighlight(): void {
    const sel = this.selection;
    if (sel) toggleTermHighlight(this.view, sel);
  }

  /** Remove every "interesting words" highlight in this pane. */
  clearHighlights(): void {
    clearTermHighlights(this.view);
  }

  /** Select a range and scroll it into view — used by global search to jump to
   *  a hit. Offsets are clamped to the current doc length for safety. */
  revealRange(from: number, to: number): void {
    const len = this.view.state.doc.length;
    const a = Math.max(0, Math.min(from, len));
    const b = Math.max(0, Math.min(to, len));
    this.view.dispatch({ selection: { anchor: a, head: b }, scrollIntoView: true });
    this.view.focus();
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
    this.dom.remove();
  }
}
