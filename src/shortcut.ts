// Global quick-capture shortcut.
//
// A system-wide hotkey that summons NeoBoop (front + focus) and opens a fresh
// boop, so you can jot something from any app. The chord is user-configurable
// in Preferences and persisted in localStorage (shared across our same-origin
// windows). Rust owns the actual OS registration via the `set_global_shortcut`
// command; this module just stores the choice and formats it for display.
//
// Accelerator strings use Tauri's syntax: modifier tokens ("Control", "Alt",
// "Shift", "Super") plus a key by its KeyboardEvent.code name ("Space", "KeyN",
// "Digit1", …) — which is exactly what we read off a keydown, so a recorded
// chord maps straight through to what Rust parses.

import { invoke } from "@tauri-apps/api/core";

const STORAGE_KEY = "neoboop.globalShortcut";
export const DEFAULT_GLOBAL_SHORTCUT = "Control+Alt+Space";

export function getGlobalShortcut(): string {
  return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_GLOBAL_SHORTCUT;
}

export function storeGlobalShortcut(accelerator: string): void {
  localStorage.setItem(STORAGE_KEY, accelerator);
}

/** Register (or re-register) the chord with the OS. Throws on parse/conflict. */
export async function applyGlobalShortcut(accelerator: string): Promise<void> {
  await invoke("set_global_shortcut", { accelerator });
}

const IS_MODIFIER_CODE = /^(Control|Alt|Shift|Meta)(Left|Right)$/;

/** Builds a Tauri accelerator from a keydown, or null if it isn't a usable
 *  chord (needs at least one modifier plus a non-modifier key). */
export function accelFromEvent(e: KeyboardEvent): string | null {
  if (IS_MODIFIER_CODE.test(e.code)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  if (mods.length === 0 || !e.code) return null;
  return [...mods, e.code].join("+");
}

const SYMBOL: Record<string, string> = {
  Control: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Super: "⌘",
};

/** Pretty-prints an accelerator for the UI, e.g. "Control+Alt+Space" → "⌃⌥Space". */
export function formatAccelerator(accelerator: string): string {
  const parts = accelerator.split("+");
  return parts
    .map((p) => {
      if (p in SYMBOL) return SYMBOL[p];
      if (p.startsWith("Key")) return p.slice(3); // KeyN → N
      if (p.startsWith("Digit")) return p.slice(5); // Digit1 → 1
      return p; // Space, Enter, ArrowUp, F1, …
    })
    .join("");
}
