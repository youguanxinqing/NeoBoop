// Persistence layer: the thin bridge to the Rust FS commands.
//
// Two stores live here, both invisible to the user:
//   • Real files — read/written by absolute path (Finder "Open With…", ⌘S,
//     Save As). Content crosses as LF; `eol`/`finalNewline` ride along so a save
//     restores the file's original line-ending shape rather than rewriting it.
//   • Scratch — every scratchpad is backed by a managed file under the app-data
//     dir and listed in a permanent manifest (the scratch history). The user
//     never names or saves these; they autosave and survive quit/relaunch.
//
// Rust scopes the scratch/manifest/session paths under app-data (see
// app_data_read/write); real-file paths are unscoped on purpose.

import { invoke } from "@tauri-apps/api/core";
import type { LangName } from "./languages";

export type Eol = "lf" | "crlf";

/** A text file loaded from disk (mirrors the Rust `TextFile`). */
export interface TextFile {
  path: string;
  name: string;
  content: string;
  encodingOk: boolean;
  readOnly: boolean;
  eol: Eol;
  finalNewline: boolean;
}

/** One entry in the permanent scratch history (`scratch/manifest.json`). */
export interface ScratchMeta {
  id: number;
  created: number; // epoch ms
  modified: number; // epoch ms
  name?: string; // user-set (double-click) name; else first-line auto title
  lang: LangName;
  preview: string; // first non-blank line-ish, for the history picker
}

/** A tab to reopen on next launch (`session.json`). */
export interface SessionEntry {
  kind: "scratch" | "file";
  scratchId?: number;
  path?: string;
  focused: boolean;
}

const MANIFEST = "scratch/manifest.json";
const SESSION = "session.json";
const scratchRel = (id: number) => `scratch/${id}.txt`;

async function readJson<T>(rel: string, fallback: T): Promise<T> {
  const raw = await invoke<string | null>("app_data_read", { rel });
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(rel: string, value: unknown): Promise<void> {
  return invoke("app_data_write", { rel, content: JSON.stringify(value, null, 2) });
}

// ---- real files -----------------------------------------------------------

export const takeOpenedFiles = (): Promise<TextFile[]> => invoke("take_opened_files");

export const readTextFile = (path: string): Promise<TextFile> =>
  invoke("read_text_file", { path });

export const writeTextFile = (
  path: string,
  content: string,
  eol: Eol,
  finalNewline: boolean,
): Promise<void> => invoke("write_text_file", { path, content, eol, finalNewline });

// ---- scratch store + history ----------------------------------------------

export const readManifest = (): Promise<ScratchMeta[]> => readJson(MANIFEST, []);
export const writeManifest = (metas: ScratchMeta[]): Promise<void> => writeJson(MANIFEST, metas);

export async function readScratchContent(id: number): Promise<string> {
  return (await invoke<string | null>("app_data_read", { rel: scratchRel(id) })) ?? "";
}

export const writeScratchContent = (id: number, content: string): Promise<void> =>
  invoke("app_data_write", { rel: scratchRel(id), content });

// ---- session restore ------------------------------------------------------

export const readSession = (): Promise<SessionEntry[]> => readJson(SESSION, []);
export const writeSession = (entries: SessionEntry[]): Promise<void> => writeJson(SESSION, entries);
