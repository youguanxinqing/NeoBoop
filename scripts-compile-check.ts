// Compile-checks EVERY built-in script against the shim: parse metadata and
// build its main(). Reports any that fail. Run: node scripts-compile-check.ts
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseMeta, compileMain } from "./src/scripts/runtime.ts";

const root = dirname(fileURLToPath(import.meta.url));
const builtinDir = join(root, "src/scripts/builtin");
const libDir = join(root, "src/scripts/lib");

const libs: Record<string, string> = {};
for (const f of readdirSync(libDir)) {
  if (f.endsWith(".js")) libs[f.slice(0, -3)] = readFileSync(join(libDir, f), "utf8");
}

let ok = 0;
const failures: string[] = [];
const noMeta: string[] = [];

for (const f of readdirSync(builtinDir).sort()) {
  if (!f.endsWith(".js")) continue;
  const source = readFileSync(join(builtinDir, f), "utf8");
  const meta = parseMeta(source);
  if (!meta) {
    noMeta.push(f);
    continue;
  }
  try {
    compileMain(source, libs);
    ok++;
  } catch (e) {
    failures.push(`${f} (${meta.name}): ${e instanceof Error ? e.message : e}`);
  }
}

console.log(`Compiled OK: ${ok}`);
if (noMeta.length) console.log(`\nNo metadata (${noMeta.length}): ${noMeta.join(", ")}`);
if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures) console.log("  ✗ " + f);
}
process.exit(failures.length === 0 ? 0 : 1);
