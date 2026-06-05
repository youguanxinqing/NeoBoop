// Global cross-tab search (⌃X ⌃F). Pure, DOM-free matching so it's testable:
// given a snapshot of every open tab (name + content), find the tabs that match
// a query and return display-ready, HTML-escaped fragments with the hits
// wrapped in <mark>, plus the document offset of the first content hit so the
// caller can jump the editor selection there.
//
// Matching is case-insensitive substring (the common case for a scratchpad).
// One result per tab, ordered by hit count; selecting it jumps to the first
// content hit (or just the tab, for a name-only match).

export interface SearchDoc {
  id: number;
  title: string;
  kind: "scratch" | "file";
  text: string;
}

export interface GlobalResult {
  id: number;
  kind: "scratch" | "file";
  /** Tab title, HTML-escaped, hits wrapped in <mark>. */
  titleHtml: string;
  /** Total hits across name + content. */
  count: number;
  /** 1-based line of the first content hit, or null for a name-only match. */
  line: number | null;
  /** Content snippet, HTML-escaped with <mark> hits; context line for name-only. */
  snippetHtml: string;
  /** Doc offsets of the first content hit (for editor reveal); -1 when none. */
  from: number;
  to: number;
}

const MAX_RESULTS = 200;
const SNIPPET_MAX = 120;
const SNIPPET_LEAD = 30;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Escape `segment` and wrap every case-insensitive occurrence of `query`
 *  (length `qlen`) in <mark>. Built by splicing escaped pieces so the <mark>
 *  tags are the only markup that survives escaping. */
function markAll(segment: string, lowerQuery: string, qlen: number): string {
  const lower = segment.toLowerCase();
  let out = "";
  let i = 0;
  for (;;) {
    const idx = lower.indexOf(lowerQuery, i);
    if (idx === -1) {
      out += escapeHtml(segment.slice(i));
      return out;
    }
    out += escapeHtml(segment.slice(i, idx));
    out += "<mark>" + escapeHtml(segment.slice(idx, idx + qlen)) + "</mark>";
    i = idx + qlen;
  }
}

function countOccurrences(haystackLower: string, needleLower: string): number {
  let n = 0;
  let i = 0;
  for (;;) {
    const idx = haystackLower.indexOf(needleLower, i);
    if (idx === -1) return n;
    n++;
    i = idx + needleLower.length;
  }
}

function lineNumberAt(text: string, off: number): number {
  let n = 1;
  for (let i = 0; i < off; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Snippet for the line containing the first content hit: trim leading
 *  whitespace, window around the hit if the line is long, highlight all hits in
 *  the window. */
function buildSnippet(text: string, off: number, lowerQuery: string, qlen: number): string {
  const lineStart = text.lastIndexOf("\n", off - 1) + 1;
  let lineEnd = text.indexOf("\n", off);
  if (lineEnd === -1) lineEnd = text.length;
  let line = text.slice(lineStart, lineEnd);

  // trim leading indentation, keeping the hit position aligned
  let hitInLine = off - lineStart;
  const trimmed = line.replace(/^\s+/, "");
  hitInLine -= line.length - trimmed.length;
  line = trimmed;
  if (hitInLine < 0) hitInLine = 0;

  let lead = "";
  let trail = "";
  if (line.length > SNIPPET_MAX) {
    const start = Math.max(0, hitInLine - SNIPPET_LEAD);
    const end = Math.min(line.length, start + SNIPPET_MAX);
    if (start > 0) lead = "…";
    if (end < line.length) trail = "…";
    line = line.slice(start, end);
  }
  return lead + markAll(line, lowerQuery, qlen) + trail;
}

function firstNonEmptyLine(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line) return line.length > SNIPPET_MAX ? line.slice(0, SNIPPET_MAX) + "…" : line;
  }
  return "";
}

/** Search every doc for `rawQuery`; return one result per matching tab,
 *  ordered by hit count (desc). Empty query → no results. */
export function searchDocuments(docs: SearchDoc[], rawQuery: string): GlobalResult[] {
  const lowerQuery = rawQuery.toLowerCase();
  const qlen = rawQuery.length;
  if (!lowerQuery) return [];

  const results: GlobalResult[] = [];
  for (const doc of docs) {
    const titleCount = countOccurrences(doc.title.toLowerCase(), lowerQuery);
    const textLower = doc.text.toLowerCase();
    const contentCount = countOccurrences(textLower, lowerQuery);
    const count = titleCount + contentCount;
    if (count === 0) continue;

    const titleHtml =
      titleCount > 0 ? markAll(doc.title, lowerQuery, qlen) : escapeHtml(doc.title);

    let line: number | null = null;
    let snippetHtml: string;
    let from = -1;
    let to = -1;
    if (contentCount > 0) {
      from = textLower.indexOf(lowerQuery);
      to = from + qlen;
      line = lineNumberAt(doc.text, from);
      snippetHtml = buildSnippet(doc.text, from, lowerQuery, qlen);
    } else {
      const ctx = firstNonEmptyLine(doc.text);
      snippetHtml = ctx ? escapeHtml(ctx) : '<span class="gs-empty">(empty)</span>';
    }

    results.push({ id: doc.id, kind: doc.kind, titleHtml, count, line, snippetHtml, from, to });
  }

  results.sort((a, b) => b.count - a.count);
  return results.slice(0, MAX_RESULTS);
}
