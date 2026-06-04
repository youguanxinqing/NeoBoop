// Loads built-in scripts and @boop/ libs at build time via Vite's glob import.
// Dropping a new .js into builtin/ (or lib/) is all it takes to register it —
// no manifest to maintain.

import { parseMeta, type BoopScript } from "./runtime";

const scriptModules = import.meta.glob("./builtin/*.js", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const libModules = import.meta.glob("./lib/*.js", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Map of bare lib name (e.g. "base64") -> source, for require('@boop/base64'). */
export const libs: Record<string, string> = Object.fromEntries(
  Object.entries(libModules).map(([path, src]) => {
    const name = path.replace(/^.*\/lib\//, "").replace(/\.js$/, "");
    return [name, src];
  }),
);

/** All built-in scripts with valid metadata, sorted by display name. */
export const scripts: BoopScript[] = Object.values(scriptModules)
  .map((source): BoopScript | null => {
    const meta = parseMeta(source);
    return meta ? { meta, source, origin: "builtin" } : null;
  })
  .filter((s): s is BoopScript => s !== null)
  .sort((a, b) => a.meta.name.localeCompare(b.meta.name));
