import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Tauri expects a fixed port and to be told the dev host.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Prevent Vite from obscuring Rust errors.
  clearScreen: false,
  build: {
    // Two pages: the main editor window and the Preferences window.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        preferences: fileURLToPath(new URL("./preferences.html", import.meta.url)),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // Don't watch the Rust side; cargo handles that.
      ignored: ["**/src-tauri/**"],
    },
  },
});
