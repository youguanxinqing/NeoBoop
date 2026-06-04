// Editor syntax highlighting. The document is arbitrary pasted text, so we
// detect the language from content by default ("Auto") and let the user lock a
// specific language via the status-bar picker. Language modes are loaded lazily
// so they don't weigh down the initial bundle.

import type { Extension } from "@codemirror/state";

export type LangName =
  | "auto"
  | "text"
  | "javascript"
  | "json"
  | "sql"
  | "html"
  | "xml"
  | "css"
  | "python"
  | "yaml"
  | "markdown";

/** Labels shown in the picker, in display order. */
export const LANG_OPTIONS: { value: LangName; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "text", label: "Plain Text" },
  { value: "javascript", label: "JavaScript" },
  { value: "json", label: "JSON" },
  { value: "sql", label: "SQL" },
  { value: "html", label: "HTML" },
  { value: "xml", label: "XML" },
  { value: "css", label: "CSS" },
  { value: "python", label: "Python" },
  { value: "yaml", label: "YAML" },
  { value: "markdown", label: "Markdown" },
];

const loaders: Record<string, () => Promise<Extension>> = {
  javascript: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  sql: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  xml: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  python: () => import("@codemirror/lang-python").then((m) => m.python()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
};

/** Resolves a concrete language (not "auto"/"text") to its extension. */
export async function loadLanguage(name: LangName): Promise<Extension> {
  const loader = loaders[name];
  return loader ? loader() : [];
}

/**
 * Conservative content-based detection: only returns a concrete language on a
 * strong signal, otherwise "text". A leading SQL/markup keyword or a JSON-shaped
 * body is reliable; ambiguous prose falls back to plain text rather than
 * mislabelling everything (which is what JS-on-everything did to SQL).
 */
export function detect(text: string): LangName {
  const t = text.replace(/^﻿/, "").trimStart();
  if (!t) return "text";
  const head = t.slice(0, 4000);

  if (/^<\?xml/i.test(t)) return "xml";
  if (/^<!doctype html|^<html[\s>]/i.test(t)) return "html";
  if (/^</.test(t)) return "xml";

  // Leading SQL keyword — strong signal (e.g. "UPDATE agents SET …").
  if (
    /^(select|with|insert|update|delete|create|alter|drop|truncate|begin|explain|grant|revoke)\b/i.test(
      t,
    )
  ) {
    return "sql";
  }

  // JSON: object/array shaped.
  if (/^[{[]/.test(t) && /[}\]]\s*;?\s*$/.test(text.trimEnd())) return "json";

  // YAML document marker.
  if (/^---\s*$/m.test(head) && /^[\w-]+\s*:/m.test(head)) return "yaml";

  return "text";
}
