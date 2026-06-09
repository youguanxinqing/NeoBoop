// Emacs-style chords that must live INSIDE CodeMirror's keymap, not in a global
// window listener.
//
// WHY: in WKWebView a window-level (capture-phase) keydown handler that calls
// preventDefault() does NOT reliably stop the editor from inserting the key —
// the printable second key of a chord leaks in (the "[" of ⌃X [, the "√" of ⌥V).
// Pressing the chord with Ctrl held never leaked because a control combo emits no
// character; releasing Ctrl (true Emacs style) and pressing a bare "[" did. The
// fix is to let CodeMirror consume the key in its OWN input pipeline (target
// phase), where returning true from a binding reliably suppresses insertion.
//
// App-level actions (global search, pane ops, status line) are injected via
// `paneCommands` so this module needn't import main.ts (which would be circular).

import { EditorView, keymap, type KeyBinding } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";

export const paneCommands = {
  openGlobalSearch: () => {},
  closePane: () => {},
  closeOtherPanes: () => {},
  setStatus: (_msg: string, _kind: "info" | "error" | "idle") => {},
};

// ⌃X prefix, shared across panes (only one editor is focused at a time). After
// ⌃X we wait briefly for the second key; the timeout disarms it on its own.
// `armedView` is the editor ⌃X was pressed in — needed by the IME path below,
// which fires on a `beforeinput` and so doesn't get a view passed to it.
let prefixArmed = false;
let prefixTimer: number | undefined;
let armedView: EditorView | null = null;
function endPrefix(): void {
  prefixArmed = false;
  armedView = null;
  if (prefixTimer) clearTimeout(prefixTimer);
  prefixTimer = undefined;
  paneCommands.setStatus("", "idle");
}
function beginPrefix(): void {
  prefixArmed = true;
  paneCommands.setStatus("⌃X-  ⌃F search all · 0 close pane · 1 close others · [ top · ] end", "info");
  if (prefixTimer) clearTimeout(prefixTimer);
  prefixTimer = window.setTimeout(endPrefix, 1800);
}

// Scroll by half the viewport, dragging the caret along so it keeps its screen
// position (Emacs ⌃V / ⌥V, but half a screen).
function scrollHalf(view: EditorView, down: boolean): boolean {
  const scroller = view.scrollDOM;
  const dist = Math.max(view.defaultLineHeight, scroller.clientHeight / 2);
  const delta = down ? dist : -dist;
  const head = view.state.selection.main.head;
  const here = view.coordsAtPos(head);
  if (here) {
    const pos = view.posAtCoords({ x: here.left, y: (here.top + here.bottom) / 2 + delta }, false);
    view.dispatch({ selection: { anchor: pos } });
  }
  scroller.scrollTop += delta;
  return true;
}
// Caret to the very start / end of the document (Emacs ⌃X [ / ⌃X ]).
function jumpTo(view: EditorView, end: boolean): boolean {
  view.dispatch({ selection: { anchor: end ? view.state.doc.length : 0 }, scrollIntoView: true });
  return true;
}

// A ⌃X second-key binding acts only while the prefix is armed; otherwise it
// declines (returns false) so the key types normally — CodeMirror falls through
// to its default input handling.
function afterPrefix(action: (v: EditorView) => void) {
  return (v: EditorView): boolean => {
    if (!prefixArmed) return false;
    endPrefix();
    action(v);
    return true;
  };
}

const bindings: KeyBinding[] = [
  { key: "Ctrl-x", preventDefault: true, run: (v) => ((armedView = v), beginPrefix(), true) },
  // ⌃V down — overrides CodeMirror's default full-page cursorPageDown.
  { key: "Ctrl-v", preventDefault: true, run: (v) => scrollHalf(v, true) },
  { key: "Ctrl-f", run: afterPrefix(() => paneCommands.openGlobalSearch()) },
];
// Each ⌃X second key is bound twice: bare (Ctrl released — Emacs style) and with
// Ctrl still held, so both ways of typing the chord work.
const second: Array<[string, (v: EditorView) => void]> = [
  ["0", () => paneCommands.closePane()],
  ["1", () => paneCommands.closeOtherPanes()],
  ["[", (v) => void jumpTo(v, false)],
  ["]", (v) => void jumpTo(v, true)],
];
for (const [k, action] of second) {
  bindings.push({ key: k, run: afterPrefix(action) });
  bindings.push({ key: `Ctrl-${k}`, run: afterPrefix(action) });
}

// Any unrecognised key abandons the prefix (Emacs behaviour). Lowest precedence
// so the recognised second keys get first refusal; never consumes the key.
const abandon: KeyBinding[] = [
  {
    any: () => {
      if (prefixArmed) endPrefix();
      return false;
    },
  },
];

// ⌥V (half-page up) can't be a keymap `key` on macOS: Option composes "√" and
// CodeMirror deliberately skips the physical-key fallback for Alt-only combos.
// Match it by physical code in a dom handler — it still runs inside CodeMirror's
// input pipeline, so returning true suppresses the "√". (⌥V isn't bound by
// CodeMirror's default keymap, so nothing consumes it before this handler.)
const altV = EditorView.domEventHandlers({
  keydown: (e, view) =>
    e.code === "KeyV" && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey ? scrollHalf(view, false) : false,
});

export const paneChords: Extension = [
  Prec.highest(keymap.of(bindings)),
  Prec.lowest(keymap.of(abandon)),
  altV,
];

// IME path. With a CJK input method active, the second key never arrives as a
// matchable keydown — CodeMirror ignores keydowns during composition, and the
// IME inserts the character (often a fullwidth variant: [→「, ]→」) via a
// `beforeinput` instead. ⌃X is a control combo the IME leaves alone, so it still
// arms the prefix through the keymap above; here we catch the *inserted* second
// key. Gated on `prefixArmed`, this never touches ordinary typing. Capture-phase
// + stopImmediatePropagation keeps the char from ever reaching CodeMirror.
const OPEN = new Set(["[", "「", "［", "【"]);
const CLOSE = new Set(["]", "」", "］", "】"]);
const CLOSE_PANE = new Set(["0", "０"]);
const CLOSE_OTHERS = new Set(["1", "１"]);
window.addEventListener(
  "beforeinput",
  (e) => {
    if (!prefixArmed) return;
    const data = (e as InputEvent).data;
    if (data == null) return; // deletions / non-text input — not a chord key
    const view = armedView;
    // An armed prefix consumes the next key whatever it is (Emacs: it's a
    // command, not text). Recognised keys act and swallow the insert; anything
    // else just abandons the prefix and types normally.
    let acted = true;
    if (view && OPEN.has(data)) jumpTo(view, false);
    else if (view && CLOSE.has(data)) jumpTo(view, true);
    else if (CLOSE_PANE.has(data)) paneCommands.closePane();
    else if (CLOSE_OTHERS.has(data)) paneCommands.closeOtherPanes();
    else acted = false;
    endPrefix();
    if (acted) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true,
);
