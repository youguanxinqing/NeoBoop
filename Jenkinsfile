// NeoBoop — CI / 自动打包发布流水线
//
// 平时（push / 手动触发，PUBLISH_RELEASE 不勾选）：
//     校验版本一致 → 装依赖 → 跑脚本回归 → 构建 universal .dmg → 归档产物
//
// 发布（手动触发，勾选 PUBLISH_RELEASE）：
//     在以上基础上追加一步——打 tag v<version> + 建 GitHub Release 并上传 .dmg。
//     默认建成 draft（草稿），人工在 GitHub 上过目后再点 Publish。
//
// 发版步骤（在本地做，流水线只负责打包+发布）：
//     1. 把 package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml
//        三处 version 改成新版本号并提交、推到 origin。
//     2. 在 Jenkins 上对该 commit 触发本流水线，勾选 PUBLISH_RELEASE。
//
// 构建机（agent label "macos"）需预装：
//     Xcode Command Line Tools、rustup（含 aarch64/x86_64-apple-darwin 两个 target）、
//     Node ≥ 22（脚本回归用 `node *.ts` 类型剥离）、pnpm（corepack enable 即可）、
//     just、gh（GitHub CLI）。
//
// Jenkins 凭据：
//     github-token —— Secret text 类型，存一个有 repo 权限的 GitHub token，
//                      供 gh 创建 tag / release 使用。

pipeline {
    agent { label 'macos' }

    parameters {
        booleanParam(
            name: 'PUBLISH_RELEASE',
            defaultValue: false,
            description: '勾选后：构建成功则打 tag v<version> 并创建 GitHub Release（默认草稿）。版本号取自 package.json。'
        )
        booleanParam(
            name: 'DRAFT',
            defaultValue: true,
            description: '以草稿形式创建 Release（人工过目后再发布）。仅在 PUBLISH_RELEASE 勾选时生效。'
        )
        booleanParam(
            name: 'PRERELEASE',
            defaultValue: false,
            description: '标记为预发布（pre-release）。仅在 PUBLISH_RELEASE 勾选时生效。'
        )
    }

    options {
        timestamps()
        disableConcurrentBuilds()
        timeout(time: 60, unit: 'MINUTES')
    }

    environment {
        // corepack 装的 pnpm、rustup/cargo、homebrew 的 just/gh 常在这些路径
        PATH = "/opt/homebrew/bin:/usr/local/bin:${env.HOME}/.cargo/bin:${env.PATH}"
        APP_NAME = 'NeoBoop'
    }

    stages {
        stage('校验版本一致') {
            steps {
                script {
                    def pkgVersion   = sh(returnStdout: true, script: '''node -e "process.stdout.write(require('./package.json').version)"''').trim()
                    def confVersion  = sh(returnStdout: true, script: '''node -e "process.stdout.write(require('./src-tauri/tauri.conf.json').version)"''').trim()
                    def cargoVersion = sh(returnStdout: true, script: '''awk -F'"' '/^version[[:space:]]*=/{print $2; exit}' src-tauri/Cargo.toml''').trim()

                    echo "package.json=${pkgVersion}  tauri.conf.json=${confVersion}  Cargo.toml=${cargoVersion}"
                    if (pkgVersion != confVersion || pkgVersion != cargoVersion) {
                        error("版本号不一致，发布前请先对齐三处文件：package.json / tauri.conf.json / Cargo.toml")
                    }
                    env.APP_VERSION = pkgVersion
                    env.RELEASE_TAG = "v${pkgVersion}"
                    currentBuild.displayName = "#${env.BUILD_NUMBER} · v${pkgVersion}${params.PUBLISH_RELEASE ? ' · release' : ''}"
                }
            }
        }

        stage('发布前检查 tag 占用') {
            when { expression { return params.PUBLISH_RELEASE } }
            steps {
                withCredentials([string(credentialsId: 'github-token', variable: 'GH_TOKEN')]) {
                    sh '''
                        set -euo pipefail
                        # 远端已存在同名 tag 或 release 时立即退出，绝不覆盖已发布版本。
                        if git ls-remote --tags origin "refs/tags/${RELEASE_TAG}" | grep -q "${RELEASE_TAG}"; then
                            echo "✗ 远端已存在 tag ${RELEASE_TAG}，请先 bump 版本号再发布。" >&2
                            exit 1
                        fi
                        if gh release view "${RELEASE_TAG}" >/dev/null 2>&1; then
                            echo "✗ 已存在 Release ${RELEASE_TAG}，拒绝覆盖。" >&2
                            exit 1
                        fi
                        echo "✓ ${RELEASE_TAG} 可用"
                    '''
                }
            }
        }

        stage('安装依赖') {
            steps {
                sh '''
                    set -euo pipefail
                    corepack enable >/dev/null 2>&1 || true
                    pnpm install --frozen-lockfile
                '''
            }
        }

        stage('脚本回归测试') {
            steps {
                sh '''
                    set -euo pipefail
                    just test
                '''
            }
        }

        stage('构建 universal .dmg') {
            steps {
                sh '''
                    set -euo pipefail
                    rustup target add x86_64-apple-darwin aarch64-apple-darwin
                    pnpm tauri build --target universal-apple-darwin
                '''
                script {
                    def bundle = 'src-tauri/target/universal-apple-darwin/release/bundle'
                    def dmg = sh(returnStdout: true, script: "ls ${bundle}/dmg/*.dmg | head -1").trim()
                    if (!dmg) {
                        error("没找到构建出的 .dmg，构建可能失败。")
                    }
                    env.DMG_PATH = dmg
                    echo "→ 产物：${dmg}"
                }
            }
        }

        stage('归档产物') {
            steps {
                archiveArtifacts(
                    artifacts: 'src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg',
                    fingerprint: true,
                    onlyIfSuccessful: true
                )
            }
        }

        stage('发布 GitHub Release') {
            when { expression { return params.PUBLISH_RELEASE } }
            steps {
                withCredentials([string(credentialsId: 'github-token', variable: 'GH_TOKEN')]) {
                    sh '''
                        set -euo pipefail

                        DRAFT_FLAG=""
                        [ "${DRAFT}" = "true" ] && DRAFT_FLAG="--draft"
                        PRE_FLAG=""
                        [ "${PRERELEASE}" = "true" ] && PRE_FLAG="--prerelease"

                        # --target ${GIT_COMMIT}：让 gh 在该 commit 上创建 tag（远端），
                        # 无需 agent 配置 SSH 推送权限。
                        gh release create "${RELEASE_TAG}" "${DMG_PATH}" \
                            --target "${GIT_COMMIT}" \
                            --title "${APP_NAME} ${RELEASE_TAG}" \
                            --generate-notes \
                            ${DRAFT_FLAG} ${PRE_FLAG}

                        echo "✓ 已创建 Release ${RELEASE_TAG}"
                        gh release view "${RELEASE_TAG}" --json url,isDraft,assets \
                            --jq '"url=\\(.url)  draft=\\(.isDraft)  assets=\\([.assets[].name] | join(\",\"))"'
                    '''
                }
            }
        }
    }

    post {
        success {
            echo "✓ 流水线成功 · v${env.APP_VERSION}${params.PUBLISH_RELEASE ? ' · 已创建 Release（默认草稿，去 GitHub 确认后发布）' : ''}"
        }
        failure {
            echo "✗ 流水线失败 · 见上方日志"
        }
    }
}
