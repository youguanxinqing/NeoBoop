// Preferences window. Sets the custom scripts folder, mirroring Boop's
// Settings → Scripts pane. It only records the folder (in localStorage, shared
// with the main window) and notifies the main window via the
// "scripts-folder-changed" event — the actual loading happens there.

import "./styles.css";
import { emit } from "@tauri-apps/api/event";
import { clearUserDir, getUserDir, pickUserDir } from "./scripts/userscripts";

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

refresh();
