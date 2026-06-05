// Recursive split-pane layout — a binary (n-ary) split tree, the model Vim
// windows and Zed panes use.
//
// WHY A TREE, NOT EDITOR-GROUPS: each leaf shows exactly one tab (one editor per
// pane), and there is a single global tab bar — we deliberately did NOT adopt
// VS Code's "every group owns its own tab strip" model. Splitting the focused
// leaf in a direction subdivides it, and repeated splits compose into arbitrary
// grids (two columns, 2×2, …) for free.
//
// IRON RULE PRESERVED: this module never touches EditorView state. Leaf slot
// elements are persistent — a tab's pane DOM lives inside its leaf's slot, so
// reparenting a leaf (when it gets wrapped in a new branch) carries the editor
// along as a plain DOM move. The CodeMirror view object is never rebuilt or
// state-swapped; that shared-editor pattern is what broke input in native Boop.
//
// There is no shared-buffer / same-document-in-two-views feature on purpose: a
// DOM node lives in one place, so a tab is shown in at most one leaf. For a
// scratchpad the useful split is two *independent* buffers side by side, which
// this gives us without crossing the iron rule.

export type Axis = "row" | "column";
export type Direction = "left" | "right" | "up" | "down";

/** Minimum on-screen size of a pane, in px — drag can't shrink past this. */
const MIN_PANE_PX = 90;
/** Thickness of a divider's reserved track, in px — a 1px hairline (the wider
 *  drag zone is a transparent ::before that doesn't take layout space). Kept in
 *  sync with styles.css. */
const DIVIDER_PX = 1;

interface Leaf {
  kind: "leaf";
  tabId: number;
  el: HTMLElement;
  parent: Branch | null;
}
interface Branch {
  kind: "branch";
  axis: Axis;
  children: SplitNode[];
  /** flex-grow ratios, parallel to children; only relative magnitude matters. */
  sizes: number[];
  el: HTMLElement;
  parent: Branch | null;
}
type SplitNode = Leaf | Branch;

export class SplitTree {
  private root: SplitNode;
  private focused: Leaf;

  /** Fired when the focused leaf changes (click into a pane, split, close). */
  onFocusChange: ((tabId: number) => void) | null = null;
  /** Fired after any structural change, so the host can re-mount tab panes. */
  onLayoutChange: (() => void) | null = null;

  constructor(
    private readonly container: HTMLElement,
    initialTabId: number,
  ) {
    this.root = this.makeLeaf(initialTabId);
    this.focused = this.root;
    this.render();
  }

  // ---- queries ------------------------------------------------------------

  get focusedTabId(): number {
    return this.focused.tabId;
  }

  get isSplit(): boolean {
    return this.root.kind === "branch";
  }

  /** Every leaf, left-to-right / top-to-bottom (DOM order). */
  get leaves(): { tabId: number; el: HTMLElement; focused: boolean }[] {
    const out: { tabId: number; el: HTMLElement; focused: boolean }[] = [];
    const walk = (n: SplitNode): void => {
      if (n.kind === "leaf") out.push({ tabId: n.tabId, el: n.el, focused: n === this.focused });
      else n.children.forEach(walk);
    };
    walk(this.root);
    return out;
  }

  // ---- focus --------------------------------------------------------------

  private focusLeaf(leaf: Leaf): void {
    if (this.focused === leaf) return;
    this.focused = leaf;
    this.paintFocus();
    this.onFocusChange?.(leaf.tabId);
  }

  /** Move focus to the nearest leaf in a direction, geometrically. */
  navigate(dir: Direction): boolean {
    const leaves = this.allLeaves();
    if (leaves.length < 2) return false;
    const from = this.focused.el.getBoundingClientRect();
    const fromCx = from.left + from.width / 2;
    const fromCy = from.top + from.height / 2;

    let best: Leaf | null = null;
    let bestScore = Infinity;
    for (const leaf of leaves) {
      if (leaf === this.focused) continue;
      const r = leaf.el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // Must lie in the requested direction (with a small tolerance).
      const ok =
        (dir === "left" && r.left < from.left - 1) ||
        (dir === "right" && r.right > from.right + 1) ||
        (dir === "up" && r.top < from.top - 1) ||
        (dir === "down" && r.bottom > from.bottom + 1);
      if (!ok) continue;
      // Prefer the closest along the travel axis, penalise cross-axis drift.
      const along = dir === "left" || dir === "right" ? Math.abs(cx - fromCx) : Math.abs(cy - fromCy);
      const cross = dir === "left" || dir === "right" ? Math.abs(cy - fromCy) : Math.abs(cx - fromCx);
      const score = along + cross * 2;
      if (score < bestScore) {
        bestScore = score;
        best = leaf;
      }
    }
    if (!best) return false;
    this.focusLeaf(best);
    return true;
  }

