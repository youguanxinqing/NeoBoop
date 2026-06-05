# NeoBoop — 开发、打包与安装
#
#   just dev        启动开发模式（热重载）
#   just test       跑脚本运行时回归测试
#   just build      构建 Release 版 .app + .dmg（输出在 src-tauri/target/release/bundle）
#   just install    构建并安装到 /Applications
#   just universal  构建 universal（arm64 + x86_64）版本
#   just clean       清理构建产物
#
# macOS 上 Tauri 默认 ad-hoc 签名（无需 Apple 开发者账号）；install 会去掉
# quarantine 属性，本机直接可运行。

set shell := ["bash", "-uc"]

app_name   := "NeoBoop"
target_dir := justfile_directory() / "src-tauri/target"
bundle     := target_dir / "release/bundle"
built_app  := bundle / "macos" / app_name + ".app"

# 列出可用命令
default:
    @just --list

# 安装前端依赖
deps:
    pnpm install

# 启动开发模式（Vite + Tauri，热重载）
dev:
    pnpm tauri dev

# 脚本运行时回归测试（全量编译检查 + 功能用例）
test:
    node scripts-compile-check.ts
    node scripts-test.ts

# 构建 Release 版 .app + .dmg（当前架构）
build:
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm tauri build
    echo "→ 构建产物："
    find "{{bundle}}" \( -name '*.app' -o -name '*.dmg' \) -maxdepth 2 -print0 \
        | while IFS= read -r -d '' p; do
            printf '   %s (%s)\n' "$p" "$(du -sh "$p" | cut -f1)"
        done

# 构建并安装到 /Applications（覆盖已有版本）
# 只打 .app（不打 .dmg）：本地安装用不到 dmg，而 dmg 步骤会反复挂载临时卷，
# 偶尔残留导致 bundle_dmg.sh 失败、连带整个安装中断。要 .dmg 用 `just build`。
install:
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm tauri build --bundles app
    target="/Applications/{{app_name}}.app"
    rm -rf "${target}"
    cp -R "{{built_app}}" "${target}"
    xattr -dr com.apple.quarantine "${target}" 2>/dev/null || true
    # Make the installed copy the authoritative Launch Services registration so
    # Finder's "Open With" shows NeoBoop. Each `tauri build` registers stale
    # copies (the target/ bundle + a temporary DMG mount) under the same bundle
    # id; unregister those and the leftover app bundle so they can't shadow the
    # real one with a doctype-less claim.
    lsr=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
    "${lsr}" -u "{{built_app}}" 2>/dev/null || true
    rm -rf "{{built_app}}"
    "${lsr}" -f "${target}"
    echo "→ 已安装到 ${target}（已登记到 Launch Services）"

# 构建 universal（arm64 + x86_64）.app + .dmg
universal:
    #!/usr/bin/env bash
    set -euo pipefail
    rustup target add x86_64-apple-darwin aarch64-apple-darwin
    pnpm tauri build --target universal-apple-darwin
    app="{{target_dir}}/universal-apple-darwin/release/bundle/macos/{{app_name}}.app"
    echo "→ universal 构建完成：${app}"
    lipo -archs "${app}/Contents/MacOS/{{app_name}}"

# 清理构建产物（保留依赖缓存）
clean:
    rm -rf "{{bundle}}"

# 彻底清理（含 cargo target，下次构建会很慢）
clean-all:
    rm -rf "{{target_dir}}" dist
