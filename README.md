<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="104" alt="NeoBoop icon" />

# NeoBoop

**A fast, scriptable scratchpad for developers — on macOS.**

Paste some text, run a *boop* over it, get the result. Base64, JSON, hashes,
case conversions, URL encode, and 70+ more — all driven from a single fuzzy
command palette. Now with split panes, tabs, and a system-wide quick-capture
hotkey.

Built on **Tauri 2** + **CodeMirror 6**. A from-scratch reimplementation of
[Boop](https://github.com/IvanMathy/Boop) that has since grown well past it.

![License: MIT](https://img.shields.io/badge/License-MIT-informational)
![Platform: macOS](https://img.shields.io/badge/Platform-macOS-lightgrey)
![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri%202-24C8DB)

</div>

## Highlights

- **70+ built-in boops** — text transformations runnable from a fuzzy palette
  (⌘B). The full Boop catalogue is bundled and runs unmodified.
- **Bring your own scripts** — point Preferences at a folder of `.js` files and
  they show up alongside the built-ins; files without a metadata header become
  libraries your scripts can `require()`.
- **Split panes** — split the focused pane side-by-side or stacked, composing
  arbitrary grids (a recursive split tree, Vim/Zed-style). Each pane is an
  *independent* editor — no shared buffer, no state-swap.
- **Tabs** — independent editor panes with a single global tab bar; rename any
  tab; cycle which tab a pane shows.
- **Global quick-capture** — a system-wide hotkey (default <kbd>⌃⌥Space</kbd>,
  rebindable in Preferences) raises NeoBoop and opens a fresh boop from any app,
  so you can jot something the moment it occurs to you.
- **Syntax-aware** — auto-detects or locks to 10 languages (JS, JSON, SQL,
  HTML, XML, CSS, Python, YAML, Markdown, plain text), with a one-step
  **Preview Markdown** palette action.
- **Native macOS feel** — native menus, follows the system light/dark theme,
  the red button hides (not quits — see below), and a sage colour theme that's
  driven by a single CSS token.
- **Tiny** — the bundled `.app` is ~3.4 MB; no Apple developer account needed
  to build and run locally.

## Keyboard shortcuts

**Command palette**

| Shortcut | Action |
| --- | --- |
| <kbd>⌘B</kbd> | Open the palette — run a boop, or pick an action (Select Pane, Preview Markdown, Settings) |
| <kbd>⌘P</kbd> | Jump straight into **Select Pane** (the tab switcher) |
| <kbd>⌃N</kbd> / <kbd>⌃P</kbd> / <kbd>↑</kbd> <kbd>↓</kbd> | Move the selection (in the palette) |
| <kbd>↵</kbd> / <kbd>Esc</kbd> | Run the highlighted entry / close the palette |

**Tabs**

| Shortcut | Action |
| --- | --- |
| <kbd>⌘T</kbd> | New tab |
| <kbd>⌘S</kbd> | Rename the focused tab (session-only — NeoBoop has no files) |
| <kbd>⌘⇧]</kbd> / <kbd>⌘⇧[</kbd> | Cycle which tab the focused pane shows |

**Split panes**

| Shortcut | Action |
| --- | --- |
| <kbd>⌃S</kbd> | Split side-by-side (vertical divider) |
| <kbd>⌃V</kbd> | Split stacked (horizontal divider) |
| <kbd>⌃X</kbd> | Close the focused pane (keeps its tab) |
| <kbd>⌘⌥</kbd> + <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> | Move focus between panes |

**View & system**

| Shortcut | Action |
| --- | --- |
| <kbd>⌘=</kbd> / <kbd>⌘-</kbd> / <kbd>⌘0</kbd> | Bigger / smaller / reset font |
| <kbd>⌘,</kbd> | Settings |
| <kbd>⌃⌥Space</kbd> | *(global, default)* Summon NeoBoop with a fresh boop |
| Red button | Hide the window — the app keeps running so the global shortcut still works |
| <kbd>⌘Q</kbd> | Quit |

> Closing the window only hides it (standard macOS quick-capture behaviour);
> the Dock icon or the global shortcut brings it back. Use <kbd>⌘Q</kbd> to
> actually quit.

## Boop script compatibility

Unmodified Boop scripts run as-is. `src/scripts/runtime.ts` mirrors Boop's
`ScriptExecution` + `require('@boop/...')` contract:

| Boop API | Status |
| --- | --- |
| `/** {json} **/` metadata header | ✅ |
| global `main(input)` | ✅ |
| `input.text` / `fullText` / `selection` / `isSelection` | ✅ |
| `input.postInfo()` / `postError()` / `insert()` | ✅ |
| `require('@boop/<lib>')` (CommonJS) | ✅ |

**Add a built-in script:** drop a `.js` into `src/scripts/builtin/`. **Add a
shared lib:** drop it into `src/scripts/lib/`. Both are registered
automatically at build time. **Add your own without rebuilding:** put them in a
folder and select it under **Settings → Custom scripts folder**.

## Why a reimplementation instead of a fork

Boop is a native AppKit app whose editor is a single shared `NSTextView`.
Layering tabs / windows on top of that (shared-editor + state-swap) repeatedly
broke text input through the AppKit responder chain — a bug class that is
notoriously hard to fix incrementally.

NeoBoop designs that bug class out:

- **Editor** = CodeMirror 6 — input handled entirely inside its DOM subtree.
- **Tabs / split panes** = independent editor instances, never a shared one.
- **Scripts** = the same JavaScript Boop already runs, so the ecosystem ports
  verbatim.

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

Builds output to `src-tauri/target/release/bundle/`. No Apple developer account
is needed: macOS builds are ad-hoc signed and `just install` strips the
quarantine attribute so the app runs locally on double-click. These wrap
`pnpm tauri dev|build` — run those directly if you prefer.

## Project layout

```
src/
  main.ts          # palette UI, shortcuts, status bar, execution wiring
  editor.ts        # EditorPane — one independent CodeMirror instance
  tabs.ts          # TabManager — reconciles tabs into split-tree leaves
  split.ts         # recursive split tree (the pane grid)
  picker.ts        # zero-dep fuzzy search (replaces Boop's Fuse)
  languages.ts     # language detection + lazy CodeMirror language loaders
  preferences.ts   # Preferences window (scripts folder, global shortcut)
  shortcut.ts      # global quick-capture shortcut: storage + (re)registration
  scripts/
    runtime.ts     # Boop-compatible execution shim
    registry.ts    # build-time glob loader for builtin/ + lib/
    builtin/*.js    # Boop transformations (vendored, unmodified)
    lib/*.js        # @boop/ libraries (vendored, unmodified)
src-tauri/         # thin Rust shell — window, native menus, global shortcut
```

## Acknowledgements

NeoBoop stands on the shoulders of **[Boop](https://github.com/IvanMathy/Boop)**
by **Ivan Mathy** and its contributors. Boop's design, its script API, and its
entire catalogue of transformations are what make NeoBoop useful on day one —
the built-in scripts and libraries under `src/scripts/` are vendored from Boop
under its MIT license. Huge thanks to that project and community. 🙏

Also built with [Tauri](https://tauri.app) and
[CodeMirror](https://codemirror.net). See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for full attribution.

## License

NeoBoop is released under the [MIT License](LICENSE). Bundled third-party code
(notably the Boop scripts and libraries) is distributed under its own licenses,
documented in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
