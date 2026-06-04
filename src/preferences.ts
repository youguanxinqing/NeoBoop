// Preferences window. Sets the custom scripts folder, mirroring Boop's
// Settings → Scripts pane. It only records the folder (in localStorage, shared
// with the main window) and notifies the main window via the
// "scripts-folder-changed" event — the actual loading happens there.

import "./styles.css";
import { emit } from "@tauri-apps/api/event";
import { clearUserDir, getUserDir, pickUserDir } from "./scripts/userscripts";
import {
  DEFAULT_GLOBAL_SHORTCUT,
  accelFromEvent,
  applyGlobalShortcut,
  formatAccelerator,
  getGlobalShortcut,
  storeGlobalShortcut,
} from "./shortcut";

const input = document.getElementById("prefs-dir") as HTMLInputElement;
const changeBtn = document.getElementById("prefs-change") as HTMLButtonElement;
const clearBtn = document.getElementById("prefs-clear") as HTMLButtonElement;

function refresh(): void {
  const dir = getUserDir();
  input.value = dir ?? "";
  clearBtn.disabled = !dir;
}

changeBtn.addEventListener("click", async () => {
  const dir = await pickUserDir();
  if (dir) {
    refresh();
    await emit("scripts-folder-changed");
  }
});

clearBtn.addEventListener("click", async () => {
  clearUserDir();
  refresh();
  await emit("scripts-folder-changed");
});

// ---- global quick-capture shortcut ----------------------------------------

const shortcutInput = document.getElementById("prefs-shortcut") as HTMLInputElement;
const recordBtn = document.getElementById("prefs-shortcut-record") as HTMLButtonElement;
const resetBtn = document.getElementById("prefs-shortcut-reset") as HTMLButtonElement;
const shortcutHint = document.getElementById("prefs-shortcut-hint") as HTMLElement;
const DEFAULT_HINT = shortcutHint.textContent ?? "";

let recording = false;

function showShortcut(accelerator: string): void {
  shortcutInput.value = formatAccelerator(accelerator);
}
showShortcut(getGlobalShortcut());

/** Try to bind+persist a recorded chord, reverting the UI if the OS rejects it
 *  (unparseable, or already claimed by another app). */
async function commitShortcut(accelerator: string): Promise<void> {
  try {
    await applyGlobalShortcut(accelerator);
    storeGlobalShortcut(accelerator);
    showShortcut(accelerator);
    shortcutHint.textContent = DEFAULT_HINT;
  } catch {
    shortcutHint.textContent = `${formatAccelerator(accelerator)} couldn't be registered — it may be in use. Try another.`;
    showShortcut(getGlobalShortcut());
  }
}

function stopRecording(): void {
  recording = false;
  recordBtn.textContent = "Record…";
  shortcutInput.classList.remove("recording");
  showShortcut(getGlobalShortcut());
}

recordBtn.addEventListener("click", () => {
  if (recording) {
    stopRecording();
    return;
  }
  recording = true;
  recordBtn.textContent = "Cancel";
  shortcutInput.classList.add("recording");
  shortcutInput.value = "Press keys…";
  shortcutHint.textContent = "Press the chord now, or Esc to cancel.";
});

window.addEventListener("keydown", (e) => {
  if (!recording) return;
  e.preventDefault();
  if (e.key === "Escape") {
    stopRecording();
    return;
  }
  const accel = accelFromEvent(e);
  if (!accel) return; // still waiting for a modifier + real key
  recording = false;
  recordBtn.textContent = "Record…";
  shortcutInput.classList.remove("recording");
  void commitShortcut(accel);
});

resetBtn.addEventListener("click", () => void commitShortcut(DEFAULT_GLOBAL_SHORTCUT));

refresh();
