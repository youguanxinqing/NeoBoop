# Third-party notices

NeoBoop is built on, and vendors code from, several open-source projects.
Their licenses and copyright notices are acknowledged below. NeoBoop's own
code is under the MIT License (see [LICENSE](LICENSE)).

## Boop

NeoBoop is a reimplementation of **Boop** by Ivan Mathy and contributors:
<https://github.com/IvanMathy/Boop>

The built-in transformations in `src/scripts/builtin/` and the runnable
libraries in `src/scripts/lib/` are vendored, largely verbatim, from Boop so
that the existing Boop script ecosystem runs unmodified. Boop is distributed
under the MIT License:

```
MIT License

Copyright (c) 2019 Ivan Mathy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Libraries bundled via Boop

`src/scripts/lib/` additionally contains third-party JavaScript libraries that
Boop vendors for its scripts to `require()`. Each file retains its original
license header in-source; refer to the header of each file and to its upstream
project for the full terms:

- **lodash** — <https://github.com/lodash/lodash>
- **he** — <https://github.com/mathiasbynens/he>
- **PapaParse** — <https://github.com/mholt/PapaParse>
- **jsHashes** (`hashes.js`) — <https://github.com/h2non/jshashes>
- **vkBeautify** — <https://github.com/vkiryukhin/vkBeautify>

## Runtime & tooling

NeoBoop is built with these projects (used as dependencies, not vendored):

- **Tauri** — <https://github.com/tauri-apps/tauri> (MIT / Apache-2.0)
- **CodeMirror 6** — <https://github.com/codemirror/dev> (MIT)
