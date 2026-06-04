// Custom user script folder support.
//
// A user picks a folder of .js files. Files with a Boop metadata header become
// runnable scripts; files without one become libs those scripts can require()
// (e.g. require('./helpers')). The chosen path is persisted so it reloads on
// launch. Built-in scripts are unaffected — they still only see @boop/ libs.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { parseMeta, type BoopScript } from "./runtime";

const STORAGE_KEY = "neoboop.userScriptsDir";

interface ScriptFile {
  name: string;
  source: string;
}

export interface UserScripts {
  scripts: BoopScript[];
  libs: Record<string, string>;
}

export function getUserDir(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

function setUserDir(dir: string): void {
  localStorage.setItem(STORAGE_KEY, dir);
}

export function clearUserDir(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Opens a native folder picker; persists and returns the chosen path. */
export async function pickUserDir(): Promise<string | null> {
  const result = await open({ directory: true, multiple: false, title: "Choose a scripts folder" });
  if (typeof result !== "string") return null;
  setUserDir(result);
  return result;
}

/** Loads and parses every .js file from `dir` into scripts + libs. */
export async function loadUserScripts(dir: string): Promise<UserScripts> {
  const files = await invoke<ScriptFile[]>("read_scripts", { dir });

  const libs: Record<string, string> = {};
  const scripts: BoopScript[] = [];

  for (const file of files) {
    const meta = parseMeta(file.source);
    if (meta) {
      scripts.push({ meta, source: file.source, origin: "user" });
    } else {
      libs[file.name] = file.source;
    }
  }

  // Bind each user script's require() to the sibling libs from the same folder.
  for (const script of scripts) script.extraLibs = libs;

  scripts.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
  return { scripts, libs };
}
