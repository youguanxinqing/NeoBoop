// Headless validation of the Boop-compat runtime against real Boop scripts.
// Run: node scripts-test.ts
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseMeta, runScript, type BoopScript } from "./src/scripts/runtime.ts";

const root = dirname(fileURLToPath(import.meta.url));
const builtinDir = join(root, "src/scripts/builtin");
const libDir = join(root, "src/scripts/lib");

const libs: Record<string, string> = {};
for (const f of readdirSync(libDir)) {
  if (f.endsWith(".js")) libs[f.slice(0, -3)] = readFileSync(join(libDir, f), "utf8");
}

const scripts: Record<string, BoopScript> = {};
for (const f of readdirSync(builtinDir)) {
  if (!f.endsWith(".js")) continue;
  const source = readFileSync(join(builtinDir, f), "utf8");
  const meta = parseMeta(source);
  if (meta) scripts[meta.name] = { meta, source, origin: "builtin" };
}

interface Case {
  script: string;
  input: string;
  selection?: string;
  expectText?: string;
  expectInfo?: RegExp;
}

const cases: Case[] = [
  { script: "Base64 Encode", input: "hello", expectText: "aGVsbG8=" },
  { script: "Base64 Decode", input: "aGVsbG8=", expectText: "hello" },
  { script: "URL Encode", input: "a b&c", expectText: "a%20b%26c" },
  { script: "Reverse String", input: "abc", expectText: "cba" },
  { script: "Camel Case", input: "hello world foo", expectText: "helloWorldFoo" },
  { script: "Count Characters", input: "hello", expectInfo: /5/ },
  { script: "Trim", input: "  hi  ", expectText: "hi" },
  { script: "Add Slashes", input: 'a"b', expectText: 'a\\"b' },
  { script: "Upcase", input: "abc", expectText: "ABC" },
  { script: "Downcase", input: "ABC", expectText: "abc" },
  { script: "URL Decode", input: "a%20b", expectText: "a b" },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const script = scripts[c.script];
  if (!script) {
    console.log(`✗ ${c.script}: NOT LOADED`);
    fail++;
    continue;
  }
  const sel = c.selection ?? null;
  const insertIndex = sel ? c.input.indexOf(sel) : 0;
  const r = runScript(script, libs, c.input, sel, insertIndex);
  const okText = c.expectText === undefined || r.text === c.expectText;
  const okInfo = c.expectInfo === undefined || (r.info !== null && c.expectInfo.test(r.info));
  if (r.error) {
    console.log(`✗ ${c.script}: error: ${r.error}`);
    fail++;
  } else if (okText && okInfo) {
    console.log(`✓ ${c.script}: ${JSON.stringify(c.input)} -> ${JSON.stringify(r.text)}${r.info ? ` [info: ${r.info}]` : ""}`);
    pass++;
  } else {
    console.log(`✗ ${c.script}: got text=${JSON.stringify(r.text)} info=${JSON.stringify(r.info)}, expected text=${JSON.stringify(c.expectText)} info=${c.expectInfo}`);
    fail++;
  }
}

console.log(`\n${Object.keys(scripts).length} scripts loaded, ${Object.keys(libs).length} libs.`);
console.log(`${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
