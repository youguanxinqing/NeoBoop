// "Interesting words" — vim-interestingwords-style multi-colour highlighting.
//
// DESIGN: term-based, NOT range-based. We persist only the *set* of highlighted
// strings (term → colour index), never the matched ranges. A ViewPlugin derives
// Decoration marks for the visible viewport on demand via MatchDecorator. Two
// consequences, both deliberate:
//
//   * Performance is bounded by screen size, not document size. Highlighting
//     "the" in a 10 MB file decorates the ~80 visible lines, not the 200k
//     occurrences in the buffer — MatchDecorator only scans viewport ranges and
//     updates incrementally on scroll/edit (the same trick CM's own search-match
//     highlighter uses).
//
//   * Un-highlighting is O(1). To uncolour a word we drop one key from the map;
//     there are no stored ranges to find, filter, or re-map. clearAll() just
//     empties the map. The next viewport derivation simply stops matching it.
//     This is the answer to "how do we uncolor fast" — the ranges were never
//     materialised, so removal costs nothing.
//
// The term map lives in a StateField, so it travels with each pane's EditorState
// through tab switches and splits for free, and (being effect-only) stays out of
// undo history — toggling a highlight is not an undoable edit.

import { StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { getPaletteColors, hexToWash } from "./palette";

/** term → highlight colour (#rrggbb). Storing the concrete colour (not an index
 *  into the palette) means existing highlights survive a palette edit unchanged
 *  and rendering needs no static CSS classes. */
type TermMap = ReadonlyMap<string, string>;

// A single effect carrying the whole next map keeps the field trivial; the
// toggle/clear *logic* lives in the exported helpers below, computed from the
// current state. (Replacing the map wholesale is cheap — it holds a handful of
// terms, never ranges.)
const setTerms = StateEffect.define<TermMap>();

const termField = StateField.define<TermMap>({
  create: () => new Map(),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setTerms)) return e.value;
    return value;
  },
});

/** Pick a random preset colour the document isn't already using; once every
 *  preset is in use, pick a random one outright (reuse rather than fail). Reads
 *  the user's configured palette fresh, so Preferences edits take effect at once. */
function nextColor(terms: TermMap): string {
  const palette = getPaletteColors();
  const used = new Set(terms.values());
  const free = palette.filter((c) => !used.has(c));
  const pool = free.length ? free : palette;
  return pool[Math.floor(Math.random() * pool.length)];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A selection is "interesting" if it's a non-empty single-line run. Multi-line
 *  selections are skipped: they aren't words, and multi-line regex matching is a
 *  known MatchDecorator pitfall. Whitespace-only selections are skipped too. */
export function isHighlightable(term: string): boolean {
  return term.length > 0 && !term.includes("\n") && term.trim().length > 0;
}

/** Toggle the highlight for `term`: colour it if absent, uncolour it if present. */
export function toggleHighlight(view: EditorView, term: string): void {
  if (!isHighlightable(term)) return;
  const cur = view.state.field(termField);
  const next = new Map(cur);
  if (next.has(term)) next.delete(term);
  else next.set(term, nextColor(cur));
  view.dispatch({ effects: setTerms.of(next) });
}

/** Remove every highlight in this pane. Instant — just empties the map. */
export function clearHighlights(view: EditorView): void {
  if (view.state.field(termField).size === 0) return;
  view.dispatch({ effects: setTerms.of(new Map()) });
}

/** Current term → colour map (read-only). Useful for a context menu to show
 *  which terms are lit and let the user uncolour a specific one. */
export function highlightedTerms(view: EditorView): TermMap {
  return view.state.field(termField);
}

// Build a MatchDecorator from the term set. One escaped alternation, longest
// term first so overlapping terms prefer the longer match; the matched text
// equals one literal term exactly, so terms.get(match[0]) recovers its colour.
// Decorations are precomputed once per distinct colour (stable objects), then
// looked up per match — the wash is an inline background so any user-chosen hex
// works without a matching CSS class.
function buildMatcher(terms: TermMap): MatchDecorator | null {
  if (terms.size === 0) return null;
  const decoFor = new Map<string, Decoration>();
  for (const hex of terms.values()) {
    if (!decoFor.has(hex)) {
      decoFor.set(hex, Decoration.mark({ class: "cm-iw", attributes: { style: `background-color:${hexToWash(hex)}` } }));
    }
  }
  const alts = [...terms.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  return new MatchDecorator({
    regexp: new RegExp(alts.join("|"), "g"),
    decoration: (m) => decoFor.get(terms.get(m[0]) as string) ?? null,
  });
}

const highlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private matcher: MatchDecorator | null;

    constructor(view: EditorView) {
      this.matcher = buildMatcher(view.state.field(termField));
      this.decorations = this.matcher ? this.matcher.createDeco(view) : Decoration.none;
    }

    update(u: ViewUpdate): void {
      const termsChanged = u.startState.field(termField) !== u.state.field(termField);
      if (termsChanged) {
        // Term set changed: rebuild the matcher and re-derive from scratch.
        this.matcher = buildMatcher(u.state.field(termField));
        this.decorations = this.matcher ? this.matcher.createDeco(u.view) : Decoration.none;
      } else if (this.matcher && (u.docChanged || u.viewportChanged)) {
        // Same terms, but the doc or viewport moved: incremental viewport update.
        this.decorations = this.matcher.updateDeco(u, this.decorations);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** The full extension: term store + viewport-bounded decorator. Add once per pane. */
export function interestingWords(): Extension {
  return [termField, highlightPlugin];
}
