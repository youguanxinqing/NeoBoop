# NeoBoop

A scriptpad for developers — a clean-room reimplementation of
[Boop](https://github.com/IvanMathy/Boop) on **Tauri 2 + CodeMirror 6**.

## Why a rewrite instead of forking Boop

Boop is a native AppKit app whose editor is a single shared `NSTextView`.
Adding tabs / windows on top of that (shared-editor + state-swap) repeatedly
broke text input via the AppKit responder chain — a class of bug that is
notoriously hard to fix incrementally.

NeoBoop designs that bug class out:

- **Editor** = CodeMirror 6, input handled entirely inside the DOM subtree.
- **Tabs** = independent editor panes (frontend state), no shared editor.
- **Windows** = independent webview windows.
- **Scripts** = the same JavaScript Boop already uses, so the existing
  ecosystem ports verbatim (see below).

## Boop script compatibility

Unmodified Boop scripts run as-is. `src/scripts/runtime.ts` faithfully
mirrors Boop's `ScriptExecution` + `require('@boop/...')` contract:

| Boop API | Status |
| --- | --- |
| `/** {json} **/` metadata header | ✅ |
| global `main(input)` | ✅ |
| `input.text` / `fullText` / `selection` / `isSelection` | ✅ |
| `input.postInfo()` / `postError()` / `insert()` | ✅ |
| `require('@boop/<lib>')` (CommonJS) | ✅ |

Add a script: drop a `.js` into `src/scripts/builtin/`. Add a shared lib:
drop it into `src/scripts/lib/`. They are registered automatically.

## Develop & build

Common tasks are wrapped in a [`justfile`](justfile) (`brew install just`):

```bash
just deps        # install frontend dependencies (pnpm install)
just dev         # run the app with hot reload
just test        # script-runtime regression (compile-check all + functional)
just build       # Release .app + .dmg (current arch)
just install     # build, then install to /Applications (ad-hoc signed)
just universal   # arm64 + x86_64 universal build
just clean       # remove build artifacts
```

`just build` outputs to `src-tauri/target/release/bundle/` — the `.app` is
~3.4 MB, the `.dmg` ~1.7 MB. No Apple developer account needed: macOS builds
are ad-hoc signed and `just install` strips the quarantine attribute so the
app runs locally on double-click.

Under the hood these wrap `pnpm tauri dev|build`; run those directly if you
prefer. `node scripts-test.ts` runs the headless runtime tests standalone.

## Layout

```
src/
  main.ts             # picker UI, shortcuts, status bar, execution wiring
  editor.ts           # EditorPane: one independent CodeMirror instance
  picker.ts           # zero-dep fuzzy search (replaces Boop's Fuse)
  scripts/
    runtime.ts        # Boop-compatible execution shim (the moat)
    registry.ts       # build-time glob loader for builtin/ + lib/
    builtin/*.js      # Boop scripts (unmodified)
    lib/*.js          # @boop/ libraries (unmodified)
src-tauri/            # thin Rust shell — hosts the window, nothing more
```
