# Boop — 打包与分发
#
#   just build     构建 Release 版 .app 并打成 tar.gz（输出到 dist/）
#   just install   构建并安装到 /Applications
#
# 不需要 Apple 开发者账号：Release 配置使用 ad-hoc 签名（CODE_SIGN_IDENTITY="-"）。

set shell := ["bash", "-uc"]

project_dir := "Boop"
scheme      := "Boop"
config      := "Release"
app_name    := "Boop"
derived     := justfile_directory() / "DerivedData"
dist        := justfile_directory() / "dist"
built_app   := derived / "Build/Products" / config / app_name + ".app"

# 列出可用命令
default:
    @just --list

# 构建 Release 版 .app（ad-hoc 签名，universal binary）
[private]
_compile:
    cd {{project_dir}} && xcodebuild \
        -scheme '{{scheme}}' \
        -configuration {{config}} \
        -derivedDataPath '{{derived}}' \
        CODE_SIGN_IDENTITY="-" \
        CODE_SIGNING_REQUIRED=NO \
        CODE_SIGNING_ALLOWED=NO \
        build

# 构建并打包成 dist/Boop-<version>-universal.tar.gz
build: _compile
    #!/usr/bin/env bash
    set -euo pipefail
    version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "{{built_app}}/Contents/Info.plist")
    archs=$(lipo -archs "{{built_app}}/Contents/MacOS/{{app_name}}" | tr ' ' '-')
    tarball="{{dist}}/{{app_name}}-${version}-${archs}.tar.gz"
    rm -rf "{{dist}}"
    mkdir -p "{{dist}}"
    cp -R "{{built_app}}" "{{dist}}/"
    tar -C "{{dist}}" -czf "${tarball}" "{{app_name}}.app"
    rm -rf "{{dist}}/{{app_name}}.app"
    echo "→ ${tarball} ($(du -h "${tarball}" | cut -f1))"

# 构建并安装到 /Applications（覆盖已有版本）
install: _compile
    #!/usr/bin/env bash
    set -euo pipefail
    target="/Applications/{{app_name}}.app"
    rm -rf "${target}"
    cp -R "{{built_app}}" "${target}"
    xattr -dr com.apple.quarantine "${target}" 2>/dev/null || true
    echo "→ 已安装到 ${target}"

# 清理构建产物
clean:
    rm -rf "{{derived}}" "{{dist}}"