  // ---- mutations ----------------------------------------------------------

  /** Show `tabId` in the focused leaf. If it is already shown elsewhere, focus
   *  that leaf instead (a tab lives in at most one pane). */
  showTab(tabId: number): void {
    const existing = this.allLeaves().find((l) => l.tabId === tabId);
    if (existing) {
      this.focusLeaf(existing);
      return;
    }
    this.focused.tabId = tabId;
    this.onLayoutChange?.();
    this.onFocusChange?.(tabId);
  }

  /** Split the focused leaf along `axis`; the new leaf shows `newTabId` and
   *  becomes focused. Inserts as a sibling when the parent already runs along
   *  the same axis (keeps grids flat), otherwise wraps the leaf in a branch. */
  split(axis: Axis, newTabId: number): void {
    const leaf = this.focused;
    const newLeaf = this.makeLeaf(newTabId);
    const parent = leaf.parent;

    if (parent && parent.axis === axis) {
      const i = parent.children.indexOf(leaf);
      const share = parent.sizes[i] / 2;
      parent.sizes[i] = share;
      parent.children.splice(i + 1, 0, newLeaf);
      parent.sizes.splice(i + 1, 0, share);
      newLeaf.parent = parent;
    } else {
      const branch = this.makeBranch(axis, [leaf, newLeaf], [1, 1]);
      branch.parent = parent;
      leaf.parent = branch;
      newLeaf.parent = branch;
      if (!parent) {
        this.root = branch;
      } else {
        const i = parent.children.indexOf(leaf);
        parent.children[i] = branch;
      }
    }
    this.focused = newLeaf;
    this.render();
    this.onLayoutChange?.();
    this.onFocusChange?.(newLeaf.tabId);
  }

  /** Remove the focused leaf from the layout (its tab survives, just hidden).
   *  No-op when there is only one leaf. Returns true if a pane was closed. */
  closeFocused(): boolean {
    return this.removeLeaf(this.focused);
  }

  /** Drop any leaf showing `tabId` — used when the tab itself is destroyed.
   *  Returns true if a leaf was actually collapsed (false for the lone root). */
  removeTab(tabId: number): boolean {
    const leaf = this.allLeaves().find((l) => l.tabId === tabId);
    return leaf ? this.removeLeaf(leaf) : false;
  }

  /** Equalise the sibling sizes of the focused leaf's branch. */
  equalizeFocused(): void {
    const parent = this.focused.parent;
    if (!parent) return;
    parent.sizes = parent.sizes.map(() => 1);
    this.applySizes(parent);
  }

  private removeLeaf(leaf: Leaf): boolean {
    const parent = leaf.parent;
    if (!parent) return false; // the lone root leaf — nothing to collapse.

    const i = parent.children.indexOf(leaf);
    parent.children.splice(i, 1);
    parent.sizes.splice(i, 1);

    // Pick the neighbour that inherits focus before we collapse anything.
    const neighbour = parent.children[Math.min(i, parent.children.length - 1)];

    if (parent.children.length === 1) {
      // A branch with one child is pointless — replace it with that child.
      const survivor = parent.children[0];
      const grand = parent.parent;
      survivor.parent = grand;
      if (!grand) {
        this.root = survivor;
      } else {
        const j = grand.children.indexOf(parent);
        grand.children[j] = survivor;
      }
    }
    this.focused = firstLeaf(neighbour);
    this.render();
    this.onLayoutChange?.();
    this.onFocusChange?.(this.focused.tabId);
    return true;
  }

  // ---- DOM construction ---------------------------------------------------

  private makeLeaf(tabId: number): Leaf {
    const el = document.createElement("div");
    el.className = "split-leaf";
    const leaf: Leaf = { kind: "leaf", tabId, el, parent: null };
    // focusin bubbles up from the CodeMirror editor mounted inside the slot, so
    // clicking or tabbing into any pane makes it the focused leaf for free.
    el.addEventListener("focusin", () => this.focusLeaf(leaf));
    el.addEventListener("mousedown", () => this.focusLeaf(leaf));
    return leaf;
  }

