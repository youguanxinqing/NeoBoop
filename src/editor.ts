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

/** Theme is reconfigured live (no editor rebuild) so dark/light follows the OS. */
function themeFor(dark: boolean): Extension {
  return dark ? oneDark : [];
}

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
      // Re-detect on edits while in auto mode (debounced).
      EditorView.updateListener.of((u) => {
        if (u.docChanged && this.modeName === "auto") this.scheduleDetect();
      }),
      keymap.of(extraKeymap),
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
    const target: LangName = this.modeName === "auto" ? detect(this.fullText) : this.modeName;
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

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
    this.dom.remove();
  }
}
