// Boop-compatible script runtime.
//
// This is the moat: it lets unmodified Boop scripts (the `/** {json} **/`
// header + a global `main(input)` function + `require('@boop/...')`) run
// verbatim. Keeping this faithful to Boop's JSContext semantics is what
// makes the existing 70+ script ecosystem portable.
//
// Reference (Boop/System/Models/ScriptExecution.swift, Script+Require.swift):
//   - input.text       get/set (selection if present, else fullText)
//   - input.fullText   the whole document
//   - input.selection  the selected range text (or null)
//   - input.isSelection
//   - input.postInfo(msg) / input.postError(msg)
//   - input.insert(str)
//   - require('@boop/name') -> CommonJS module from lib/

export interface ScriptMeta {
  api: number;
  name: string;
  description?: string;
  author?: string;
  icon?: string;
  tags?: string;
  bias?: number;
}

export interface BoopScript {
  meta: ScriptMeta;
  /** Raw source, used to (re)compile the `main` entry point. */
  source: string;
  /** Where the script came from. User scripts may require sibling files. */
  origin: "builtin" | "user";
  /** Lib map this script's require() should resolve non-@boop paths from. */
  extraLibs?: Record<string, string>;
  /** Compiled entry point. Lazily built on first run. */
  main?: (input: Execution) => void;
}

/** Result of running a script against some text. */
export interface RunResult {
  text: string;
  info: string | null;
  error: string | null;
}

/**
 * Mirrors Boop's ScriptExecution object. `text` resolves to the selection
 * when one exists, otherwise the full document — exactly like the Swift impl.
 */
export class Execution {
  isSelection: boolean;
  selection: string | null;
  fullText: string;
  info: string | null = null;
  error: string | null = null;

  private readonly insertIndex: number | null;
  private insertOffset = 0;

  constructor(fullText: string, selection: string | null, insertIndex: number | null) {
    this.fullText = fullText;
    this.selection = selection;
    this.isSelection = selection !== null;
    this.insertIndex = insertIndex;
  }

  get text(): string {
    return this.isSelection ? (this.selection ?? "") : this.fullText;
  }

  set text(value: string) {
    if (this.isSelection) this.selection = value;
    else this.fullText = value;
  }

  postError(message: string): void {
    this.error = String(message);
  }

  postInfo(message: string): void {
    this.info = String(message);
  }

  insert(value: string): void {
    if (this.isSelection) {
      this.selection = value;
      return;
    }
    if (this.insertIndex === null) {
      this.fullText = value;
      return;
    }
    const at = this.insertIndex + this.insertOffset;
    this.fullText = this.fullText.slice(0, at) + value + this.fullText.slice(at);
    this.insertOffset += value.length;
  }
}

// ---- require('@boop/...') -------------------------------------------------

const BOOP_PREFIX = "@boop/";

/**
 * Builds a CommonJS-style require. Faithful to Script+Require.swift:
 *   - `@boop/x` resolves from the built-in lib map.
 *   - any other path resolves from `extraLibs` (a user script folder), mirroring
 *     Boop's rule that custom scripts may require files alongside them.
 * Strips the prefix and `.js`, wraps the module body, caches exports.
 */
function makeRequire(
  libs: Record<string, string>,
  extraLibs: Record<string, string>,
): (path: string) => unknown {
  const cache = new Map<string, unknown>();

  const require = (path: string): unknown => {
    let name = path;
    let src: string | undefined;
    if (name.startsWith(BOOP_PREFIX)) {
      name = name.slice(BOOP_PREFIX.length);
      if (name.endsWith(".js")) name = name.slice(0, -3);
      src = libs[name];
    } else {
      name = name.replace(/^\.\//, "");
      if (name.endsWith(".js")) name = name.slice(0, -3);
      src = extraLibs[name];
    }

    if (src === undefined) {
      throw new Error(`Boop require: module not found: ${path}`);
    }
    if (cache.has(name)) return cache.get(name);

    const module = { exports: {} as unknown };
    // eslint-disable-next-line no-new-func
    const factory = new Function("require", "module", "exports", src);
    factory(require, module, module.exports);
    cache.set(name, module.exports);
    return module.exports;
  };

  return require;
}

// ---- metadata + compilation ----------------------------------------------

const META_RE = /\/\*\*\s*([\s\S]*?)\s*\*\*\//;

export function parseMeta(source: string): ScriptMeta | null {
  const m = source.match(META_RE);
  if (!m) return null;
  try {
    // Boop's parser tolerated trailing commas (e.g. Trim.js); strip them so
    // those scripts load unmodified under strict JSON.parse.
    const lenient = m[1].replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(lenient) as ScriptMeta;
  } catch {
    return null;
  }
}

/**
 * Compiles a Boop script to its `main` function. The script body runs in a
 * function scope with `require` injected, mirroring Boop's global eval where
 * `main` is declared and `require` is a global. A function declaration inside
 * the wrapper stays local, so we return it explicitly.
 */
export function compileMain(
  source: string,
  libs: Record<string, string>,
  extraLibs: Record<string, string> = {},
): (input: Execution) => void {
  const require = makeRequire(libs, extraLibs);
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "require",
    `${source}\n;return typeof main === "function" ? main : null;`,
  );
  const main = factory(require) as ((input: Execution) => void) | null;
  if (typeof main !== "function") {
    throw new Error("Boop script: no global main() function found");
  }
  return main;
}

/**
 * Runs a script against the given document/selection and returns the result.
 * Errors thrown by the script are captured into the result, not propagated —
 * a broken boop must never take down the editor.
 */
export function runScript(
  script: BoopScript,
  libs: Record<string, string>,
  fullText: string,
  selection: string | null,
  insertIndex: number | null,
  extraLibs: Record<string, string> = {},
): RunResult {
  try {
    if (!script.main) script.main = compileMain(script.source, libs, extraLibs);
    const exec = new Execution(fullText, selection, insertIndex);
    script.main(exec);
    return {
      text: exec.isSelection ? (exec.selection ?? "") : exec.fullText,
      info: exec.info,
      error: exec.error,
    };
  } catch (err) {
    return {
      text: selection ?? fullText,
      info: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
