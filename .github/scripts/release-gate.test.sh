#!/usr/bin/env bash
# Tests for release-gate.sh. Run: bash .github/scripts/release-gate.test.sh
set -u

gate="$(dirname "$0")/release-gate.sh"
failures=0

expect() {
    local want=$1 message=$2 got
    got=$(bash "$gate" "$message")
    if [ "$got" != "$want" ]; then
        echo "FAIL: '${message%%$'\n'*}' -> got '$got', want '$want'"
        failures=$((failures + 1))
    fi
}

# Releasable: feat / fix / perf (any non-site scope), breaking changes, version bumps.
expect true "feat: add tunnels"
expect true "fix(sftp): handle empty dirs"
expect true "perf: faster grid layout"
expect true "feat(desktop): new tab bar"
expect true "refactor!: drop legacy profile format"
expect true "Release v1.2.3"
expect true "release v1.20.0: theme"
expect true "FEAT: shouting still counts"
expect true $'feat: header only is checked\n\nchore(site): body lines are ignored'

# Website-scoped commits never cut a desktop release.
expect false "feat(site): landing page"
expect false "fix(site)!: broken base path"
expect false "perf(site): smaller hero image"

# Non-releasable types, merges, and empty messages (pull_request events).
expect false "chore: bump deps"
expect false "docs: README"
expect false "ci: split pipelines"
expect false "refactor: move desktop app to apps/desktop"
expect false "Merge pull request #12 from that-one-tool/feature"
expect false ""

if [ "$failures" -gt 0 ]; then
    echo "$failures release-gate test(s) failed"
    exit 1
fi
echo "release-gate: all tests passed"