  private makeBranch(axis: Axis, children: SplitNode[], sizes: number[]): Branch {
    const el = document.createElement("div");
    el.className = `split-branch split-${axis}`;
    return { kind: "branch", axis, children, sizes: sizes.slice(), el, parent: null };
  }

  /** Rebuild the DOM to match the tree. Persistent leaf/branch elements are
   *  re-appended (moved, not recreated), so mounted editor panes ride along. */
  private render(): void {
    this.layoutNode(this.root);
    if (this.container.firstChild !== this.root.el || this.container.childNodes.length !== 1) {
      this.container.replaceChildren(this.root.el);
    }
    this.paintFocus();
  }

  private layoutNode(node: SplitNode): void {
    if (node.kind === "leaf") return;
    // Re-assemble this branch's children with dividers interleaved.
    const kids: Node[] = [];
    node.children.forEach((child, i) => {
      this.layoutNode(child);
      if (i > 0) kids.push(this.makeDivider(node, i - 1));
      kids.push(child.el);
    });
    node.el.replaceChildren(...kids);
    this.applySizes(node);
  }

  private applySizes(branch: Branch): void {
    branch.children.forEach((child, i) => {
      child.el.style.flex = `${branch.sizes[i]} ${branch.sizes[i]} 0`;
    });
  }

  private makeDivider(branch: Branch, leftIndex: number): HTMLElement {
    const d = document.createElement("div");
    d.className = `split-divider split-divider-${branch.axis}`;
    d.addEventListener("mousedown", (e) => this.beginDrag(e, branch, leftIndex));
    d.addEventListener("dblclick", () => {
      branch.sizes = branch.sizes.map(() => 1);
      this.applySizes(branch);
    });
    return d;
  }

  /** Drag a divider: shift flex weight between the two adjacent children only,
   *  leaving the rest of the row/column untouched. */
  private beginDrag(e: MouseEvent, branch: Branch, leftIndex: number): void {
    e.preventDefault();
    const horizontal = branch.axis === "row";
    const rect = branch.el.getBoundingClientRect();
    const flexSpace = (horizontal ? rect.width : rect.height) - DIVIDER_PX * (branch.children.length - 1);
    const a = leftIndex;
    const b = leftIndex + 1;
    const sumAB = branch.sizes[a] + branch.sizes[b];
    const totalGrow = branch.sizes.reduce((s, n) => s + n, 0);
    const pairPx = (sumAB / totalGrow) * flexSpace;
    const startPos = horizontal ? e.clientX : e.clientY;
    const startA = branch.sizes[a];

    const minGrow = totalGrow * (MIN_PANE_PX / Math.max(flexSpace, 1));

    const onMove = (ev: MouseEvent): void => {
      const delta = (horizontal ? ev.clientX : ev.clientY) - startPos;
      const startAPx = (startA / totalGrow) * flexSpace;
      let aPx = startAPx + delta;
      aPx = Math.max(MIN_PANE_PX, Math.min(pairPx - MIN_PANE_PX, aPx));
      const aGrow = (aPx / flexSpace) * totalGrow;
      branch.sizes[a] = Math.max(minGrow, aGrow);
      branch.sizes[b] = sumAB - branch.sizes[a];
      this.applySizes(branch);
    };
    // Cursor class is keyed by axis to match the CSS: `-row` → col-resize
    // (vertical divider, drag changes width), `-column` → row-resize. Both this
    // and `split-dragging` must be cleared on mouseup, or the resize cursor
    // sticks to the whole window after the drag ends.
    const axisClass = `split-dragging-${branch.axis}`;
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("split-dragging", axisClass);
      this.onLayoutChange?.(); // editors changed width — let the host re-measure.
    };
    document.body.classList.add("split-dragging", axisClass);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  private paintFocus(): void {
    for (const { el, focused } of this.leaves) el.classList.toggle("focused", focused);
    // A focus ring is noise when there is only one pane.
    this.container.classList.toggle("split-active", this.isSplit);
  }

  private allLeaves(): Leaf[] {
    const out: Leaf[] = [];
    const walk = (n: SplitNode): void => {
      if (n.kind === "leaf") out.push(n);
      else n.children.forEach(walk);
    };
    walk(this.root);
    return out;
  }
}

/** The first leaf reachable from a node (used to retarget focus on collapse). */
function firstLeaf(node: SplitNode): Leaf {
  let n = node;
  while (n.kind === "branch") n = n.children[0];
  return n;
}
